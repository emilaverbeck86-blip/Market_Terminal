import os
import re
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any

import yfinance as yf
from fastapi import FastAPI, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

static_dir = os.path.join(BASE_DIR, "static")
templates_dir = os.path.join(BASE_DIR, "templates")

if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

templates = Jinja2Templates(directory=templates_dir)

analyzer = SentimentIntensityAnalyzer()

# ---------------------------------------------------------
# Config
# ---------------------------------------------------------
WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META",
    "GOOGL", "TSLA", "AVGO", "AMD", "NFLX",
    "ADBE", "INTC", "CSCO", "QCOM", "TXN",
    "JPM", "BAC", "WFC", "V", "MA",
    "KO", "PEP", "MCD", "HD", "XOM", "CVX",
]

SYMBOL_MAP: Dict[str, str] = {
    "SP500": "^GSPC",
    "NASDAQ": "^NDX",
}

INDEX_PROFILES: Dict[str, str] = {
    "SP500": (
        "The S&P 500 is a stock market index tracking the performance of 500 large "
        "publicly traded U.S. companies. It is a market-cap-weighted index covering "
        "all major sectors of the economy. Investors widely use it as a benchmark "
        "for U.S. large-cap equities and portfolio performance. The S&P 500 is "
        "maintained by S&P Dow Jones Indices. Many ETFs and index funds replicate "
        "its composition, making it central to passive investing."
    ),
    "NASDAQ": (
        "The Nasdaq-100 is an index of 100 of the largest non-financial companies "
        "listed on the Nasdaq Stock Market. It is heavily weighted toward technology, "
        "communication services, and consumer discretionary sectors. The index is "
        "popular with growth-oriented investors and is tracked by vehicles such as "
        "the Invesco QQQ ETF. It is often viewed as a proxy for the performance of "
        "large U.S. technology and innovation-driven companies."
    ),
}

TICKER_CACHE: Dict[str, Any] = {"ts": None, "data": None}
INSIGHTS_CACHE: Dict[str, Any] = {}
NEWS_CACHE: Dict[str, Any] = {}

CACHE_TTL_TICKERS = 60          # 1 minute
CACHE_TTL_INSIGHTS = 600        # 10 minutes
CACHE_TTL_NEWS = 300            # 5 minutes


# ---------------------------------------------------------
# Helpers
# ---------------------------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def truncate_sentences(text: str, max_sentences: int = 6) -> str:
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return " ".join(parts[:max_sentences])


def pct_change(old: float, new: float) -> float:
    if old is None or new is None or old == 0:
        return 0.0
    return (new - old) / old * 100.0


def map_symbol_for_yahoo(symbol: str) -> str:
    return SYMBOL_MAP.get(symbol.upper(), symbol)


def yahoo_history(symbol: str, period: str = "1y"):
    yf_sym = map_symbol_for_yahoo(symbol)
    t = yf.Ticker(yf_sym)
    return t.history(period=period, auto_adjust=False)


def get_watchlist_snapshot() -> List[Dict[str, Any]]:
    now = now_utc()
    if (
        TICKER_CACHE["data"] is not None
        and TICKER_CACHE["ts"] is not None
        and (now - TICKER_CACHE["ts"]).total_seconds() < CACHE_TTL_TICKERS
    ):
        return TICKER_CACHE["data"]

    data: List[Dict[str, Any]] = []
    for sym in WATCHLIST:
        try:
            hist = yahoo_history(sym, period="5d")
            if hist.empty or len(hist) < 2:
                last = prev = None
                chg = 0.0
            else:
                last = float(hist["Close"].iloc[-1])
                prev = float(hist["Close"].iloc[-2])
                chg = pct_change(prev, last)
            data.append({"symbol": sym, "price": last, "change_pct": chg})
        except Exception:
            data.append({"symbol": sym, "price": None, "change_pct": 0.0})

    TICKER_CACHE["ts"] = now
    TICKER_CACHE["data"] = data
    return data


def build_insights(symbol: str) -> Dict[str, Any]:
    now = now_utc()
    cache = INSIGHTS_CACHE.get(symbol)
    if cache and (now - cache["ts"]).total_seconds() < CACHE_TTL_INSIGHTS:
        return cache["data"]

    yf_sym = map_symbol_for_yahoo(symbol)
    t = yf.Ticker(yf_sym)

    try:
        hist = t.history(period="1y", auto_adjust=False)
    except Exception:
        hist = None

    def price_at(delta_days: int | None) -> float | None:
        if hist is None or hist.empty:
            return None
        if delta_days is None:
            year_start = datetime(now.year, 1, 1, tzinfo=hist.index.tz)
            sub = hist[hist.index >= year_start]
            if sub.empty:
                return float(hist["Close"].iloc[0])
            return float(sub["Close"].iloc[0])
        target = now - timedelta(days=delta_days)
        sub = hist[hist.index <= target]
        if sub.empty:
            return float(hist["Close"].iloc[0])
        return float(sub["Close"].iloc[-1])

    last_price = None
    if hist is not None and not hist.empty:
        last_price = float(hist["Close"].iloc[-1])

    if last_price is not None:
        perf = {
            "1W": pct_change(price_at(7), last_price),
            "1M": pct_change(price_at(30), last_price),
            "3M": pct_change(price_at(90), last_price),
            "6M": pct_change(price_at(180), last_price),
            "YTD": pct_change(price_at(None), last_price),
            "1Y": pct_change(price_at(365), last_price),
        }
    else:
        perf = {k: 0.0 for k in ["1W", "1M", "3M", "6M", "YTD", "1Y"]}

    if symbol.upper() in INDEX_PROFILES:
        description = INDEX_PROFILES[symbol.upper()]
    else:
        try:
            info = t.info or {}
            description = info.get("longBusinessSummary") or info.get("longName") or ""
        except Exception:
            description = ""

    description = truncate_sentences(description, max_sentences=6)

    result = {"symbol": symbol, "periods": perf, "description": description}
    INSIGHTS_CACHE[symbol] = {"ts": now, "data": result}
    return result


def build_news_from_yf_news(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for n in items or []:
        try:
            title = n.get("title") or ""
            link = n.get("link") or n.get("url") or ""
            provider = ""
            if isinstance(n.get("provider"), list) and n["provider"]:
                provider = n["provider"][0].get("name", "")
            elif isinstance(n.get("publisher"), str):
                provider = n["publisher"]
            ts = n.get("providerPublishTime") or n.get("published_time") or None
            if isinstance(ts, (int, float)):
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                published_at = dt.strftime("%Y-%m-%d %H:%M")
            else:
                published_at = ""
            parsed.append(
                {
                    "title": title,
                    "url": link,
                    "source": provider,
                    "published_at": published_at,
                }
            )
        except Exception:
            continue
    return parsed


def get_market_news() -> List[Dict[str, Any]]:
    now = now_utc()
    key = "market:US"
    cache = NEWS_CACHE.get(key)
    if cache and (now - cache["ts"]).total_seconds() < CACHE_TTL_NEWS:
        return cache["data"]

    try:
        t = yf.Ticker("SPY")
        raw = t.news or []
    except Exception:
        raw = []

    data = build_news_from_yf_news(raw)
    NEWS_CACHE[key] = {"ts": now, "data": data}
    return data


def get_symbol_news(symbol: str) -> List[Dict[str, Any]]:
    now = now_utc()
    key = f"sym:{symbol.upper()}"
    cache = NEWS_CACHE.get(key)
    if cache and (now - cache["ts"]).total_seconds() < CACHE_TTL_NEWS:
        return cache["data"]

    yf_sym = map_symbol_for_yahoo(symbol)
    try:
        t = yf.Ticker(yf_sym)
        raw = t.news or []
    except Exception:
        raw = []

    data = build_news_from_yf_news(raw)

    # Fallback: if no symbol-specific news, show broad US market news
    if not data:
        data = get_market_news()

    NEWS_CACHE[key] = {"ts": now, "data": data}
    return data


# ---------------------------------------------------------
# Routes
# ---------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers():
    data = get_watchlist_snapshot()
    return JSONResponse(data)


@app.get("/api/movers")
async def api_movers(limit: int = 5):
    snapshot = get_watchlist_snapshot()
    valid = [x for x in snapshot if x["price"] is not None]
    sorted_by_change = sorted(valid, key=lambda x: x["change_pct"])
    losers = sorted_by_change[:limit]
    gainers = list(reversed(sorted_by_change[-limit:]))
    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)):
    yf_sym = map_symbol_for_yahoo(symbol)
    t = yf.Ticker(yf_sym)
    try:
        hist = t.history(period="5d")
        if hist.empty or len(hist) < 2:
            price = prev = None
            chg = 0.0
        else:
            price = float(hist["Close"].iloc[-1])
            prev = float(hist["Close"].iloc[-2])
            chg = pct_change(prev, price)
    except Exception:
        price = prev = None
        chg = 0.0

    return JSONResponse(
        {"symbol": symbol, "price": price, "previous_close": prev, "change_pct": chg}
    )


@app.get("/api/insights")
async def api_insights(symbol: str = Query(...)):
    data = build_insights(symbol)
    return JSONResponse(data)


@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    data = get_symbol_news(symbol)
    return JSONResponse(data)


@app.get("/api/market-news")
async def api_market_news():
    data = get_market_news()
    return JSONResponse(data)


@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    headlines = get_symbol_news(symbol)[:10]
    text = ". ".join(h["title"] for h in headlines if h.get("title"))
    if not text:
        return JSONResponse({"compound": 0.0})
    score = analyzer.polarity_scores(text)
    return JSONResponse({"compound": score["compound"]})
