import asyncio
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import yfinance as yf
from fastapi import FastAPI, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

# -------------------------------------------------------------------
# Basic setup
# -------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI(title="Market Terminal")

# static files (style.css, main.js)
app.mount("/static", StaticFiles(directory="static"), name="static")

# single shared HTTP client for Yahoo calls
_http_client = httpx.AsyncClient(
    timeout=10.0,
    headers={
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0 Safari/537.36"
        )
    },
)


@app.on_event("shutdown")
async def _shutdown_client():
    await _http_client.aclose()


# -------------------------------------------------------------------
# Universe of tickers (used for ticker bar + movers)
# -------------------------------------------------------------------

TICKERS: List[str] = [
    "AAPL",
    "MSFT",
    "NVDA",
    "AMZN",
    "META",
    "GOOGL",
    "TSLA",
    "AVGO",
    "AMD",
    "NFLX",
    "ADBE",
    "INTC",
    "CSCO",
    "QCOM",
    "TXN",
    "CRM",
    "ORCL",
    "NOW",
    "ABNB",
    "SHOP",
    "PYPL",
    "JPM",
    "BAC",
    "WFC",
    "GS",
    "MS",
    "V",
    "MA",
    "AXP",
    "BRK-B",
    "SCHW",
    "KO",
    "PEP",
    "PG",
    "MCD",
    "COST",
    "HD",
    "LOW",
    "DIS",
    "NKE",
    "SBUX",
    "TGT",
    "WMT",
    "T",
    "VZ",
    "CMCSA",
    "XOM",
    "CVX",
    "COP",
    "CAT",
    "BA",
    "GE",
    "UPS",
    "FDX",
    "DE",
    "UNH",
    "LLY",
    "MRK",
    "ABBV",
    "JNJ",
    "PFE",
    "UBER",
    "BKNG",
    # ETF shortcuts
    "SPY",
    "QQQ",
    "DIA",
    "IWM",
]

# -------------------------------------------------------------------
# Helper: yfinance download + simple caching
# -------------------------------------------------------------------

_quotes_cache: Dict[str, Any] = {
    "ts": 0.0,
    "rows": [],  # list of {symbol, price, change_pct}
}


async def _download_quotes(symbols: List[str]) -> Dict[str, Dict[str, float]]:
    """
    Download last and previous daily close for a list of symbols.
    Returns mapping: {symbol: {"last": float, "prev": float}}
    """

    def _run() -> Dict[str, Dict[str, float]]:
        if not symbols:
            return {}
        data = yf.download(
            tickers=" ".join(symbols),
            period="2d",
            interval="1d",
            group_by="ticker",
            auto_adjust=False,
            progress=False,
        )

        out: Dict[str, Dict[str, float]] = {}

        # yfinance returns different shapes for 1 vs many tickers
        if getattr(data, "columns", None) is not None and hasattr(
            data.columns, "levels"
        ):
            # MultiIndex (many tickers)
            for sym in symbols:
                if sym not in data.columns.levels[0]:
                    continue
                df = data[sym].dropna()
                if len(df) == 0:
                    continue
                last = float(df["Close"].iloc[-1])
                prev = float(df["Close"].iloc[-2]) if len(df) > 1 else last
                out[sym] = {"last": last, "prev": prev}
        else:
            # single symbol
            df = data.dropna()
            if len(df) > 0:
                last = float(df["Close"].iloc[-1])
                prev = float(df["Close"].iloc[-2]) if len(df) > 1 else last
                out[symbols[0]] = {"last": last, "prev": prev}

        return out

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run)


async def _get_ticker_rows() -> List[Dict[str, Any]]:
    """
    Return list of {symbol, price, change_pct}, cached for ~60s.
    """
    now = time.time()
    if now - _quotes_cache["ts"] < 60 and _quotes_cache["rows"]:
        return _quotes_cache["rows"]

    try:
        qmap = await _download_quotes(TICKERS)
    except Exception:
        qmap = {}

    rows: List[Dict[str, Any]] = []
    for sym in TICKERS:
        q = qmap.get(sym)
        if not q:
            rows.append({"symbol": sym, "price": None, "change_pct": 0.0})
            continue
        last = q["last"]
        prev = q["prev"] or last
        change_pct = ((last - prev) / prev * 100.0) if prev else 0.0
        rows.append(
            {
                "symbol": sym,
                "price": round(last, 4),
                "change_pct": change_pct,
            }
        )

    _quotes_cache["ts"] = now
    _quotes_cache["rows"] = rows
    return rows


# -------------------------------------------------------------------
# Helper: Yahoo Finance news
# -------------------------------------------------------------------

async def _get(url: str, params: Optional[Dict[str, Any]] = None) -> Optional[httpx.Response]:
    try:
        resp = await _http_client.get(url, params=params)
        if resp.status_code != 200:
            return None
        return resp
    except Exception:
        return None


def _map_yahoo_news_item(item: Dict[str, Any]) -> Dict[str, Any]:
    link = item.get("link") or item.get("linkUrl") or ""
    title = item.get("title") or item.get("headline") or ""
    source = item.get("publisher") or item.get("provider") or ""
    ts = item.get("providerPublishTime") or item.get("pubDate")
    published = ""
    if isinstance(ts, (int, float)):
        try:
            published = time.strftime("%Y-%m-%d %H:%M", time.gmtime(ts))
        except Exception:
            published = ""
    return {
        "title": title,
        "url": link,
        "source": source,
        "published_at": published,
    }


async def symbol_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    """
    Try multiple Yahoo search queries for the symbol.
    If all fail or return nothing, fall back to generic market news.
    """
    queries = [
        symbol,
        f"{symbol} stock",
        f"{symbol} stock news",
    ]
    for q in queries:
        resp = await _get(
            "https://query1.finance.yahoo.com/v1/finance/search",
            {"q": q, "quotesCount": 0, "newsCount": limit},
        )
        if not resp:
            continue
        try:
            payload = resp.json()
            news = payload.get("news", []) or []
        except Exception:
            news = []
        if news:
            return [_map_yahoo_news_item(n) for n in news[:limit]]

    # Fallback to generic headlines
    return await market_news(limit=limit)


async def market_news(limit: int = 40) -> List[Dict[str, Any]]:
    """
    Generic US market headlines using Yahoo search with broad queries.
    """
    queries = [
        "US stock market today",
        "US stocks",
        "Wall Street stocks",
    ]
    seen_links = set()
    out: List[Dict[str, Any]] = []
    for q in queries:
        resp = await _get(
            "https://query1.finance.yahoo.com/v1/finance/search",
            {"q": q, "quotesCount": 0, "newsCount": limit},
        )
        if not resp:
            continue
        try:
            payload = resp.json()
            news = payload.get("news", []) or []
        except Exception:
            news = []
        for item in news:
            mapped = _map_yahoo_news_item(item)
            if mapped["url"] and mapped["url"] not in seen_links:
                seen_links.add(mapped["url"])
                out.append(mapped)
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    return out


# -------------------------------------------------------------------
# Helper: metrics / performance + company description
# -------------------------------------------------------------------

async def symbol_metrics(symbol: str) -> Dict[str, Any]:
    """
    Return:
      {
        "symbol": "AAPL",
        "performance": { "1W": float|None, ... },
        "profile": { "description": str }
      }
    """

    def _run_hist() -> Dict[str, Any]:
        hist = yf.download(
            symbol,
            period="2y",
            interval="1d",
            auto_adjust=False,
            progress=False,
        )
        result: Dict[str, Any] = {
            "performance": {},
            "profile": {"description": ""},
        }
        if hist is None or hist.empty:
            return result

        closes = hist["Close"].dropna()
        if closes.empty:
            return result

        last_date = closes.index[-1]
        last_price = float(closes.iloc[-1])

        from datetime import timedelta, datetime

        def pct_from(days: int) -> Optional[float]:
            if days <= 0:
                return None
            cutoff = last_date - timedelta(days=days)
            past = closes[closes.index >= cutoff]
            if past.empty:
                return None
            base = float(past.iloc[0])
            if base == 0:
                return None
            return (last_price - base) / base * 100.0

        perf_map: Dict[str, Optional[float]] = {
            "1W": pct_from(7),
            "1M": pct_from(30),
            "3M": pct_from(90),
            "6M": pct_from(180),
            "YTD": None,
            "1Y": pct_from(365),
        }

        # YTD: price from first trading day of the year
        try:
            year_start = datetime(
                last_date.year, 1, 1, tzinfo=getattr(last_date, "tzinfo", None)
            )
            past = closes[closes.index >= year_start]
            if not past.empty:
                base = float(past.iloc[0])
                if base != 0:
                    perf_map["YTD"] = (last_price - base) / base * 100.0
        except Exception:
            pass

        result["performance"] = perf_map

        # company description
        try:
            info = yf.Ticker(symbol).get_info()
            desc = info.get("longBusinessSummary") or ""
            if desc:
                result["profile"]["description"] = desc
        except Exception:
            pass

        return result

    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _run_hist)


# -------------------------------------------------------------------
# Routes
# -------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def root():
    """
    Serve the main SPA HTML.
    We search for index.html in several common locations so the app
    still works if the file is in templates/ or static/.
    """
    candidates = [
        BASE_DIR / "index.html",
        BASE_DIR / "templates" / "index.html",
        BASE_DIR / "static" / "index.html",
        BASE_DIR / "public" / "index.html",
    ]

    for path in candidates:
        if path.exists():
            return HTMLResponse(path.read_text(encoding="utf-8"))

    # If nothing found, show a clear error
    msg = "<h1>index.html not found</h1><p>Looked in:</p><ul>"
    for p in candidates:
        msg += f"<li>{p}</li>"
    msg += "</ul>"
    return HTMLResponse(msg, status_code=500)


@app.get("/api/tickers")
async def api_tickers():
    rows = await _get_ticker_rows()
    return JSONResponse(rows)


@app.get("/api/movers")
async def api_movers():
    rows = await _get_ticker_rows()
    valid = [r for r in rows if r["price"] is not None]
    sorted_rows = sorted(valid, key=lambda r: r["change_pct"])
    losers = sorted_rows[:5]
    gainers = sorted_rows[-5:][::-1]
    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    try:
        data = await symbol_metrics(symbol)
    except Exception:
        data = {"performance": {}, "profile": {"description": ""}}
    data["symbol"] = symbol
    return JSONResponse(data)


@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    try:
        data = await symbol_news(symbol, limit=30)
    except Exception:
        data = []
    return JSONResponse(data)


@app.get("/api/market-news")
async def api_market_news():
    try:
        data = await market_news(limit=40)
    except Exception:
        data = []
    return JSONResponse(data)


# -------------------------------------------------------------------
# Local dev entrypoint
# -------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
