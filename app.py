import os
import time
from datetime import datetime, timezone, timedelta, date
from typing import List, Dict, Any
import xml.etree.ElementTree as ET

import requests
import yfinance as yf
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

# Static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ---------------------------------------------------------------------------
# Constants / Config
# ---------------------------------------------------------------------------

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY")

WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V", "MA",
    "XOM", "CVX", "UNH", "LLY", "ABBV",
]

FALLBACK_QUOTES: List[Dict[str, Any]] = [
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

FALLBACK_NEWS: List[Dict[str, str]] = [
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

_ticker_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_movers_cache: Dict[str, Any] = {"data": None, "ts": 0.0}

# ---------------------------------------------------------------------------
# Helpers – Quotes & Movers
# ---------------------------------------------------------------------------


def yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    params = {"symbols": ",".join(symbols)}
    r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=8, headers=YAHOO_HEADERS)
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
                "symbol": str(symbol),
                "price": round(float(price), 2),
                "change_pct": round(float(change), 2),
            }
        )
    return quotes


def get_watchlist_quotes() -> List[Dict[str, Any]]:
    now = time.time()
    if _ticker_cache["data"] is not None and now - _ticker_cache["ts"] < 20:
        return _ticker_cache["data"]

    try:
        quotes = yahoo_quotes(WATCHLIST)
        if not quotes:
            raise RuntimeError("no quotes returned")
        _ticker_cache["data"] = quotes
        _ticker_cache["ts"] = now
        return quotes
    except Exception as exc:
        print(f"[get_watchlist_quotes] error: {exc}")
        if _ticker_cache["data"] is not None:
            return _ticker_cache["data"]
        return FALLBACK_QUOTES


def compute_movers(quotes: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    data = [q for q in quotes if isinstance(q.get("change_pct"), (int, float))]
    sorted_data = sorted(data, key=lambda x: x["change_pct"], reverse=True)
    gainers = sorted_data[:5]
    losers = sorted(sorted_data[-5:], key=lambda x: x["change_pct"])
    return {"gainers": gainers, "losers": losers}


# ---------------------------------------------------------------------------
# Helpers – News
# ---------------------------------------------------------------------------


def finnhub_news(symbol: str, max_items: int = 20) -> List[Dict[str, Any]]:
    """News über Finnhub (wenn FINNHUB_API_KEY gesetzt ist)."""
    if not FINNHUB_API_KEY:
        return []

    today = date.today()
    frm = (today - timedelta(days=14)).isoformat()
    to = today.isoformat()

    params = {
        "symbol": symbol.upper(),
        "from": frm,
        "to": to,
        "token": FINNHUB_API_KEY,
    }
    try:
        r = requests.get("https://finnhub.io/api/v1/company-news", params=params, timeout=8)
        r.raise_for_status()
        raw = r.json()
    except Exception as exc:
        print(f"[finnhub_news] request error for {symbol}: {exc}")
        return []

    items: List[Dict[str, Any]] = []
    for entry in raw[:max_items]:
        headline = (entry.get("headline") or "").strip()
        url = (entry.get("url") or "").strip()
        if not headline or not url:
            continue
        dt_str = ""
        ts = entry.get("datetime")
        if ts:
            try:
                dt_ = datetime.fromtimestamp(int(ts), tz=timezone.utc)
                dt_str = dt_.strftime("%b %d, %Y %H:%M UTC")
            except Exception:
                dt_str = ""
        items.append(
            {
                "title": headline,
                "url": url,
                "source": (entry.get("source") or "Finnhub").strip(),
                "published_at": dt_str,
            }
        )
    return items


def fallback_news(symbol: str) -> List[Dict[str, Any]]:
    sym = symbol.upper()
    return [
        {
            "title": tpl["title"].format(symbol=sym),
            "url": tpl["url"].format(symbol=sym),
            "source": tpl["source"],
            "published_at": datetime.utcnow().strftime("%b %d, %Y"),
        }
        for tpl in FALLBACK_NEWS
    ]


# ---------------------------------------------------------------------------
# Helpers – Insights & Calendar
# ---------------------------------------------------------------------------


def fallback_insights(symbol: str) -> Dict[str, Any]:
    periods = {k: 0.0 for k in ["1W", "1M", "3M", "6M", "YTD", "1Y"]}
    profile = (
        f"{symbol.upper()} is a major public company followed closely by global investors. "
        "This snapshot combines recent price performance and a short descriptive profile "
        "to give you a quick fundamental impression inside the terminal."
    )
    return {"symbol": symbol.upper(), "periods": periods, "profile": profile}


def yahoo_insights(symbol: str) -> Dict[str, Any]:
    url = YAHOO_CHART_URL.format(symbol=symbol)
    params = {"range": "1y", "interval": "1d"}
    try:
        r = requests.get(url, params=params, timeout=8, headers=YAHOO_HEADERS)
        r.raise_for_status()
        data = r.json()
        result = data["chart"]["result"][0]
        closes = result["indicators"]["quote"][0]["close"]
    except Exception as exc:
        print(f"[yahoo_insights] error for {symbol}: {exc}")
        return fallback_insights(symbol)

    prices = [p for p in closes if p is not None]
    if len(prices) < 10:
        return fallback_insights(symbol)

    latest = float(prices[-1])

    def pct_change(days: int) -> float:
        try:
            idx = max(0, len(prices) - 1 - days)
            base = float(prices[idx])
            if base <= 0:
                return 0.0
            return round((latest - base) / base * 100.0, 2)
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

    return {"symbol": symbol.upper(), "periods": periods, "profile": profile}


def dummy_calendar() -> List[Dict[str, str]]:
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


# ---------------------------------------------------------------------------
# Routes – Pages
# ---------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/heatmap", response_class=HTMLResponse)
async def heatmap_page(request: Request):
    return templates.TemplateResponse("heatmap.html", {"request": request})


# ---------------------------------------------------------------------------
# Routes – Data APIs
# ---------------------------------------------------------------------------


@app.get("/api/tickers")
async def api_tickers():
    quotes = get_watchlist_quotes()
    return {"tickers": quotes}


@app.get("/api/movers")
async def api_movers():
    now = time.time()
    if _movers_cache["data"] is not None and now - _movers_cache["ts"] < 20:
        return _movers_cache["data"]

    quotes = get_watchlist_quotes()
    data = compute_movers(quotes)
    _movers_cache["data"] = data
    _movers_cache["ts"] = now
    return data


@app.get("/api/news")
async def api_news(symbol: str):
    sym = symbol.upper()
    items: List[Dict[str, Any]] = []

    # 1) Finnhub (wenn API-Key vorhanden)
    try:
        items = finnhub_news(sym)
    except Exception as exc:
        print(f"[api_news] finnhub_news crashed for {sym}: {exc}")
        items = []

    # 2) Fallback – keine weiteren Yahoo-News-Calls (verhindert 401/429-Spam)
    if not items:
        items = fallback_news(sym)

    return {"symbol": sym, "items": items}


@app.get("/api/insights")
async def api_insights(symbol: str):
    sym = symbol.upper()
    try:
        data = yahoo_insights(sym)
    except Exception as exc:
        print(f"[api_insights] crashed for {sym}: {exc}")
        data = fallback_insights(sym)
    return data


@app.get("/api/calendar")
async def api_calendar():
    return {"events": dummy_calendar()}


# ---------------------------------------------------------------------------
# Macro Data – for Macro Maps
# ---------------------------------------------------------------------------

MACRO_DATA: Dict[str, Dict[str, float]] = {
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
    data = [{"code": code, "value": value} for code, value in MACRO_DATA[metric].items()]
    return {"metric": metric, "data": data}
