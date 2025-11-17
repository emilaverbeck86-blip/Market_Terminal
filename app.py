from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import requests
import time
from typing import List, Dict, Any

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD", "NFLX", "ADBE",
    "INTC", "CSCO", "QCOM", "TXN", "CRM", "JPM", "BAC", "WFC", "GS", "V",
    "MA", "XOM", "CVX", "UNH", "LLY", "ABBV",
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0 Safari/537.36"
    )
}

LAST_QUOTES: Dict[str, Dict[str, Any]] = {}
LAST_QUOTES_TS: float = 0.0
QUOTE_TTL = 60.0  # seconds


# ---------- Helpers ----------


def stooq_quotes(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Fallback quote data from stooq.com (no API key, very generous limits).
    We only use close + open to compute an approximate daily % change.
    """
    out: Dict[str, Dict[str, Any]] = {}
    for sym in symbols:
        code = sym.lower() + ".us"
        url = f"https://stooq.com/q/l/?s={code}&f=sd2t2ohlcv&h&e=json"
        try:
            r = requests.get(url, timeout=5)
            r.raise_for_status()
            data = r.json()
            items = data.get("symbols") or []
            if not items:
                continue
            item = items[0]
            close = float(item.get("close") or 0)
            open_ = float(item.get("open") or 0) or close
            change_pct = ((close - open_) / open_ * 100.0) if open_ else 0.0
            out[sym] = {
                "symbol": sym,
                "price": close,
                "change_pct": change_pct,
            }
        except Exception:
            continue
    return out


def yahoo_quotes(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    Primary quote source: Yahoo Finance.
    If Yahoo rate-limits (HTTP 429) or fails, fall back to Stooq.
    Results are cached in memory for QUOTE_TTL seconds so we don't spam
    either source.
    """
    global LAST_QUOTES, LAST_QUOTES_TS

    now = time.time()
    if LAST_QUOTES and now - LAST_QUOTES_TS < QUOTE_TTL:
        return LAST_QUOTES

    params = {"symbols": ",".join(symbols)}
    quotes: Dict[str, Dict[str, Any]] = {}

    # 1) Try Yahoo
    try:
        r = requests.get(
            YAHOO_QUOTE_URL, params=params, headers=HEADERS, timeout=8
        )
        r.raise_for_status()
        data = r.json()
        result = data.get("quoteResponse", {}).get("result", [])
        for item in result:
            sym = item.get("symbol")
            if not sym:
                continue
            price = item.get("regularMarketPrice")
            change_pct = item.get("regularMarketChangePercent")
            if price is None:
                continue
            quotes[sym] = {
                "symbol": sym,
                "price": float(price),
                "change_pct": float(change_pct) if change_pct is not None else 0.0,
            }

        if quotes:
            LAST_QUOTES = quotes
            LAST_QUOTES_TS = now
            return quotes
    except Exception:
        # fall through to stooq
        pass

    # 2) Fallback: Stooq
    try:
        quotes = stooq_quotes(symbols)
        if quotes:
            LAST_QUOTES = quotes
            LAST_QUOTES_TS = now
            return quotes
    except Exception:
        pass

    # 3) Final fallback: last cached snapshot (might be empty)
    return LAST_QUOTES


def yahoo_news(symbol: str) -> List[Dict[str, Any]]:
    """
    Symbol-related headlines from Yahoo search API.
    If it fails we just return [] and the frontend shows 'No headlines'.
    """
    params = {"q": symbol, "quotesCount": 0, "newsCount": 20}
    try:
        r = requests.get(
            YAHOO_SEARCH_URL, params=params, headers=HEADERS, timeout=8
        )
        r.raise_for_status()
        data = r.json()
        out: List[Dict[str, Any]] = []
        for item in data.get("news", []):
            title = item.get("title")
            link = item.get("link")
            if not title or not link:
                continue
            publisher = item.get("publisher")
            provider = item.get("provider")
            time_published = (
                item.get("providerPublishTime") or item.get("pubDate") or ""
            )
            if isinstance(provider, dict):
                provider_name = provider.get("displayName") or publisher or ""
            else:
                provider_name = publisher or ""
            out.append(
                {
                    "title": title,
                    "link": link,
                    "source": provider_name,
                    "time": time_published,
                }
            )
        return out
    except Exception:
        return []


def yahoo_insights(symbol: str) -> Dict[str, Any]:
    """
    Very simple performance snapshot using Yahoo's chart API.
    If anything fails we just skip that range.
    """
    ranges = {
        "1W": "5d",
        "1M": "1mo",
        "3M": "3mo",
        "6M": "6mo",
        "YTD": "ytd",
        "1Y": "1y",
    }
    snapshot: Dict[str, Any] = {}
    for label, rng in ranges.items():
        url = f"{YAHOO_CHART_URL}{symbol}"
        params = {"range": rng, "interval": "1d"}
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=8)
            r.raise_for_status()
            data = r.json()
            result = data.get("chart", {}).get("result")
            if not result:
                continue
            result = result[0]
            closes = (
                result.get("indicators", {})
                .get("quote", [{}])[0]
                .get("close", [])
            )
            if not closes or len(closes) < 2:
                continue
            start = closes[0]
            end = closes[-1]
            if not start or not end:
                continue
            change_pct = (end - start) / start * 100.0
            snapshot[label] = round(change_pct, 2)
        except Exception:
            continue
    return snapshot


# ---------- Pages ----------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "watchlist": WATCHLIST},
    )


@app.get("/heatmap", response_class=HTMLResponse)
async def heatmap(request: Request):
    return templates.TemplateResponse("heatmap.html", {"request": request})


# ---------- API ----------


@app.get("/api/tickers")
async def api_tickers():
    try:
        quotes = yahoo_quotes(WATCHLIST)
        data = []
        for sym in WATCHLIST:
            q = quotes.get(sym)
            if q:
                data.append(q)
            else:
                data.append({"symbol": sym, "price": None, "change_pct": None})
        return {"tickers": data}
    except Exception:
        # never 500 here – just return empty so UI still works
        return JSONResponse({"tickers": []}, status_code=200)


@app.get("/api/movers")
async def api_movers():
    try:
        quotes = yahoo_quotes(WATCHLIST)
        vals = [q for q in quotes.values() if q.get("change_pct") is not None]
        if not vals:
            return {"gainers": [], "losers": []}
        sorted_vals = sorted(vals, key=lambda x: x["change_pct"])
        losers = sorted_vals[:5]
        gainers = list(reversed(sorted_vals[-5:]))
        return {"gainers": gainers, "losers": losers}
    except Exception:
        return {"gainers": [], "losers": []}


@app.get("/api/news")
async def api_news(symbol: str):
    items = yahoo_news(symbol)
    return {"news": items}


@app.get("/api/insights")
async def api_insights(symbol: str):
    try:
        snap = yahoo_insights(symbol)
    except Exception:
        snap = {}
    return {"performance": snap}
