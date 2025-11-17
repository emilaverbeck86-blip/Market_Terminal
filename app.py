import time
from typing import List, Dict, Any
import xml.etree.ElementTree as ET

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from requests.exceptions import HTTPError

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL",
    "TSLA", "AVGO", "AMD", "NFLX", "ADBE",
    "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V",
    "MA", "XOM", "CVX", "UNH", "LLY", "ABBV"
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"

# Simple in-memory cache so we can fall back when Yahoo rate-limits us
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
    Fetch quotes from Yahoo Finance with basic caching and 429 handling.
    If Yahoo responds with 429 or any network error, we return the last
    cached result (if available) instead of raising.
    """
    global _quote_cache

    symbols_key = ",".join(symbols)

    # Try to avoid hammering the endpoint: reuse cache for 30 seconds
    if (
        _quote_cache["data"] is not None
        and _quote_cache["symbols_key"] == symbols_key
        and time.time() - _quote_cache["timestamp"] < 30
    ):
        return _quote_cache["data"]

    params = {"symbols": symbols_key}
    try:
        r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=5)
        r.raise_for_status()
        data = r.json().get("quoteResponse", {}).get("result", [])
        _quote_cache = {
            "data": data,
            "timestamp": time.time(),
            "symbols_key": symbols_key,
        }
        return data
    except HTTPError as e:
        # On 429, use cache if we have one
        if e.response is not None and e.response.status_code == 429:
            if _quote_cache["data"] is not None:
                return _quote_cache["data"]
        # Any other HTTP error – fall back to cache if possible
        if _quote_cache["data"] is not None:
            return _quote_cache["data"]
        return []
    except Exception:
        if _quote_cache["data"] is not None:
            return _quote_cache["data"]
        return []


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
    Very lightweight performance snapshot using Yahoo chart API.
    We compute percentage changes over approx. 1W/1M/3M/6M/YTD/1Y
    from daily adjusted close prices.
    """
    params = {"range": "1y", "interval": "1d"}
    try:
        r = requests.get(f"{YAHOO_CHART_URL}/{symbol}", params=params, timeout=6)
        r.raise_for_status()
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
            if base in (0, None):
                return None
            return round((last - base) / base * 100.0, 2)

        # Approximate trading days
        changes = {
            "1W": pct_ago(5),
            "1M": pct_ago(21),
            "3M": pct_ago(63),
            "6M": pct_ago(126),
            "YTD": None,
            "1Y": pct_ago(len(closes) - 1),
        }

        # YTD: find first bar of the year
        try:
            import datetime as _dt

            year = _dt.datetime.utcfromtimestamp(timestamps[-1]).year
            first_idx = next(
                i
                for i, ts in enumerate(timestamps)
                if _dt.datetime.utcfromtimestamp(ts).year == year
            )
            base = closes[first_idx]
            if base not in (0, None):
                changes["YTD"] = round((last - base) / base * 100.0, 2)
        except Exception:
            pass

        meta = result.get("meta", {})
        long_name = meta.get("longName", symbol)
        exchange = meta.get("exchangeName", "Unknown exchange")

        description = (
            f"{long_name} trades on {exchange}. "
            "The performance snapshot shows approximate percentage returns based on "
            "adjusted daily closes over the past year for several time horizons. "
            "Values are for informational purposes only."
        )

        return {"changes": changes, "description": description}
    except Exception:
        return {}


def yahoo_rss_news(symbol: str) -> List[Dict[str, Any]]:
    """
    Fetch finance headlines for a given symbol via Yahoo Finance RSS,
    using only the standard library for XML parsing.
    """
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
    try:
        resp = requests.get(url, timeout=5)
        resp.raise_for_status()
        content = resp.text

        root = ET.fromstring(content)

        # RSS structure: <rss><channel><item>...</item></channel></rss>
        channel = root.find("channel")
        if channel is None:
            # Some feeds use namespaces; try a very loose search for 'item'
            items_xml = root.findall(".//item")
        else:
            items_xml = channel.findall("item")

        items: List[Dict[str, Any]] = []

        for item in items_xml[:25]:
            title_el = item.find("title")
            link_el = item.find("link")
            pub_el = item.find("pubDate")

            # source may be under <source> or with namespaces; best-effort
            source = "Yahoo Finance"
            source_el = item.find("source")
            if source_el is not None and source_el.text:
                source = source_el.text

            title = title_el.text if title_el is not None else ""
            link = link_el.text if link_el is not None else ""
            pub = pub_el.text if pub_el is not None else ""

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


# --------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/tickers", response_class=JSONResponse)
async def api_tickers():
    try:
        quotes = yahoo_quotes(WATCHLIST)
        simplified = [simplify_quote(q) for q in quotes]
        return {"tickers": simplified}
    except Exception as e:
        # Never hard-fail – just return empty so UI can show placeholder
        return {"tickers": [], "error": str(e)}


@app.get("/api/movers", response_class=JSONResponse)
async def api_movers():
    try:
        quotes = [simplify_quote(q) for q in yahoo_quotes(WATCHLIST)]
        # Filter out any without changePercent
        valid = [q for q in quotes if isinstance(q.get("changePercent"), (int, float))]
        gainers = sorted(valid, key=lambda x: x["changePercent"], reverse=True)[:5]
        losers = sorted(valid, key=lambda x: x["changePercent"])[:5]
        return {"gainers": gainers, "losers": losers}
    except Exception as e:
        return {"gainers": [], "losers": [], "error": str(e)}


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
            "description": "No performance snapshot available.",
        }
    return {
        "symbol": symbol.upper(),
        "changes": data["changes"],
        "description": data["description"],
    }
