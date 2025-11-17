import os
import time
import datetime as dt
from typing import List, Dict, Any
import xml.etree.ElementTree as ET

import requests
from requests.exceptions import HTTPError
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

# Static & templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --------------------------------------------------------------------
# Config
# --------------------------------------------------------------------

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL",
    "TSLA", "AVGO", "AMD", "NFLX", "ADBE",
    "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V",
    "MA", "XOM", "CVX", "UNH", "LLY", "ABBV",
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"

# TradingEconomics key for econ calendar (optional)
TE_KEY = os.getenv("TRADINGECONOMICS_KEY") or os.getenv("TRADING_ECONOMICS_KEY")

# Fallback quotes if Yahoo is dead AND we have no cache
STATIC_FALLBACK_QUOTES: List[Dict[str, Any]] = [
    {"symbol": "AAPL", "shortName": "Apple Inc.", "price": 270.0, "change": -1.2, "changePercent": -0.44},
    {"symbol": "MSFT", "shortName": "Microsoft", "price": 410.0, "change": 2.1, "changePercent": 0.52},
    {"symbol": "NVDA", "shortName": "NVIDIA", "price": 190.0, "change": 1.0, "changePercent": 0.53},
]

# Simple in-memory cache for quotes
_quote_cache: Dict[str, Any] = {
    "data": None,
    "timestamp": 0.0,
    "symbols_key": "",
}

# --------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------


def yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Fetch quotes from Yahoo Finance with:
      - 60s cache
      - safe handling of 429 / errors
      - fallback to previous cache or STATIC_FALLBACK_QUOTES
    This function never raises – always returns a list.
    """
    global _quote_cache

    symbols_key = ",".join(symbols)

    # Use cache if still fresh
    if (
        _quote_cache["data"] is not None
        and _quote_cache["symbols_key"] == symbols_key
        and time.time() - _quote_cache["timestamp"] < 60
    ):
        return _quote_cache["data"]

    params = {"symbols": symbols_key}
    try:
        r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=6)
        if r.status_code == 200:
            data = r.json().get("quoteResponse", {}).get("result", [])
            if data:
                _quote_cache = {
                    "data": data,
                    "timestamp": time.time(),
                    "symbols_key": symbols_key,
                }
                return data
        # Any non-200 falls through
    except HTTPError:
        pass
    except Exception:
        pass

    # Fallback to cache or static
    if _quote_cache["data"] is not None:
        return _quote_cache["data"]
    return STATIC_FALLBACK_QUOTES


def simplify_quote(q: Dict[str, Any]) -> Dict[str, Any]:
    price = q.get("regularMarketPrice")
    change = q.get("regularMarketChange")
    change_pct = q.get("regularMarketChangePercent")
    return {
        "symbol": q.get("symbol"),
        "shortName": q.get("shortName") or q.get("symbol"),
        "price": round(price, 2) if isinstance(price, (int, float)) else None,
        "change": round(change, 2) if isinstance(change, (int, float)) else None,
        "changePercent": round(change_pct, 2) if isinstance(change_pct, (int, float)) else None,
    }


def yahoo_chart_percent_changes(symbol: str) -> Dict[str, Any]:
    """
    Lightweight performance snapshot using Yahoo chart API.
    """
    params = {"range": "1y", "interval": "1d"}
    try:
        r = requests.get(f"{YAHOO_CHART_URL}/{symbol}", params=params, timeout=8)
        if r.status_code != 200:
            return {}
        data = r.json().get("chart", {}).get("result", [])
        if not data:
            return {}

        result = data[0]
        closes = result["indicators"]["adjclose"][0]["adjclose"]
        timestamps = result["timestamp"]
        if not closes or len(closes) < 2:
            return {}

        last = closes[-1]

        def pct_ago(days_back: int) -> float | None:
            if len(closes) <= days_back:
                return None
            base = closes[-1 - days_back]
            if not isinstance(base, (int, float)) or base == 0:
                return None
            return round((last - base) / base * 100.0, 2)

        changes = {
            "1W": pct_ago(5),
            "1M": pct_ago(21),
            "3M": pct_ago(63),
            "6M": pct_ago(126),
            "YTD": None,
            "1Y": pct_ago(len(closes) - 1),
        }

        # YTD from first bar of this year
        try:
            year = dt.datetime.utcfromtimestamp(timestamps[-1]).year
            first_idx = next(
                i
                for i, ts in enumerate(timestamps)
                if dt.datetime.utcfromtimestamp(ts).year == year
            )
            base = closes[first_idx]
            if isinstance(base, (int, float)) and base != 0:
                changes["YTD"] = round((last - base) / base * 100.0, 2)
        except Exception:
            pass

        meta = result.get("meta", {})
        long_name = meta.get("longName", symbol)
        exchange = meta.get("exchangeName", "Unknown exchange")

        description = (
            f"{long_name} trades on {exchange}. "
            "The snapshot shows approximate percentage returns based on "
            "adjusted daily closes over multiple time horizons."
        )

        return {"changes": changes, "description": description}
    except Exception:
        return {}


def yahoo_rss_news(symbol: str) -> List[Dict[str, Any]]:
    """
    Fetch finance headlines via Yahoo RSS using only xml.etree.
    Returns list of {title, link, source, published}.
    """
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
    try:
        resp = requests.get(url, timeout=6)
        resp.raise_for_status()
        text = resp.text

        root = ET.fromstring(text)

        # Try to find channel/items in a robust way
        channel = root.find("channel")
        if channel is not None:
            items_xml = channel.findall("item")
        else:
            items_xml = root.findall(".//item")

        items: List[Dict[str, Any]] = []

        for item in items_xml[:30]:
            title_el = item.find("title")
            link_el = item.find("link")
            pub_el = item.find("pubDate")
            source_el = item.find("source")

            title = title_el.text.strip() if title_el is not None and title_el.text else ""
            link = link_el.text.strip() if link_el is not None and link_el.text else ""
            pub = pub_el.text.strip() if pub_el is not None and pub_el.text else ""
            source = (
                source_el.text.strip()
                if source_el is not None and source_el.text
                else "Yahoo Finance"
            )

            if not title and not link:
                continue

            items.append(
                {
                    "title": title,
                    "link": link,
                    "source": source,
                    "published": pub,
                }
            )

        return items
    except Exception:
        return []


def trading_econ_calendar() -> List[Dict[str, Any]]:
    """
    Fetch today's US economic calendar from TradingEconomics.
    If no key or error: returns [] (front-end shows 'No events').
    """
    if not TE_KEY:
        return []

    today = dt.datetime.utcnow().strftime("%Y-%m-%d")
    url = (
        f"https://api.tradingeconomics.com/calendar?"
        f"country=united states&start={today}&end={today}&c={TE_KEY}"
    )
    try:
        r = requests.get(url, timeout=8)
        if r.status_code != 200:
            return []
        raw = r.json()
        events: List[Dict[str, Any]] = []
        for ev in raw:
            events.append(
                {
                    "country": ev.get("Country"),
                    "event": ev.get("Event"),
                    "actual": ev.get("Actual"),
                    "forecast": ev.get("Forecast"),
                    "previous": ev.get("Previous"),
                    "date": ev.get("Date"),
                    "time": ev.get("Time"),
                }
            )
        return events
    except Exception:
        return []


# --------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/tickers", response_class=JSONResponse)
async def api_tickers():
    quotes = yahoo_quotes(WATCHLIST)
    simplified = [simplify_quote(q) for q in quotes]
    return {"tickers": simplified}


@app.get("/api/movers", response_class=JSONResponse)
async def api_movers():
    quotes = [simplify_quote(q) for q in yahoo_quotes(WATCHLIST)]
    valid = [q for q in quotes if isinstance(q.get("changePercent"), (int, float))]
    gainers = sorted(valid, key=lambda x: x["changePercent"], reverse=True)[:5]
    losers = sorted(valid, key=lambda x: x["changePercent"])[:5]
    return {"gainers": gainers, "losers": losers}


@app.get("/api/news", response_class=JSONResponse)
async def api_news(symbol: str):
    items = yahoo_rss_news(symbol.upper())
    return {"symbol": symbol.upper(), "items": items}


@app.get("/api/insights", response_class=JSONResponse)
async def api_insights(symbol: str):
    data = yahoo_chart_percent_changes(symbol.upper())
    if not data:
        return {
            "symbol": symbol.upper(),
            "changes": {},
            "description": "No performance snapshot available at this time.",
        }
    return {
        "symbol": symbol.upper(),
        "changes": data["changes"],
        "description": data["description"],
    }


@app.get("/api/calendar", response_class=JSONResponse)
async def api_calendar():
    events = trading_econ_calendar()
    return {"events": events}
