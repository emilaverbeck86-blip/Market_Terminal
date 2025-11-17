import time
import math
from datetime import datetime, timedelta
from typing import List, Dict, Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# -------------------------------------------------------------------
# Config
# -------------------------------------------------------------------

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_NEWS_RSS = "https://feeds.finance.yahoo.com/rss/2.0/headline"

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V", "MA",
    "XOM", "CVX", "UNH", "LLY", "ABBV"
]

FALLBACK_QUOTES = [
    {"symbol": "AAPL", "price": 192.32, "change_pct": 0.85},
    {"symbol": "MSFT", "price": 417.56, "change_pct": 0.42},
    {"symbol": "NVDA", "price": 123.12, "change_pct": -1.18},
    {"symbol": "META", "price": 480.76, "change_pct": 0.25},
    {"symbol": "GOOGL", "price": 156.18, "change_pct": -0.12},
    {"symbol": "TSLA", "price": 182.44, "change_pct": -2.34},
    {"symbol": "AVGO", "price": 1588.42, "change_pct": 1.66},
    {"symbol": "AMD", "price": 178.11, "change_pct": 1.02},
    {"symbol": "JPM", "price": 201.87, "change_pct": 0.54},
    {"symbol": "XOM", "price": 118.22, "change_pct": -0.33},
]

FALLBACK_NEWS = [
    {
        "title": "{symbol} draws active trader interest amid heavy volume",
        "url": "https://finance.yahoo.com/quote/{symbol}",
        "source": "Terminal Briefing",
    },
    {
        "title": "Analysts break down the latest setup in {symbol}",
        "url": "https://finance.yahoo.com/quote/{symbol}/analysis",
        "source": "Analyst Desk",
    },
    {
        "title": "Institutional flows show fresh momentum building in {symbol}",
        "url": "https://finance.yahoo.com/quote/{symbol}/holder",
        "source": "Market Terminal",
    },
]

# simple in-memory caches to avoid 429s
_ticker_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_movers_cache: Dict[str, Any] = {"data": None, "ts": 0.0}


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------

def yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """Fetch quotes from Yahoo Finance."""
    params = {"symbols": ",".join(symbols)}
    r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=6)
    r.raise_for_status()
    data = r.json().get("quoteResponse", {}).get("result", [])
    quotes: List[Dict[str, Any]] = []
    for q in data:
        symbol = q.get("symbol")
        price = q.get("regularMarketPrice")
        change = q.get("regularMarketChangePercent")
        if symbol is None or price is None or change is None:
            continue
        quotes.append(
            {
                "symbol": symbol,
                "price": round(float(price), 2),
                "change_pct": round(float(change), 2),
            }
        )
    return quotes


def yahoo_news(symbol: str, max_items: int = 15) -> List[Dict[str, Any]]:
    """Return news headlines for symbol from Yahoo Finance RSS."""
    params = {"s": symbol, "region": "US", "lang": "en-US"}
    try:
        r = requests.get(YAHOO_NEWS_RSS, params=params, timeout=6)
        r.raise_for_status()
    except Exception:
        return []

    import xml.etree.ElementTree as ET

    items: List[Dict[str, Any]] = []
    try:
        root = ET.fromstring(r.content)
        for item in root.findall(".//item")[:max_items]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            source = (item.findtext("source") or "").strip()
            if not title or not link:
                continue
            items.append(
                {
                    "title": title,
                    "url": link,
                    "source": source or "Yahoo Finance",
                    "published_at": pub,
                }
            )
    except Exception:
        return []
    return items


def fallback_news(symbol: str) -> List[Dict[str, Any]]:
    """Return canned news items when live data is unavailable."""
    sym = symbol.upper()
    items: List[Dict[str, Any]] = []
    for template in FALLBACK_NEWS:
        items.append(
            {
                "title": template["title"].format(symbol=sym),
                "url": template["url"].format(symbol=sym),
                "source": template["source"],
                "published_at": datetime.utcnow().strftime("%b %d, %Y"),
            }
        )
    return items


def simple_insights(symbol: str) -> Dict[str, Any]:
    """
    Very lightweight performance snapshot:
    uses 1 year daily chart endpoint and computes %
    changes for a few horizons.
    """
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    params = {"range": "1y", "interval": "1d"}
    try:
        r = requests.get(url, params=params, timeout=8)
        r.raise_for_status()
        data = r.json()
        result = data["chart"]["result"][0]
        closes = result["indicators"]["quote"][0]["close"]
        timestamps = result["timestamp"]
    except Exception:
        return {
            "symbol": symbol.upper(),
            "periods": {},
            "profile": "No performance snapshot available at this time."
        }

    prices = [p for p in closes if p is not None]
    if len(prices) < 5:
        return {
            "symbol": symbol.upper(),
            "periods": {},
            "profile": "No performance snapshot available at this time."
        }

    latest = float(prices[-1])

    def pct_change(days: int) -> float:
        try:
            # find index roughly N trading days ago
            idx = max(0, len(prices) - 1 - days)
            base = float(prices[idx])
            if base <= 0:
                return 0.0
            return round((latest - base) / base * 100, 2)
        except Exception:
            return 0.0

    periods = {
        "1W": pct_change(5),
        "1M": pct_change(21),
        "3M": pct_change(63),
        "6M": pct_change(126),
        "YTD": pct_change(252),
        "1Y": pct_change(252),
    }

    profile = (
        f"{symbol.upper()} is a major public company followed closely by global investors. "
        "This snapshot combines recent price performance and a short descriptive profile "
        "to give you a quick fundamental impression inside the terminal."
    )

    return {
        "symbol": symbol.upper(),
        "periods": periods,
        "profile": profile,
    }


def dummy_calendar() -> List[Dict[str, str]]:
    """Static macro calendar stub – replace with real API if you like."""
    return [
        {
            "time": "08:30",
            "country": "US",
            "event": "Nonfarm Payrolls",
            "actual": "210K",
            "forecast": "185K",
            "previous": "165K",
        },
        {
            "time": "10:00",
            "country": "US",
            "event": "ISM Services PMI",
            "actual": "52.4",
            "forecast": "51.8",
            "previous": "50.9",
        },
        {
            "time": "14:00",
            "country": "EU",
            "event": "ECB Rate Decision",
            "actual": "4.00%",
            "forecast": "4.00%",
            "previous": "4.00%",
        },
    ]


# -------------------------------------------------------------------
# Pages
# -------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/heatmap", response_class=HTMLResponse)
async def heatmap_page(request: Request):
    return templates.TemplateResponse("heatmap.html", {"request": request})


# -------------------------------------------------------------------
# APIs
# -------------------------------------------------------------------

@app.get("/api/tickers")
async def api_tickers():
    global _ticker_cache
    now = time.time()
    if _ticker_cache["data"] and now - _ticker_cache["ts"] < 60:
        return _ticker_cache["data"]

    try:
        quotes = yahoo_quotes(WATCHLIST)
        if not quotes:
            raise RuntimeError("No quotes returned")
    except Exception:
        quotes = FALLBACK_QUOTES

    payload = {"tickers": quotes}
    _ticker_cache = {"data": payload, "ts": now}
    return payload


@app.get("/api/news")
async def api_news(symbol: str):
    items = yahoo_news(symbol.upper())
    if not items:
        items = fallback_news(symbol)
    return {"symbol": symbol.upper(), "items": items}


@app.get("/api/insights")
async def api_insights(symbol: str):
    data = simple_insights(symbol.upper())
    return data


@app.get("/api/calendar")
async def api_calendar():
    return {"events": dummy_calendar()}


@app.get("/api/movers")
async def api_movers():
    """
    Top gainers / losers from WATCHLIST based on latest % change.
    """
    global _movers_cache
    now = time.time()
    if _movers_cache["data"] and now - _movers_cache["ts"] < 60:
        return _movers_cache["data"]

    try:
        quotes = yahoo_quotes(WATCHLIST)
        if not quotes:
            raise RuntimeError("No mover data")
    except Exception:
        quotes = FALLBACK_QUOTES

    sorted_quotes = sorted(quotes, key=lambda q: q["change_pct"])
    losers = sorted_quotes[:5]
    gainers = list(reversed(sorted_quotes[-5:]))
    payload = {"gainers": gainers, "losers": losers}
    _movers_cache = {"data": payload, "ts": now}
    return payload


# Simple macro data for world map – static demo values
MACRO_DATA = {
    "inflation": {
        "US": 3.2,
        "CA": 3.1,
        "BR": 4.7,
        "DE": 2.3,
        "UK": 3.9,
        "FR": 2.6,
        "ZA": 5.8,
        "IN": 4.5,
        "CN": 1.2,
        "JP": 2.1,
        "AU": 3.4,
    },
    "rates": {
        "US": 5.5,
        "CA": 5.0,
        "BR": 12.8,
        "DE": 4.0,
        "UK": 5.25,
        "ZA": 8.25,
        "IN": 6.5,
        "CN": 3.45,
        "JP": 0.1,
        "AU": 4.1,
    },
    "gdp": {
        "US": 2.1,
        "CA": 1.5,
        "BR": 2.3,
        "DE": 0.8,
        "UK": 1.0,
        "IN": 6.4,
        "CN": 4.9,
        "JP": 1.3,
        "AU": 2.0,
        "ZA": 1.1,
    },
    "unemployment": {
        "US": 3.8,
        "CA": 5.5,
        "BR": 7.7,
        "DE": 3.0,
        "UK": 4.3,
        "IN": 7.2,
        "CN": 5.2,
        "JP": 2.7,
        "AU": 3.6,
        "ZA": 32.0,
    },
}


@app.get("/api/macro")
async def api_macro(metric: str = "inflation"):
    metric = metric.lower()
    if metric not in MACRO_DATA:
        metric = "inflation"
    data = [
        {"code": code, "value": value}
        for code, value in MACRO_DATA[metric].items()
    ]
    return {"metric": metric, "data": data}
