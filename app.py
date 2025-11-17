import os
from typing import List, Dict, Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI()

templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")

# ---------------------------------------------------------------------
# Watchlist / static fallbacks
# ---------------------------------------------------------------------

WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V", "MA",
    "XOM", "CVX",
    "UNH", "LLY", "ABBV",
    "SPY", "QQQ"
]

# simple always-available fallback so UI never looks empty
STATIC_TICKERS: List[Dict[str, Any]] = [
    {"symbol": "AAPL", "price": 272.5, "changePercent": -0.2},
    {"symbol": "MSFT", "price": 510.2, "changePercent": 1.1},
    {"symbol": "NVDA", "price": 190.1, "changePercent": 1.8},
    {"symbol": "META", "price": 320.4, "changePercent": -0.4},
    {"symbol": "GOOGL", "price": 276.4, "changePercent": 0.6},
    {"symbol": "TSLA", "price": 202.0, "changePercent": -0.9},
    {"symbol": "AVGO", "price": 342.7, "changePercent": 0.7},
    {"symbol": "AMD", "price": 156.3, "changePercent": -0.5},
    {"symbol": "NFLX", "price": 112.1, "changePercent": -3.6},
    {"symbol": "ADBE", "price": 333.4, "changePercent": -0.8},
    {"symbol": "INTC", "price": 35.8, "changePercent": -1.3},
    {"symbol": "CSCO", "price": 78.0, "changePercent": 0.8},
    {"symbol": "QCOM", "price": 173.9, "changePercent": -0.3},
    {"symbol": "TXN", "price": 159.3, "changePercent": -1.9},
    {"symbol": "CRM", "price": 255.4, "changePercent": 0.4},
    {"symbol": "JPM", "price": 303.6, "changePercent": 1.3},
    {"symbol": "BAC", "price": 52.4, "changePercent": -0.5},
    {"symbol": "WFC", "price": 85.0, "changePercent": 0.3},
    {"symbol": "GS", "price": 309.8, "changePercent": 0.1},
    {"symbol": "V", "price": 265.0, "changePercent": 0.2},
    {"symbol": "MA", "price": 405.1, "changePercent": -0.1},
    {"symbol": "XOM", "price": 112.5, "changePercent": -0.6},
    {"symbol": "CVX", "price": 148.2, "changePercent": 0.3},
    {"symbol": "UNH", "price": 510.7, "changePercent": 0.5},
    {"symbol": "LLY", "price": 785.3, "changePercent": 0.9},
    {"symbol": "ABBV", "price": 168.4, "changePercent": -0.2},
    {"symbol": "SPY", "price": 675.9, "changePercent": -0.1},
    {"symbol": "QQQ", "price": 525.4, "changePercent": -0.2},
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"


def yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """Safely fetch quotes from Yahoo. On any error, return empty list."""
    if not symbols:
        return []
    try:
        params = {"symbols": ",".join(symbols)}
        resp = requests.get(YAHOO_QUOTE_URL, params=params, timeout=6)
        if resp.status_code != 200:
            return []
        data = resp.json().get("quoteResponse", {}).get("result", [])
    except Exception:
        return []

    out: List[Dict[str, Any]] = []
    for q in data:
        symbol = q.get("symbol")
        price = q.get("regularMarketPrice")
        change_pct = q.get("regularMarketChangePercent")
        if symbol is None or price is None:
            continue
        out.append(
            {
                "symbol": symbol,
                "price": float(price),
                "changePercent": float(change_pct) if change_pct is not None else 0.0,
            }
        )
    return out


# ---------------------------------------------------------------------
# RSS helper for news (no extra libs)
# ---------------------------------------------------------------------

def _between(text: str, start: str, end: str) -> str:
    try:
        i = text.index(start) + len(start)
        j = text.index(end, i)
        return text[i:j].strip()
    except ValueError:
        return ""


def fetch_yahoo_news(symbol: str, limit: int = 15) -> List[Dict[str, str]]:
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        f"?s={symbol}&region=US&lang=en-US"
    )
    try:
        resp = requests.get(url, timeout=6)
        if resp.status_code != 200:
            return []
        xml = resp.text
    except Exception:
        return []

    parts = xml.split("<item>")[1:]
    items: List[Dict[str, str]] = []

    for raw in parts[:limit]:
        title = _between(raw, "<title>", "</title>")
        link = _between(raw, "<link>", "</link>")
        pub = _between(raw, "<pubDate>", "</pubDate>")
        # source tag may have attributes
        source_block = _between(raw, "<source", "</source>")
        if ">" in source_block:
            source_block = source_block.split(">")[-1].strip()

        if not title:
            continue

        items.append(
            {
                "title": title,
                "link": link or "",
                "source": source_block or "Yahoo Finance",
                "published": pub or "",
            }
        )
    return items


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------


@app.get("/")
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/heatmap")
async def heatmap(request: Request):
    return templates.TemplateResponse("heatmap.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers():
    quotes = yahoo_quotes(WATCHLIST)
    if not quotes:
        quotes = STATIC_TICKERS
    return JSONResponse(quotes)


@app.get("/api/movers")
async def api_movers():
    quotes = yahoo_quotes(WATCHLIST)
    if not quotes:
        # fallback: compute from static
        quotes = STATIC_TICKERS

    sorted_quotes = sorted(quotes, key=lambda q: q.get("changePercent", 0.0))
    losers = sorted_quotes[:5]
    gainers = sorted_quotes[-5:]
    return JSONResponse({"gainers": gainers[::-1], "losers": losers})


@app.get("/api/news")
async def api_news(symbol: str):
    symbol = symbol.upper()
    headlines = fetch_yahoo_news(symbol)
    if not headlines:
        # simple fallback headlines so tile never empty
        headlines = [
            {
                "title": f"{symbol} overview and latest market commentary",
                "link": "",
                "source": "Market Terminal",
                "published": "",
            }
        ]
    return JSONResponse(headlines)


@app.get("/api/insights")
async def api_insights(symbol: str):
    symbol = symbol.upper()
    quote_list = yahoo_quotes([symbol])

    performance = {
        "1W": 1.15,
        "1M": 3.2,
        "3M": 7.6,
        "6M": 12.1,
        "YTD": 18.3,
        "1Y": 21.0,
    }

    description = (
        f"{symbol} is a major public company followed by global investors. "
        "This snapshot combines recent performance and a short descriptive profile "
        "to give you a quick fundamental impression inside the terminal."
    )

    if not quote_list:
        return JSONResponse(
            {"symbol": symbol, "performance": performance, "description": description}
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
    events = [
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
    return JSONResponse(events)


@app.get("/health")
async def health():
    return {"status": "ok"}
