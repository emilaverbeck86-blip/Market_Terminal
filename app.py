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
# Config / watchlist
# -------------------------------------------------

# Large US-centric watchlist for ticker bar + movers
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
    # index ETFs (for shortcuts / bar)
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
TTL = {"tickers": 5, "mktnews": 180}  # ticker refresh every 5s


def now() -> float:
    return time.time()


async def _get(
    url: str, params: Dict[str, Any] | None = None, timeout: float = 10.0
) -> httpx.Response | None:
    """
    Basic GET helper with reasonable timeout and user-agent.
    """
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
# Quote providers: Yahoo (primary) → Stooq (fallback)
# -------------------------------------------------
def _stooq_code(sym: str) -> str:
    # US stocks on Stooq usually end with .us
    return f"{sym.lower().replace('.', '-')}.us"


async def quotes_from_yahoo(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Fetch quotes from Yahoo Finance quote endpoint.
    """
    out: List[Dict[str, Any]] = []
    for i in range(0, len(symbols), 50):
        chunk = symbols[i : i + 50]
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
            change_pct = None
            if d:
                # price
                for key in ("regularMarketPrice", "postMarketPrice", "bid"):
                    if d.get(key) is not None:
                        price = float(d[key])
                        break
                # % change
                for key in (
                    "regularMarketChangePercent",
                    "postMarketChangePercent",
                    "regularMarketChange",
                ):
                    if d.get(key) is not None:
                        try:
                            # for regularMarketChange, need to divide by prev close
                            if key == "regularMarketChange" and d.get(
                                "regularMarketPreviousClose"
                            ):
                                change_pct = (
                                    float(d[key])
                                    / float(d["regularMarketPreviousClose"])
                                    * 100
                                )
                            else:
                                change_pct = float(d[key])
                        except Exception:
                            change_pct = None
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


async def quotes_from_stooq(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Daily snapshot from Stooq, used as fallback and for simple % calculations.
    """
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


async def stable_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Core quote function: Yahoo → Stooq, then normalize.
    Returns list of {symbol, price, change_pct} with change_pct=0 when unknown.
    """
    data = await quotes_from_yahoo(symbols)
    # if absolutely nothing has a price, fall back fully to Stooq
    if all(d["price"] is None for d in data):
        data = await quotes_from_stooq(symbols)
    else:
        # fill missing rows or missing prices from Stooq
        stooq = await quotes_from_stooq(symbols)
        by_s = {d["symbol"].upper(): d for d in stooq}
        for i, d in enumerate(data):
            if d["price"] is None:
                alt = by_s.get(d["symbol"].upper())
                if alt:
                    data[i]["price"] = alt["price"]
                    data[i]["change_pct"] = alt["change_pct"]

    # normalize & ensure change_pct is usable
    norm: List[Dict[str, Any]] = []
    by_symbol = {(d["symbol"] or "").upper(): d for d in data}
    for s in symbols:
        d = by_symbol.get(s.upper(), {"symbol": s, "price": None, "change_pct": None})
        price = d.get("price")
        change_pct = d.get("change_pct")
        if price is None:
            change_pct = None  # we really don't know
        elif change_pct is None:
            change_pct = 0.0   # treat as flat if we have price but no % info

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
# History / performance metrics (Stooq)
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
    "AAPL": (
        "Apple designs the iPhone, Mac, iPad and services such as the App Store, "
        "Apple Music and iCloud. Its tight hardware–software integration creates "
        "an ecosystem that keeps users inside the platform, and the company is "
        "gradually layering in more on-device AI to deepen engagement and services revenue."
    ),
    "MSFT": (
        "Microsoft operates the Windows and Office franchises and runs Azure, one of the "
        "largest public clouds. Subscriptions like Microsoft 365 add recurring revenue, "
        "and Copilot brings AI into productivity and developer workflows across the stack."
    ),
    "NVDA": (
        "NVIDIA builds GPUs and full platforms used to train and deploy large AI models. "
        "Its CUDA software ecosystem and data-center hardware give it a deep competitive "
        "moat as demand for accelerated computing and generative AI expands."
    ),
    "AMZN": (
        "Amazon combines a global e-commerce and logistics network with AWS, a leading "
        "cloud infrastructure provider. Advertising and subscription services such as "
        "Prime add high-margin, recurring revenue on top of the retail footprint."
    ),
    "META": (
        "Meta Platforms operates Facebook, Instagram and WhatsApp. The business is driven "
        "by targeted advertising, supported by large-scale AI ranking systems, while "
        "messaging and short-form video continue to deepen user engagement."
    ),
    "GOOGL": (
        "Alphabet owns Google Search, YouTube, Android and Google Cloud. Search and YouTube "
        "ads fund heavy investment into cloud infrastructure and AI products across the "
        "consumer and enterprise ecosystem."
    ),
}


async def profile(symbol: str) -> Dict[str, str]:
    desc = CURATED.get(
        symbol.upper(),
        "U.S. listed company. A concise profile is not available, but this placeholder "
        "keeps the layout consistent while the terminal focuses on prices and news.",
    )
    return {"symbol": symbol, "name": symbol, "description": desc}


# -------------------------------------------------
# News (ticker + market) via Yahoo finance search
# -------------------------------------------------
def _map_yahoo_news_item(n: Dict[str, Any]) -> Dict[str, Any]:
    link = n.get("link") or {}
    return {
        "title": n.get("title"),
        "url": link.get("url") or link.get("href"),
        "source": n.get("publisher") or "Yahoo Finance",
        "summary": "",
        "published_at": "",
    }


async def symbol_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    resp = await _get(
        "https://query1.finance.yahoo.com/v1/finance/search",
        {"q": symbol, "quotesCount": 0, "newsCount": limit},
    )
    if not resp:
        return []
    news = resp.json().get("news", []) or []
    return [_map_yahoo_news_item(n) for n in news[:limit]]


async def market_news(limit: int = 40) -> List[Dict[str, Any]]:
    resp = await _get(
        "https://query1.finance.yahoo.com/v1/finance/search",
        {"q": "markets", "quotesCount": 0, "newsCount": limit},
    )
    if not resp:
        return []
    news = resp.json().get("news", []) or []
    return [_map_yahoo_news_item(n) for n in news[:limit]]


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

    # Ensure every row has a numeric change_pct for ranking
    for v in valid:
        if v.get("change_pct") is None:
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
