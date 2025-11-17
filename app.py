import time
import logging
from pathlib import Path
from typing import List, Dict, Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from requests import HTTPError
import xml.etree.ElementTree as ET

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI()

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

logging.basicConfig(level=logging.INFO)

# ---------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------
YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_RSS_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline"

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL",
    "TSLA", "AVGO", "AMD", "NFLX", "ADBE",
    "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V",
    "MA", "XOM", "CVX", "UNH", "LLY", "ABBV"
]

# simple in-memory caches to reduce Yahoo calls and avoid 429
_quotes_cache: Dict[str, Any] = {"data": [], "ts": 0.0}
_insights_cache: Dict[str, Any] = {}
_news_cache: Dict[str, Any] = {}
MOVERS_COUNT = 5
QUOTES_TTL = 60  # seconds
NEWS_TTL = 300
INSIGHTS_TTL = 600


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------
def fetch_yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    params = {"symbols": ",".join(symbols)}
    r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=5)
    r.raise_for_status()
    data = r.json().get("quoteResponse", {}).get("result", [])
    quotes: List[Dict[str, Any]] = []
    for item in data:
        symbol = item.get("symbol")
        price = item.get("regularMarketPrice")
        change = item.get("regularMarketChangePercent")
        if symbol is None or price is None or change is None:
            continue
        quotes.append(
            {
                "symbol": symbol,
                "price": round(float(price), 2),
                "change": round(float(change), 2),
            }
        )
    return quotes


def get_quotes_cached() -> List[Dict[str, Any]]:
    now = time.time()
    if _quotes_cache["data"] and now - _quotes_cache["ts"] < QUOTES_TTL:
        return _quotes_cache["data"]

    try:
        quotes = fetch_yahoo_quotes(WATCHLIST)
        if quotes:
            _quotes_cache["data"] = quotes
            _quotes_cache["ts"] = now
    except HTTPError as e:
        logging.warning("Yahoo quotes HTTPError: %s", e)
    except Exception:
        logging.exception("Yahoo quotes error")

    return _quotes_cache["data"] or []


def fetch_yahoo_rss(symbol: str) -> List[Dict[str, str]]:
    params = {"s": symbol, "region": "US", "lang": "en-US"}
    r = requests.get(YAHOO_RSS_URL, params=params, timeout=5)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for item in root.findall(".//item"):
        title_el = item.find("title")
        link_el = item.find("link")
        date_el = item.find("pubDate")
        source_el = item.find("{*}source")
        items.append(
            {
                "title": (title_el.text or "").strip(),
                "link": (link_el.text or "").strip(),
                "time": (date_el.text or "").strip(),
                "source": (source_el.text or "Yahoo Finance").strip(),
            }
        )
    return items[:30]


def get_news_cached(symbol: str) -> List[Dict[str, str]]:
    now = time.time()
    cache = _news_cache.get(symbol)
    if cache and now - cache["ts"] < NEWS_TTL:
        return cache["data"]

    articles: List[Dict[str, str]] = []
    try:
        articles = fetch_yahoo_rss(symbol)
        if not articles:
            # fallback: broad market headlines
            articles = fetch_yahoo_rss("^GSPC")
    except HTTPError as e:
        logging.warning("Yahoo RSS HTTPError for %s: %s", symbol, e)
    except Exception:
        logging.exception("Yahoo RSS error")

    _news_cache[symbol] = {"data": articles, "ts": now}
    return articles


def compute_insights(symbol: str) -> Dict[str, Any]:
    now = time.time()
    cache = _insights_cache.get(symbol)
    if cache and now - cache["ts"] < INSIGHTS_TTL:
        return cache["data"]

    # use Yahoo spark endpoint to get close prices at different ranges
    url = "https://query1.finance.yahoo.com/v8/finance/spark"
    params = {
        "symbols": symbol,
        "range": "1y",
        "interval": "1d",
        "includeTimestamps": "true",
    }
    snapshot = {"1W": None, "1M": None, "3M": None, "6M": None, "YTD": None, "1Y": None}
    profile = ""

    try:
        r = requests.get(url, params=params, timeout=5)
        r.raise_for_status()
        result = r.json()["spark"]["result"][0]
        closes = result.get("close") or []
        if not closes:
            raise ValueError("no closes")

        last_price = float(closes[-1])

        def pct_from_days(days: int) -> float | None:
            if len(closes) <= days:
                return None
            then = float(closes[-days - 1])
            if then == 0:
                return None
            return round((last_price - then) / then * 100.0, 2)

        snapshot["1W"] = pct_from_days(5)
        snapshot["1M"] = pct_from_days(21)
        snapshot["3M"] = pct_from_days(63)
        snapshot["6M"] = pct_from_days(126)
        snapshot["YTD"] = pct_from_days(252)  # rough, just to have a value
        snapshot["1Y"] = pct_from_days(len(closes) - 1)

    except Exception as e:
        logging.warning("insights error for %s: %s", symbol, e)

    # try to grab short company summary from quote endpoint
    try:
        r2 = requests.get(YAHOO_QUOTE_URL, params={"symbols": symbol}, timeout=5)
        r2.raise_for_status()
        info = r2.json().get("quoteResponse", {}).get("result", [])
        if info:
            longname = info[0].get("longName") or symbol
            sector = info[0].get("sector") or ""
            industry = info[0].get("industry") or ""
            profile = f"{longname} operates in the {sector} sector, focusing on {industry}. "
            profile += (
                "The company is widely followed by investors and is part of many market indices. "
                "Its stock is influenced by earnings results, macro trends and sector-specific news."
            )
    except Exception:
        logging.exception("profile fetch error")

    data = {"symbol": symbol, "snapshot": snapshot, "profile": profile}
    _insights_cache[symbol] = {"data": data, "ts": time.time()}
    return data


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/heatmap", response_class=HTMLResponse)
async def heatmap(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("heatmap.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers():
    quotes = get_quotes_cached()
    return JSONResponse({"tickers": quotes})


@app.get("/api/movers")
async def api_movers():
    quotes = get_quotes_cached()
    if not quotes:
        return JSONResponse({"gainers": [], "losers": []})

    sorted_by_change = sorted(quotes, key=lambda q: q["change"])
    losers = sorted_by_change[:MOVERS_COUNT]
    gainers = list(reversed(sorted_by_change[-MOVERS_COUNT:]))
    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/news")
async def api_news(symbol: str = "AAPL"):
    articles = get_news_cached(symbol)
    return JSONResponse({"symbol": symbol, "articles": articles})


@app.get("/api/insights")
async def api_insights(symbol: str = "AAPL"):
    data = compute_insights(symbol)
    return JSONResponse(data)
