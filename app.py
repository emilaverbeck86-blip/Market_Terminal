from __future__ import annotations

import os
import io
import csv
import time
import datetime as dt
from typing import Any, Dict, List

import httpx
import pandas as pd
from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# -------------------------------------------------
# Paths / FastAPI setup
# -------------------------------------------------
BASE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE, "static")
TEMPLATE_DIR = os.path.join(BASE, "templates")

os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATE_DIR, exist_ok=True)

app = FastAPI(title="Market Terminal")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATE_DIR)

# -------------------------------------------------
# Config / environment
# -------------------------------------------------
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()
TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "").strip()

# NASAQ / S&P etc. watchlist
WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA", "AVGO", "AMD", "NFLX",
    "ADBE", "INTC", "CSCO", "QCOM", "TXN",
    "CRM", "ORCL", "IBM", "NOW", "SNOW", "ABNB", "SHOP", "PYPL",
    "JPM", "BAC", "WFC", "GS", "MS", "V", "MA", "AXP", "BRK-B", "SCHW",
    "KO", "PEP", "PG", "MCD", "COST", "HD", "LOW", "DIS", "NKE", "SBUX", "TGT", "WMT",
    "T", "VZ", "CMCSA",
    "XOM", "CVX", "COP", "CAT", "BA", "GE", "UPS", "FDX", "DE",
    "UNH", "LLY", "MRK", "ABBV", "JNJ", "PFE",
    "UBER", "BKNG",
    "SPY", "QQQ", "DIA", "IWM",
]

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "mktnews": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 25, "mktnews": 180}


def now() -> float:
    return time.time()


async def _get(url: str, params: Dict[str, Any] | None = None, timeout: float = 10.0):
    try:
        async with httpx.AsyncClient(
            headers=BASE_HEADERS, timeout=httpx.Timeout(timeout, connect=4)
        ) as client:
            resp = await client.get(url, params=params)
            if resp.status_code == 200:
                return resp
    except Exception:
        pass
    return None


# -------------------------------------------------
# Quote providers: Yahoo → Stooq → TwelveData
# -------------------------------------------------
def _stooq_code(sym: str) -> str:
    return f"{sym.lower().replace('.', '-')}.us"


async def _from_yahoo(symbols: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i in range(0, len(symbols), 35):
        chunk = symbols[i : i + 35]
        resp = await _get(
            "https://query1.finance.yahoo.com/v7/finance/quote",
            {"symbols": ",".join(chunk)},
        )
        items = (
            resp.json().get("quoteResponse", {}).get("result", []) if resp else []
        )
        by_sym = {
            (d.get("symbol") or "").upper(): d
            for d in items
            if d.get("symbol")
        }
        for s in chunk:
            d = by_sym.get(s.upper())
            price = None
            if d:
                for key in ("regularMarketPrice", "postMarketPrice", "bid"):
                    if d.get(key) is not None:
                        price = float(d[key])
                        break
            change_pct = None
            if d:
                for key in ("regularMarketChangePercent", "postMarketChangePercent"):
                    if d.get(key) is not None:
                        change_pct = float(d[key])
                        break
            out.append(
                {
                    "symbol": s,
                    "price": round(price, 2) if price is not None else None,
                    "change_pct": round(change_pct, 2)
                    if change_pct is not None
                    else None,
                }
            )
    return out


async def _from_stooq(symbols: List[str]) -> List[Dict[str, Any]]:
    resp = await _get(
        "https://stooq.com/q/l/",
        {"s": ",".join(_stooq_code(s) for s in symbols), "f": "sd2t2ohlc"},
    )
    out = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    if not resp:
        return out
    rows = {
        (row.get("Symbol") or "").strip().lower(): row
        for row in csv.DictReader(io.StringIO(resp.text))
    }
    for idx, s in enumerate(symbols):
        row = rows.get(_stooq_code(s))
        if not row:
            continue
        try:
            c = None if row["Close"] in ("", "-") else float(row["Close"])
            o = None if row["Open"] in ("", "-") else float(row["Open"])
            price = round(c, 2) if c is not None else None
            change_pct = (
                round(((c - o) / o) * 100, 2)
                if c not in (None, 0) and o not in (None, 0)
                else None
            )
            out[idx] = {"symbol": s, "price": price, "change_pct": change_pct}
        except Exception:
            pass
    return out


async def _from_twelvedata(symbols: List[str]) -> List[Dict[str, Any]]:
    out = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    if not TWELVEDATA_API_KEY:
        return out
    resp = await _get(
        "https://api.twelvedata.com/quote",
        {"symbol": ",".join(symbols), "apikey": TWELVEDATA_API_KEY},
    )
    if not resp:
        return out
    js = resp.json()
    for i, s in enumerate(symbols):
        node = js.get(s) if isinstance(js, dict) else None
        if not node:
            continue
        try:
            price = float(node.get("price")) if node.get("price") else None
            pct = node.get("percent_change") or node.get("change_percent")
            change_pct = float(pct) if pct not in (None, "") else None
        except Exception:
            price, change_pct = None, None
        out[i].update(
            {
                "price": round(price, 2) if price is not None else None,
                "change_pct": round(change_pct, 2)
                if change_pct is not None
                else None,
            }
        )
    return out


async def stable_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Fetch quotes from Yahoo → Stooq → TwelveData with a strict normalization step
    so every requested symbol has a row and any missing change_pct becomes 0.0.
    """
    # 1) Yahoo
    data = await _from_yahoo(symbols)
    if all(d["price"] is None for d in data):
        # 2) Stooq
        data = await _from_stooq(symbols)
    if all(d["price"] is None for d in data):
        # 3) TwelveData
        data = await _from_twelvedata(symbols)

    norm: List[Dict[str, Any]] = []
    for s in symbols:
        row = next(
            (d for d in data if (d.get("symbol") or "").upper() == s.upper()), None
        )
        price = row.get("price") if row else None
        change_pct = row.get("change_pct") if row else None

        if price is None:
            change_pct = None
        elif change_pct is None:
            change_pct = 0.0

        norm.append(
            {
                "symbol": s,
                "price": round(price, 2) if isinstance(price, (int, float)) else None,
                "change_pct": round(change_pct, 2)
                if isinstance(change_pct, (int, float))
                else change_pct,
            }
        )
    return norm


# -------------------------------------------------
# History / metrics
# -------------------------------------------------
async def stooq_history(sym: str, days: int = 800) -> pd.Series:
    resp = await _get(
        "https://stooq.com/q/d/l/",
        {"s": _stooq_code(sym), "i": "d"},
    )
    if not resp:
        return pd.Series(dtype=float)
    df = pd.read_csv(io.StringIO(resp.text))
    if df.empty or "Close" not in df:
        return pd.Series(dtype=float)
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"]).set_index("Date").sort_index()
    if len(df) > days:
        df = df.iloc[-days:]
    return df["Close"].astype(float)


def pct(close: pd.Series, bdays: int):
    if close is None or close.empty or len(close) <= bdays:
        return None
    a = close.iloc[-(bdays + 1)]
    b = close.iloc[-1]
    return None if not a else float((b - a) / a * 100)


CURATED: Dict[str, str] = {
    "AAPL": "Apple designs iPhone, Mac and services like the App Store, Music and iCloud. "
    "It drives retention with tight hardware–software integration and is rolling out "
    "on-device AI to deepen engagement.",
    "MSFT": "Microsoft runs Windows, Office and Azure. Cloud subscriptions are the main "
    "growth engine, and Copilot brings AI into productivity and developer tools.",
    "NVDA": "NVIDIA builds GPUs and full AI platforms used to train and run large models. "
    "Its CUDA software ecosystem and data-center chips are a major competitive moat.",
    "AMZN": "Amazon combines a massive logistics network with the high-margin AWS cloud "
    "business. Ads and subscriptions like Prime add recurring, sticky revenue.",
    "META": "Meta operates Facebook, Instagram and WhatsApp. Ads remain core, supported "
    "by AI-driven feed ranking, while messaging continues to deepen user engagement.",
    "GOOGL": "Alphabet spans Search, YouTube, Android and Google Cloud. Search and ads "
    "fund heavy investment into cloud and AI products across the portfolio.",
}


async def profile(symbol: str) -> Dict[str, str]:
    desc = CURATED.get(
        symbol.upper(),
        "U.S. listed company. A detailed profile is not available, but this placeholder "
        "keeps the panel readable and consistent across tickers.",
    )
    return {"symbol": symbol, "name": symbol, "description": desc}


# -------------------------------------------------
# News (symbol + market)
# -------------------------------------------------
async def symbol_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    # 1) Finnhub company news (last 7 days)
    if FINNHUB_API_KEY:
        today = dt.date.today()
        frm = (today - dt.timedelta(days=7)).isoformat()
        resp = await _get(
            "https://finnhub.io/api/v1/company-news",
            {
                "symbol": symbol,
                "from": frm,
                "to": today.isoformat(),
                "token": FINNHUB_API_KEY,
            },
        )
        if resp:
            js = resp.json()
            return [
                {
                    "title": a.get("headline"),
                    "url": a.get("url"),
                    "source": a.get("source"),
                    "summary": a.get("summary") or "",
                    "published_at": a.get("datetime"),
                }
                for a in js[:limit]
            ]

    # 2) NewsAPI (keyword search)
    if NEWS_API_KEY:
        resp = await _get(
            "https://newsapi.org/v2/everything",
            {
                "q": symbol,
                "language": "en",
                "pageSize": limit,
                "apiKey": NEWS_API_KEY,
            },
        )
        if resp:
            data = resp.json()
            return [
                {
                    "title": a.get("title"),
                    "url": a.get("url"),
                    "source": (a.get("source") or {}).get("name"),
                    "summary": a.get("description"),
                    "published_at": a.get("publishedAt"),
                }
                for a in data.get("articles", [])
            ]

    # 3) Yahoo search (no key)
    resp = await _get(
        "https://query1.finance.yahoo.com/v1/finance/search",
        {"q": symbol, "quotesCount": 0, "newsCount": limit},
    )
    if resp:
        news = resp.json().get("news", [])
        return [
            {
                "title": n.get("title"),
                "url": (n.get("link") or {}).get("url"),
                "source": n.get("publisher") or "Yahoo",
                "summary": "",
                "published_at": "",
            }
            for n in news
        ]
    return []


async def market_news(limit: int = 40) -> List[Dict[str, Any]]:
    # 1) Finnhub general news
    if FINNHUB_API_KEY:
        resp = await _get(
            "https://finnhub.io/api/v1/news",
            {"category": "general", "minId": 0, "token": FINNHUB_API_KEY},
        )
        if resp:
            js = resp.json()[:limit]
            return [
                {
                    "title": a.get("headline"),
                    "url": a.get("url"),
                    "source": a.get("source"),
                    "summary": a.get("summary") or "",
                    "published_at": a.get("datetime"),
                }
                for a in js
            ]

    # 2) NewsAPI business headlines
    if NEWS_API_KEY:
        resp = await _get(
            "https://newsapi.org/v2/top-headlines",
            {
                "country": "us",
                "category": "business",
                "pageSize": limit,
                "apiKey": NEWS_API_KEY,
            },
        )
        if resp:
            js = resp.json().get("articles", [])
            return [
                {
                    "title": a.get("title"),
                    "url": a.get("url"),
                    "source": (a.get("source") or {}).get("name"),
                    "summary": a.get("description"),
                    "published_at": a.get("publishedAt"),
                }
                for a in js
            ]

    # 3) Yahoo "markets" search
    resp = await _get(
        "https://query1.finance.yahoo.com/v1/finance/search",
        {"q": "markets", "quotesCount": 0, "newsCount": limit},
    )
    if resp:
        news = resp.json().get("news", [])
        return [
            {
                "title": n.get("title"),
                "url": (n.get("link") or {}).get("url"),
                "source": n.get("publisher") or "Yahoo",
                "summary": "",
                "published_at": "",
            }
            for n in news
        ]
    return []


# -------------------------------------------------
# Routes
# -------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    idx = os.path.join(TEMPLATE_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html missing", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/tickers")
async def api_tickers():
    cache = CACHE["tickers"]
    t = now()
    if cache["data"] and t - cache["ts"] < TTL["tickers"]:
        return JSONResponse(cache["data"])
    data = await stable_quotes(WATCHLIST)
    cache["data"] = data
    cache["ts"] = t
    return JSONResponse(data)


@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await stable_quotes(WATCHLIST))
    valid = [r for r in rows if r.get("price") is not None]

    need_recalc = [v for v in valid if v.get("change_pct") is None]
    # compute 1-day change from last two closes for those missing
    for v in need_recalc:
        try:
            series = await stooq_history(v["symbol"], days=3)
            if len(series) >= 2 and series.iloc[-2] != 0:
                v["change_pct"] = round(
                    (series.iloc[-1] - series.iloc[-2]) / series.iloc[-2] * 100, 2
                )
            else:
                v["change_pct"] = 0.0
        except Exception:
            v["change_pct"] = 0.0

    valid.sort(key=lambda x: (x.get("change_pct") or 0.0), reverse=True)
    gainers = valid[:10]
    losers = list(reversed(valid[-10:])) if valid else []
    return JSONResponse({"gainers": gainers, "losers": losers})


@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    close = await stooq_history(symbol, days=800)

    def ret(b: int):
        return pct(close, b)

    perf = {
        "1W": ret(5),
        "1M": ret(21),
        "3M": ret(63),
        "6M": ret(126),
        "YTD": None,
        "1Y": ret(252),
    }
    if not close.empty:
        year = dt.datetime.utcnow().year
        seg = close[close.index.year == year]
        if not seg.empty:
            perf["YTD"] = float(
                (close.iloc[-1] - seg.iloc[0]) / seg.iloc[0] * 100
            )

    prof = await profile(symbol)
    return JSONResponse({"symbol": symbol, "performance": perf, "profile": prof})


@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    return JSONResponse(await symbol_news(symbol, 30))


@app.get("/api/market-news")
async def api_marketnews():
    cache = CACHE["mktnews"]
    t = now()
    if cache["data"] and t - cache["ts"] < TTL["mktnews"]:
        return JSONResponse(cache["data"])
    data = await market_news(50)
    cache["data"] = data
    cache["ts"] = t
    return JSONResponse(data)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app:app",
        host="0.0.0.0",
        port=int(os.getenv("PORT", "8000")),
        workers=1,
    )
