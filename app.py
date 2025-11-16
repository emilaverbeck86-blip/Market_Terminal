import os
from datetime import datetime, timedelta
from typing import List, Dict, Any

import httpx
import yfinance as yf
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# -------------------------------------------------------------------
# FastAPI setup
# -------------------------------------------------------------------
app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

static_dir = os.path.join(BASE_DIR, "static")
if not os.path.isdir(static_dir):
    os.makedirs(static_dir, exist_ok=True)

app.mount("/static", StaticFiles(directory=static_dir), name="static")

# -------------------------------------------------------------------
# Universe / watchlist
# -------------------------------------------------------------------
WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META",
    "GOOGL", "TSLA", "AVGO", "AMD", "NFLX",
    "ADBE", "INTC", "CSCO", "QCOM", "TXN",
    "JPM", "BAC", "WFC", "GS", "MS",
]

# initial symbol for chart
DEFAULT_SYMBOL = "AAPL"


# -------------------------------------------------------------------
# Helpers
# -------------------------------------------------------------------
def _safe_float(v: Any) -> float | None:
    try:
        if v is None:
            return None
        return float(v)
    except Exception:
        return None


def _format_time(ts: datetime | None) -> str:
    if not ts:
        return ""
    return ts.strftime("%Y-%m-%d %H:%M")


async def fetch_quote(symbol: str) -> Dict[str, Any]:
    """
    Basic quote using yfinance. Uses fast_info when possible.
    """
    ticker = yf.Ticker(symbol)
    info = {}
    try:
        fi = ticker.fast_info
        last = _safe_float(getattr(fi, "last_price", None))
        prev = _safe_float(getattr(fi, "previous_close", None))
        currency = getattr(fi, "currency", "USD")
    except Exception:
        fi = None
        last = prev = currency = None

    if last is None or prev is None:
        try:
            hist = ticker.history(period="5d")
            if not hist.empty:
                last = float(hist["Close"].iloc[-1])
                prev = float(hist["Close"].iloc[-2]) if len(hist) > 1 else last
                currency = getattr(ticker.info, "currency", "USD")
        except Exception:
            pass

    change_pct = None
    if last is not None and prev not in (None, 0):
        change_pct = (last - prev) / prev * 100.0

    return {
        "symbol": symbol,
        "price": last,
        "previous_close": prev,
        "change_pct": change_pct,
        "currency": currency or "USD",
    }


async def fetch_performance(symbol: str) -> Dict[str, Any]:
    """
    1W, 1M, 3M, 6M, YTD, 1Y performance using yfinance daily history.
    """
    now = datetime.utcnow()
    start = now - timedelta(days=365 * 1 + 30)
    try:
        hist = yf.download(symbol, start=start.date(), end=now.date(), progress=False)
    except Exception:
        hist = None

    if hist is None or hist.empty:
        return {}

    hist = hist["Close"].dropna()
    if hist.empty:
        return {}

    last_price = float(hist.iloc[-1])

    def change_since(days_back: int | None = None, date_at_year_start: bool = False) -> float | None:
        if last_price == 0:
            return None
        try:
            if date_at_year_start:
                year_start = datetime(now.year, 1, 1)
                past_series = hist.loc[hist.index >= year_start]
                if past_series.empty:
                    return None
                past_price = float(past_series.iloc[0])
            else:
                past_date = now - timedelta(days=days_back)
                past_series = hist.loc[:past_date.strftime("%Y-%m-%d")]
                if past_series.empty:
                    return None
                past_price = float(past_series.iloc[-1])
            return (last_price - past_price) / past_price * 100.0
        except Exception:
            return None

    return {
        "1W": change_since(7),
        "1M": change_since(30),
        "3M": change_since(90),
        "6M": change_since(180),
        "YTD": change_since(None, date_at_year_start=True),
        "1Y": change_since(365),
    }


async def fetch_profile(symbol: str) -> str:
    """
    Short business description; at most ~6 sentences.
    """
    try:
        info = yf.Ticker(symbol).info
    except Exception:
        info = {}

    text = info.get("longBusinessSummary") or info.get("description") or ""
    if not text:
        return ""

    # Keep it compact: first 6 sentences max
    parts = [p.strip() for p in text.replace("\n", " ").split(".") if p.strip()]
    short = ". ".join(parts[:6])
    if short and not short.endswith("."):
        short += "."
    return short


async def fetch_tickers() -> List[Dict[str, Any]]:
    """
    Quotes for all watchlist symbols.
    """
    out: List[Dict[str, Any]] = []
    for sym in WATCHLIST:
        q = await fetch_quote(sym)
        out.append(q)
    return out


async def fetch_movers() -> Dict[str, List[Dict[str, Any]]]:
    """
    Top 5 gainers and losers from watchlist.
    """
    quotes = await fetch_tickers()
    valid = [q for q in quotes if q.get("change_pct") is not None]
    sorted_list = sorted(valid, key=lambda x: x["change_pct"])
    losers = sorted_list[:5]
    gainers = sorted_list[-5:][::-1]
    return {"gainers": gainers, "losers": losers}


async def fetch_news_yahoo(symbol: str | None = None, limit: int = 20) -> List[Dict[str, Any]]:
    """
    Try Yahoo Finance RSS for symbol-specific or market news.
    """
    if symbol:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
    else:
        url = "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US"

    items: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        import xml.etree.ElementTree as ET

        root = ET.fromstring(resp.text)
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = item.findtext("pubDate")
            items.append(
                {
                    "title": title or "(untitled)",
                    "url": link or "#",
                    "source": "Yahoo Finance",
                    "published_at": pub or "",
                }
            )
    return items


async def fetch_news_google(symbol: str | None = None, limit: int = 20) -> List[Dict[str, Any]]:
    """
    Fallback: Google News RSS.
    """
    query = f"{symbol} stock" if symbol else "stock market"
    url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
    items: List[Dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        import xml.etree.ElementTree as ET

        root = ET.fromstring(resp.text)
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = item.findtext("pubDate")
            source_tag = item.find("{*}source")
            source_name = source_tag.text.strip() if source_tag is not None and source_tag.text else "Google News"
            items.append(
                {
                    "title": title or "(untitled)",
                    "url": link or "#",
                    "source": source_name,
                    "published_at": pub or "",
                }
            )
    return items


async def fetch_news(symbol: str | None = None, limit: int = 20) -> List[Dict[str, Any]]:
    """
    News with Yahoo -> Google fallback.
    """
    for provider in (fetch_news_yahoo, fetch_news_google):
        try:
            return await provider(symbol, limit=limit)
        except Exception:
            continue
    return []


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "default_symbol": DEFAULT_SYMBOL, "watchlist": WATCHLIST},
    )


@app.get("/api/tickers")
async def api_tickers() -> JSONResponse:
    data = await fetch_tickers()
    return JSONResponse(data)


@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)) -> JSONResponse:
    data = await fetch_quote(symbol.upper())
    return JSONResponse(data)


@app.get("/api/insights")
async def api_insights(symbol: str = Query(...)) -> JSONResponse:
    sym = symbol.upper()
    perf = await fetch_performance(sym)
    profile = await fetch_profile(sym)
    return JSONResponse(
        {
            "symbol": sym,
            "performance": perf,
            "profile": profile,
        }
    )


@app.get("/api/movers")
async def api_movers() -> JSONResponse:
    data = await fetch_movers()
    return JSONResponse(data)


@app.get("/api/news")
async def api_news(symbol: str = Query(None)) -> JSONResponse:
    data = await fetch_news(symbol.upper() if symbol else None, limit=25)
    return JSONResponse(data)
