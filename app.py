import os
from typing import List, Dict, Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

# ---------------------------------------------------------------------
# Watchlist for ticker bar / movers
# ---------------------------------------------------------------------
WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V", "MA",
    "XOM", "CVX",
    "UNH", "LLY", "ABBV",
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"


def yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Fetch basic quote data from Yahoo Finance. On any error or rate limit,
    return an empty list so the frontend can handle gracefully.
    """
    if not symbols:
        return []

    try:
        params = {"symbols": ",".join(symbols)}
        resp = requests.get(YAHOO_QUOTE_URL, params=params, timeout=5)
        # Do not raise_for_status here to avoid crashing on 4xx
        if resp.status_code != 200:
            return []
        data = resp.json().get("quoteResponse", {}).get("result", [])
    except Exception:
        return []

    results: List[Dict[str, Any]] = []
    for q in data:
        symbol = q.get("symbol")
        price = q.get("regularMarketPrice")
        change_pct = q.get("regularMarketChangePercent")
        if symbol is None or price is None:
            continue
        results.append(
            {
                "symbol": symbol,
                "price": float(price),
                "changePercent": float(change_pct) if change_pct is not None else 0.0,
            }
        )
    return results


# ---------------------------------------------------------------------
# Simple RSS scraper for news (no feedparser)
# ---------------------------------------------------------------------

def _between(text: str, start: str, end: str) -> str:
    try:
        i = text.index(start) + len(start)
        j = text.index(end, i)
        return text[i:j].strip()
    except ValueError:
        return ""


def fetch_yahoo_news(symbol: str, limit: int = 15) -> List[Dict[str, str]]:
    """
    Fetch headlines from Yahoo Finance RSS for a given symbol.
    This is a very small hand-rolled XML parser, no external libs.
    """
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        f"?s={symbol}&region=US&lang=en-US"
    )
    try:
        resp = requests.get(url, timeout=5)
        if resp.status_code != 200:
            return []
        xml = resp.text
    except Exception:
        return []

    items = xml.split("<item>")[1:]
    news: List[Dict[str, str]] = []

    for item in items[:limit]:
        title = _between(item, "<title>", "</title>")
        link = _between(item, "<link>", "</link>")
        pub = _between(item, "<pubDate>", "</pubDate>")
        source = _between(item, "<source", "</source>")
        # strip any attributes from <source ...>
        if ">" in source:
            source = source.split(">")[-1]
        if not title:
            continue
        news.append(
            {
                "title": title,
                "link": link,
                "source": source or "Yahoo Finance",
                "published": pub,
            }
        )
    return news


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/heatmap")
async def heatmap(request: Request):
    # separate page where you embed TradingView heatmap,
    # but still keep top bar via heatmap.html
    return templates.TemplateResponse("heatmap.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers():
    """
    Data for the scrolling ticker bar.
    """
    quotes = yahoo_quotes(WATCHLIST)
    return JSONResponse(quotes)


@app.get("/api/movers")
async def api_movers():
    """
    Top gainers / losers inside WATCHLIST.
    """
    quotes = yahoo_quotes(WATCHLIST)
    if not quotes:
        return JSONResponse({"gainers": [], "losers": []})

    sorted_quotes = sorted(quotes, key=lambda q: q.get("changePercent", 0.0))
    losers = list(reversed(sorted_quotes[:5]))  # most negative first
    gainers = sorted_quotes[-5:]               # most positive

    return JSONResponse({"gainers": gainers[::-1], "losers": losers})


@app.get("/api/news")
async def api_news(symbol: str):
    """
    News for a specific symbol from Yahoo RSS.
    """
    headlines = fetch_yahoo_news(symbol.upper())
    return JSONResponse(headlines)


@app.get("/api/insights")
async def api_insights(symbol: str):
    """
    Very simple insights: we reuse the latest quote and some static text.
    In your frontend this fills the Market Insights tile.
    """
    symbol = symbol.upper()
    quote = yahoo_quotes([symbol])
    if not quote:
        return JSONResponse(
            {
                "symbol": symbol,
                "performance": {},
                "description": "No profile available at this time.",
            }
        )

    # Stub performance values (in a real setup you would call a history API)
    performance = {
        "1W": 0.0,
        "1M": 0.0,
        "3M": 0.0,
        "6M": 0.0,
        "YTD": 0.0,
        "1Y": 0.0,
    }

    description = (
        f"{symbol} is a publicly traded company. "
        "Detailed fundamentals and profile data are not yet connected in this demo."
    )

    return JSONResponse(
        {
            "symbol": symbol,
            "performance": performance,
            "description": description,
        }
    )


@app.get("/api/calendar")
async def api_calendar():
    """
    Small static US economic calendar stub to populate the tile.
    You can later wire this to a real free calendar API.
    """
    events = [
        {
            "time": "13:30",
            "country": "US",
            "event": "Initial Jobless Claims",
            "actual": "",
            "forecast": "230K",
            "previous": "225K",
        },
        {
            "time": "15:00",
            "country": "US",
            "event": "Existing Home Sales (MoM)",
            "actual": "",
            "forecast": "-1.2%",
            "previous": "-2.0%",
        },
    ]
    return JSONResponse(events)


# ---------------------------------------------------------------------
# Simple health endpoint
# ---------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok"}
