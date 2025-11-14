from datetime import datetime, timedelta
from typing import List, Dict, Any

import httpx
import yfinance as yf
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from xml.etree import ElementTree as ET

app = FastAPI()

# ---------------------------------------------------------------------
# Static & templates
# ---------------------------------------------------------------------

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ---------------------------------------------------------------------
# Symbol universe (ticker bar + movers)
# ---------------------------------------------------------------------

TICKERS: List[str] = [
    # Big tech / mega caps
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN",
    # Financials
    "JPM", "BAC", "GS", "V", "MA",
    # Industrials / staples / discretionary
    "CAT", "HD", "MCD", "DIS", "KO", "PEP",
    # Energy / healthcare
    "XOM", "CVX", "UNH", "LLY",
]

# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------


def _safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(v)
    except Exception:
        return default


def _daily_snapshot(symbol: str) -> Dict[str, Any] | None:
    """
    Simple daily snapshot using yfinance.

    Returns:
      { "symbol": str, "price": float, "change_pct": float } or None
    """
    try:
        data = yf.download(symbol, period="2d", interval="1d", progress=False)
        if data.empty:
            return None

        closes = data["Close"].tolist()
        if len(closes) == 1:
            prev = last = closes[0]
        else:
            prev, last = closes[-2], closes[-1]

        last_f = _safe_float(last)
        prev_f = _safe_float(prev)
        change_pct = (last_f - prev_f) / prev_f * 100 if prev_f else 0.0

        return {
            "symbol": symbol,
            "price": round(last_f, 2),
            "change_pct": round(change_pct, 2),
        }
    except Exception:
        return None


def _performance_series(symbol: str) -> Dict[str, float]:
    """
    Simple performance series for a symbol.

    Returns keys:
      "1W", "1M", "3M", "6M", "YTD", "1Y"
    """
    result = {k: 0.0 for k in ["1W", "1M", "3M", "6M", "YTD", "1Y"]}

    try:
        end = datetime.utcnow()
        start = end - timedelta(days=365 * 2)
        history = yf.download(
            symbol,
            start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            interval="1d",
            progress=False,
        )
        if history.empty:
            return result

        closes = history["Close"]
        last_price = _safe_float(closes.iloc[-1])
        if last_price == 0:
            return result

        def pct_from_days(days: int) -> float:
            cutoff = end - timedelta(days=days)
            subset = closes[closes.index >= cutoff]
            if subset.empty:
                return 0.0
            ref_price = _safe_float(subset.iloc[0])
            if ref_price == 0:
                return 0.0
            return round((last_price - ref_price) / ref_price * 100, 2)

        result["1W"] = pct_from_days(7)
        result["1M"] = pct_from_days(30)
        result["3M"] = pct_from_days(90)
        result["6M"] = pct_from_days(180)

        # YTD
        this_year_start = datetime(end.year, 1, 1)
        subset_ytd = closes[closes.index >= this_year_start]
        if not subset_ytd.empty:
            ref_ytd = _safe_float(subset_ytd.iloc[0])
            if ref_ytd:
                result["YTD"] = round((last_price - ref_ytd) / ref_ytd * 100, 2)

        result["1Y"] = pct_from_days(365)
        return result
    except Exception:
        return result


async def _fetch_rss(url: str, source_name: str, limit: int = 20) -> List[Dict[str, Any]]:
    """
    Fetch & parse RSS into unified news JSON:
      { title, url, source, published_at }
    """
    items: List[Dict[str, Any]] = []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            root = ET.fromstring(r.text)
    except Exception:
        return items

    for item in root.findall(".//item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        if not title:
            continue
        items.append(
            {
                "title": title,
                "url": link,
                "source": source_name,
                "published_at": pub,
            }
        )
    return items


# ---------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------


@app.get("/")
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers() -> JSONResponse:
    """
    Ticker bar data:
      [ {symbol, price, change_pct}, ... ]
    """
    rows: List[Dict[str, Any]] = []
    for sym in TICKERS:
        snap = _daily_snapshot(sym)
        if snap:
            rows.append(snap)
    return JSONResponse(rows)


@app.get("/api/insights")
async def api_insights(symbol: str = Query("AAPL")) -> JSONResponse:
    """
    Market insights tile.

    Returns:
      {
        "symbol": "...",
        "performance": { "1W": ..., ... },
        "description": "..."
      }
    """
    sym = (symbol or "AAPL").upper()
    perf = _performance_series(sym)

    desc = ""
    try:
        info = yf.Ticker(sym).info
        desc = info.get("longBusinessSummary") or info.get("longName") or ""
    except Exception:
        desc = ""

    return JSONResponse(
        {
            "symbol": sym,
            "performance": perf,
            "description": desc,
        }
    )


@app.get("/api/movers")
async def api_movers() -> JSONResponse:
    """
    Top gainers/losers within watchlist.

    Returns:
      { "gainers": [...], "losers": [...] }
    """
    snaps: List[Dict[str, Any]] = []
    for sym in TICKERS:
        snap = _daily_snapshot(sym)
        if snap:
            snaps.append(snap)

    gainers = sorted(snaps, key=lambda r: r["change_pct"], reverse=True)[:5]
    losers = sorted(snaps, key=lambda r: r["change_pct"])[:5]

    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/news")
async def api_news(symbol: str = Query("AAPL")) -> JSONResponse:
    """
    Symbol-specific news via Yahoo Finance RSS.

    Returns array:
      {title, url, source, published_at}
    """
    sym = (symbol or "AAPL").upper()
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        f"?s={sym}&region=US&lang=en-US"
    )
    try:
        articles = await _fetch_rss(url, "Yahoo Finance", limit=20)
        return JSONResponse(articles)
    except Exception:
        return JSONResponse([])


@app.get("/api/market-news")
async def api_market_news() -> JSONResponse:
    """
    General market headlines (S&P 500 proxy).
    """
    url = (
        "https://feeds.finance.yahoo.com/rss/2.0/headline"
        "?s=%5EGSPC&region=US&lang=en-US"
    )
    try:
        articles = await _fetch_rss(url, "Yahoo Finance", limit=30)
        return JSONResponse(articles)
    except Exception:
        return JSONResponse([])


@app.get("/health")
async def health_check():
    return {"status": "ok"}
