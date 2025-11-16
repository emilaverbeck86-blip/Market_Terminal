import asyncio
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any

import httpx
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import xml.etree.ElementTree as ET
from urllib.parse import quote_plus

app = FastAPI()

# ---- Static / index ---------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index() -> FileResponse:
    # Serve plain HTML (no templating) from project root
    return FileResponse("index.html")


# ---- Symbol config ----------------------------------------------------------

# Core symbols for yfinance (data) and TradingView (chart)
WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA",
    "AVGO", "AMD", "NFLX", "ADBE", "INTC", "CSCO", "QCOM",
    "TXN", "JPM", "BAC", "WFC", "V", "MA", "XOM", "CVX"
]

# Map pseudo symbols to yfinance + TradingView
CORE_SYMBOL_MAP: Dict[str, str] = {
    "SP500": "^GSPC",
    "NASDAQ": "^NDX",        # NASDAQ 100
}

# For insights (labels used on frontend)
INSIGHT_WINDOWS = {
    "1W": 5,
    "1M": 21,
    "3M": 63,
    "6M": 126,
    "YTD": "ytd",
    "1Y": 252,
}

# ---- HTTP client & small helpers -------------------------------------------

HTTP_TIMEOUT = 10.0
client = httpx.AsyncClient(timeout=HTTP_TIMEOUT, headers={"User-Agent": "MarketTerminal/1.0"})


def yf_symbol(symbol: str) -> str:
    """Map frontend symbol to yfinance symbol."""
    return CORE_SYMBOL_MAP.get(symbol.upper(), symbol.upper())


def _pct_change(old: float, new: float) -> float:
    if old is None or new is None or old == 0:
        return 0.0
    return (new - old) / old * 100.0


# ---- Caching for tickers / movers / insights -------------------------------

_ticker_cache: Dict[str, Any] = {"ts": None, "data": None}
_TICKER_CACHE_SECONDS = 60

_insights_cache: Dict[str, Any] = {}
_INSIGHTS_CACHE_SECONDS = 600  # 10 minutes


async def get_quotes() -> List[Dict[str, Any]]:
    """Return latest price + daily change for WATCHLIST symbols."""
    now = datetime.now(timezone.utc)
    if (
        _ticker_cache["ts"] is not None
        and (now - _ticker_cache["ts"]).total_seconds() < _TICKER_CACHE_SECONDS
        and _ticker_cache["data"] is not None
    ):
        return _ticker_cache["data"]

    result: List[Dict[str, Any]] = []
    for sym in WATCHLIST:
        yfs = yf_symbol(sym)
        try:
            t = yf.Ticker(yfs)
            hist = t.history(period="2d", interval="1d")
            if hist.empty:
                continue
            closes = hist["Close"].tolist()
            last = float(closes[-1])
            prev = float(closes[-2]) if len(closes) >= 2 else last
            chg = _pct_change(prev, last)
            result.append(
                {
                    "symbol": sym,
                    "price": round(last, 2),
                    "change_pct": round(chg, 2),
                }
            )
        except Exception:
            continue

    _ticker_cache["ts"] = now
    _ticker_cache["data"] = result
    return result


async def get_insights(symbol: str) -> Dict[str, Any]:
    """Return multi-horizon performance + profile."""
    key = symbol.upper()
    now = datetime.now(timezone.utc)
    cached = _insights_cache.get(key)
    if cached and (now - cached["ts"]).total_seconds() < _INSIGHTS_CACHE_SECONDS:
        return cached["data"]

    yfs = yf_symbol(symbol)
    t = yf.Ticker(yfs)
    data: Dict[str, Any] = {
        "symbol": symbol.upper(),
        "windows": {},
        "profile": "",
    }

    try:
        hist = t.history(period="1y", interval="1d")
        if hist.empty:
            raise RuntimeError("no history")

        closes = hist["Close"]
        close_dates = closes.index

        def price_at_days_ago(days: int) -> float:
            target_date = close_dates[-1] - timedelta(days=days)
            # find closest previous date
            prev = closes[closes.index <= target_date]
            if prev.empty:
                return float(closes.iloc[0])
            return float(prev.iloc[-1])

        last_price = float(closes.iloc[-1])

        for label, win in INSIGHT_WINDOWS.items():
            if label == "YTD":
                # first trading day of year
                year_start = datetime(close_dates[-1].year, 1, 1, tzinfo=close_dates[-1].tz)
                prev = closes[closes.index >= year_start]
                if prev.empty:
                    pct = 0.0
                else:
                    base = float(prev.iloc[0])
                    pct = _pct_change(base, last_price)
            else:
                days = int(win)
                base = price_at_days_ago(days)
                pct = _pct_change(base, last_price)
            data["windows"][label] = round(pct, 2)

    except Exception:
        # keep empty; frontend will show dashes
        pass

    # Profile (limit to ~6 sentences)
    try:
        info = t.get_info()
        long_desc = info.get("longBusinessSummary") or info.get("longName") or ""
        if long_desc:
            # crude sentence splitter
            parts = [p.strip() for p in long_desc.replace("\n", " ").split(".") if p.strip()]
            limited = ". ".join(parts[:6])
            if limited and not limited.endswith("."):
                limited += "."
            data["profile"] = limited
    except Exception:
        data["profile"] = "No profile available for this instrument."

    _insights_cache[key] = {"ts": now, "data": data}
    return data


# ---- News pipeline: TradingView → Yahoo RSS → Google News ------------------


async def fetch_tradingview_news(symbol: str) -> List[Dict[str, Any]]:
    """
    Best-effort TradingView news scraper.
    If it fails for any reason, we just return [] and let caller fallback.
    """
    # Attempt NASDAQ-XXX slug first, then plain
    candidates = [
        f"https://www.tradingview.com/symbols/NASDAQ-{symbol.upper()}/news/",
        f"https://www.tradingview.com/symbols/{symbol.upper()}/news/",
    ]
    articles: List[Dict[str, Any]] = []

    for url in candidates:
        try:
            resp = await client.get(url)
            if resp.status_code != 200:
                continue
            html = resp.text

            # TradingView usually includes JSON in window.__initialState__
            # We'll very roughly look for `"news":` array.
            if '"news":' not in html:
                continue

            start = html.find('"news":')
            if start == -1:
                continue
            # Take a chunk after "news": and naive parse by splitting on `"head"`
            chunk = html[start:start + 50000]

            # Extremely crude parse – this is intentionally simple and
            # will often fail safely. We only use it as a first-tier attempt.
            items = []
            for part in chunk.split('{"id"')[1:20]:
                # Get title
                t_start = part.find('"headline":"')
                if t_start == -1:
                    continue
                t_start += len('"headline":"')
                t_end = part.find('"', t_start)
                title = part[t_start:t_end]

                # Get link
                l_start = part.find('"shortUrl":"')
                if l_start == -1:
                    continue
                l_start += len('"shortUrl":"')
                l_end = part.find('"', l_start)
                link = part[l_start:l_end].replace("\\u002F", "/")

                items.append((title, link))

            for title, link in items:
                articles.append(
                    {
                        "title": title,
                        "url": f"https://www.tradingview.com{link}" if link.startswith("/") else link,
                        "source": "TradingView",
                        "published_at": "",
                    }
                )

            if articles:
                break
        except Exception:
            continue

    return articles[:20]


async def fetch_yahoo_rss(symbol: str) -> List[Dict[str, Any]]:
    url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={quote_plus(symbol)}&region=US&lang=en-US"
    articles: List[Dict[str, Any]] = []
    try:
        resp = await client.get(url)
        if resp.status_code != 200 or not resp.text.strip():
            return []
        root = ET.fromstring(resp.text)
        for item in root.findall(".//item")[:20]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            source_el = item.find("{*}source")
            source = (source_el.text or "").strip() if source_el is not None else "Yahoo Finance"
            if title and link:
                articles.append(
                    {
                        "title": title,
                        "url": link,
                        "source": source or "Yahoo Finance",
                        "published_at": pub,
                    }
                )
    except Exception:
        return []
    return articles


async def fetch_google_news(query: str, limit: int = 20) -> List[Dict[str, Any]]:
    url = (
        "https://news.google.com/rss/search?q="
        f"{quote_plus(query)}&hl=en-US&gl=US&ceid=US:en"
    )
    articles: List[Dict[str, Any]] = []
    try:
        resp = await client.get(url)
        if resp.status_code != 200 or not resp.text.strip():
            return []
        root = ET.fromstring(resp.text)
        for item in root.findall(".//item")[:limit]:
            title = (item.findtext("title") or "").strip()
            link = (item.findtext("link") or "").strip()
            pub = (item.findtext("pubDate") or "").strip()
            source_el = item.find("{*}source")
            source = (source_el.text or "").strip() if source_el is not None else "Google News"
            if title and link:
                articles.append(
                    {
                        "title": title,
                        "url": link,
                        "source": source or "Google News",
                        "published_at": pub,
                    }
                )
    except Exception:
        return []
    return articles


async def news_pipeline_for_symbol(symbol: str) -> List[Dict[str, Any]]:
    # 1) TradingView
    tv = await fetch_tradingview_news(symbol)
    if tv:
        return tv

    # 2) Yahoo RSS
    yh = await fetch_yahoo_rss(symbol)
    if yh:
        return yh

    # 3) Google News
    gn = await fetch_google_news(f"{symbol} stock")
    return gn


async def market_news_pipeline() -> List[Dict[str, Any]]:
    # General market news via Google News only (broad query)
    gn = await fetch_google_news("stock market OR S&P 500", limit=30)
    return gn


# ---- API endpoints ----------------------------------------------------------


@app.get("/api/tickers")
async def api_tickers() -> JSONResponse:
    data = await get_quotes()
    return JSONResponse(data)


@app.get("/api/movers")
async def api_movers() -> JSONResponse:
    quotes = await get_quotes()
    # Only use ones that actually have a price
    valid = [q for q in quotes if q.get("price") is not None]
    sorted_by = sorted(valid, key=lambda x: x.get("change_pct", 0.0), reverse=True)
    gainers = sorted_by[:5]
    losers = list(reversed(sorted_by[-5:]))
    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/insights")
async def api_insights(symbol: str = Query(...)) -> JSONResponse:
    data = await get_insights(symbol)
    return JSONResponse(data)


@app.get("/api/news")
async def api_news(symbol: str = Query(...)) -> JSONResponse:
    articles = await news_pipeline_for_symbol(symbol)
    return JSONResponse(articles)


@app.get("/api/market-news")
async def api_market_news() -> JSONResponse:
    articles = await market_news_pipeline()
    return JSONResponse(articles)


# ---- Shutdown ---------------------------------------------------------------

@app.on_event("shutdown")
async def shutdown_event() -> None:
    await client.aclose()
