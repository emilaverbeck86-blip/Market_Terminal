from __future__ import annotations
import os, io, csv, math, time, asyncio, datetime as dt
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---------- Paths / App ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------- Settings ----------
# Optional providers (kept for news/profile fallback)
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()

# Symbols known to render on TradingView with our mapping
WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT",
    "SPY","QQQ"
]

# ---------- Cache ----------
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 60, "market_news": 180}

# ---------- Utilities ----------
def _safe_float(x) -> Optional[float]:
    try:
        f = float(x)
        if math.isnan(f) or math.isinf(f): return None
        return f
    except Exception:
        return None

def _pct(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None, 0, None): return None
    return (last - prev) / prev * 100.0

def _stooq_symbol(sym: str) -> str:
    # map e.g. BRK-B -> brk-b.us
    return f"{sym.lower().replace('.', '-').replace('_', '-')}.us"

async def _fetch_text(url: str, params: dict | None = None) -> Optional[str]:
    headers = {"User-Agent": "MarketTerminal/1.0"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0)) as client:
            r = await client.get(url, params=params, headers=headers)
            if r.status_code == 200:
                return r.text
    except Exception:
        pass
    return None

async def _stooq_last_prev(sym: str) -> Dict[str, Optional[float]]:
    url = "https://stooq.com/q/d/l/"
    params = {"s": _stooq_symbol(sym), "i": "d"}
    txt = await _fetch_text(url, params)
    if not txt:
        return {"last": None, "prev": None}
    rows = list(csv.reader(io.StringIO(txt)))
    if rows and rows[0] and rows[0][0].lower() == "date":
        rows = rows[1:]
    if not rows:
        return {"last": None, "prev": None}
    try:
        last = _safe_float(rows[-1][4]) if len(rows[-1]) >= 5 else None
        prev = _safe_float(rows[-2][4]) if len(rows) >= 2 and len(rows[-2]) >= 5 else None
        return {"last": last, "prev": prev}
    except Exception:
        return {"last": None, "prev": None}

async def _stooq_history(sym: str, days: int = 800) -> pd.Series:
    """Return Close series (pandas) for ~N past calendar days via Stooq."""
    url = "https://stooq.com/q/d/l/"
    params = {"s": _stooq_symbol(sym), "i": "d"}
    txt = await _fetch_text(url, params)
    if not txt:
        return pd.Series(dtype=float)
    df = pd.read_csv(io.StringIO(txt))
    if df.empty or "Close" not in df:
        return pd.Series(dtype=float)
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"]).set_index("Date").sort_index()
    # last ~N business days
    if len(df) > days:
        df = df.iloc[-days:]
    return df["Close"].astype(float)

# ---------- Batch quotes (Stooq-first) ----------
async def _batch_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    sem = asyncio.Semaphore(12)
    async def one(sym: str):
        async with sem:
            dp = await _stooq_last_prev(sym)
            chg = _pct(dp["last"], dp["prev"])
            return {
                "symbol": sym,
                "price": round(dp["last"], 2) if dp["last"] is not None else None,
                "change_pct": round(chg, 2) if chg is not None else None
            }
    results = await asyncio.gather(*[one(s) for s in symbols], return_exceptions=True)
    out: List[Dict[str, Any]] = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            out.append({"symbol": symbols[i], "price": None, "change_pct": None})
        else:
            out.append(r)
    return out

def _movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    v = [r for r in rows if isinstance(r.get("change_pct"), (int, float))]
    v.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": v[:8], "losers": list(reversed(v[-8:]))}

# ---------- News providers (Finnhub -> NewsAPI -> fallback None) ----------
async def _finnhub_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    if not FINNHUB_API_KEY:
        return []
    try:
        end = dt.date.today()
        start = end - dt.timedelta(days=30)
        url = "https://finnhub.io/api/v1/company-news"
        params = {"symbol": symbol, "from": start.isoformat(), "to": end.isoformat(), "token": FINNHUB_API_KEY}
        async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4)) as client:
            r = await client.get(url, params=params)
        if r.status_code != 200:
            return []
        data = r.json()
        out=[]
        for a in data[:limit]:
            out.append({"title": a.get("headline"), "url": a.get("url"),
                        "source": a.get("source"), "summary": a.get("summary") or "",
                        "published_at": a.get("datetime")})
        return out
    except Exception:
        return []

async def _newsapi_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    if not NEWS_API_KEY:
        return []
    try:
        url="https://newsapi.org/v2/everything"
        params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":limit}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4)) as client:
            r=await client.get(url, params=params, headers=headers)
        if r.status_code!=200: return []
        data=r.json()
        out=[]
        for a in data.get("articles", []):
            out.append({"title":a.get("title"),"url":a.get("url"),
                        "source":(a.get("source") or {}).get("name"),
                        "summary":a.get("description"),"published_at":a.get("publishedAt")})
        return out
    except Exception:
        return []

async def _market_news(limit: int = 30) -> List[Dict[str, Any]]:
    # Finnhub general
    if FINNHUB_API_KEY:
        try:
            url="https://finnhub.io/api/v1/news"
            params={"category":"general","minId":0,"token":FINNHUB_API_KEY}
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4)) as client:
                r=await client.get(url, params=params)
            if r.status_code==200:
                data=r.json()[:limit]
                return [{"title":a.get("headline"),"url":a.get("url"),
                         "source":a.get("source"),"summary":a.get("summary") or "",
                         "published_at":a.get("datetime")} for a in data]
        except Exception:
            pass
    # NewsAPI business
    if NEWS_API_KEY:
        try:
            url="https://newsapi.org/v2/top-headlines"
            params={"country":"us","category":"business","pageSize":limit}
            headers={"X-Api-Key": NEWS_API_KEY}
            async with httpx.AsyncClient(timeout=httpx.Timeout(8, connect=4)) as client:
                r=await client.get(url, params=params, headers=headers)
            if r.status_code==200:
                data=r.json()
                return [{"title":a.get("title"),"url":a.get("url"),
                         "source":(a.get("source") or {}).get("name"),
                         "summary":a.get("description"),"published_at":a.get("publishedAt")}
                        for a in data.get("articles", [])]
        except Exception:
            pass
    return []

# ---------- Profile (best-effort) ----------
async def _profile(symbol: str) -> Dict[str, str]:
    # We avoid yfinance to keep things snappy/robust on Render
    # Simple mapping for popular ETFs
    names = {"SPY":"SPDR S&P 500 ETF Trust","QQQ":"Invesco QQQ Trust"}
    if symbol in names:
        return {"symbol": symbol, "name": names[symbol],
                "description": "An exchange-traded fund tracking a major US equity index."}
    return {"symbol": symbol, "name": symbol, "description": "No profile available at this time."}

# ---------- Insights from Stooq history ----------
def _period_return(close: pd.Series, bdays: int) -> Optional[float]:
    if close is None or close.empty: return None
    # Use last business-day index back bdays
    end_idx = close.index.max()
    # find index position bdays back
    prior = close.iloc[:-1] if len(close) > 1 else close
    if prior.empty: return None
    # approximate: take nth item from end
    if len(close) <= bdays: return None
    start_price = close.iloc[-(bdays+1)]
    last_price = close.iloc[-1]
    if start_price in (None, 0) or pd.isna(start_price): return None
    return float((last_price - start_price) / start_price * 100.0)

def _seasonals_by_trading_day(close: pd.Series) -> Dict[str, List[List[float]]]:
    """Last 3 years overlayed by trading-day index (1..N) so starts align."""
    if close is None or close.empty: return {}
    years = sorted(list(set(close.index.year)))[-3:]
    out: Dict[str, List[List[float]]] = {}
    for y in years:
        seg = close[close.index.year == y].dropna()
        if seg.empty: continue
        base = float(seg.iloc[0])
        pts=[]
        for n, (_, val) in enumerate(seg.items(), start=1):
            pct = ((float(val) - base) / base * 100.0) if base else 0.0
            pts.append([n, pct])
        out[str(y)] = pts
    return out

# ---------- Routes ----------
@app.get("/api/health")
async def api_health():
    return JSONResponse({"ok": True, "time": dt.datetime.utcnow().isoformat()+"Z"})

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now = _now(); c = CACHE["tickers"]
    if c["data"] and now - c["ts"] < TTL["tickers"]:
        return JSONResponse(c["data"])
    data = await _batch_quotes(WATCHLIST)
    c["data"] = data; c["ts"] = now
    return JSONResponse(data)

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _batch_quotes(WATCHLIST)) or []
    return JSONResponse(_movers(rows))

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    # Try Finnhub → NewsAPI → empty (UI will show "No headlines")
    data = await _finnhub_news(symbol, 40)
    if not data:
        data = await _newsapi_news(symbol, 40)
    return JSONResponse(data or [])

@app.get("/api/market-news")
async def api_market_news():
    now = _now(); c = CACHE["market_news"]
    if c["data"] and now - c["ts"] < TTL["market_news"]:
        return JSONResponse(c["data"])
    data = await _market_news(60)
    c["data"] = data; c["ts"] = now
    return JSONResponse(data)

@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)):
    return JSONResponse(await _profile(symbol))

@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    try:
        close = await _stooq_history(symbol, days=800)
        if close is None or close.empty:
            raise RuntimeError("no history")
        perf = {
            "1W": _period_return(close, 5),
            "1M": _period_return(close, 21),
            "3M": _period_return(close, 63),
            "6M": _period_return(close, 126),
            "YTD": None,
            "1Y": _period_return(close, 252),
        }
        y = dt.datetime.utcnow().year
        yseg = close[close.index.year == y]
        if not yseg.empty:
            perf["YTD"] = float((close.iloc[-1] - yseg.iloc[0]) / yseg.iloc[0] * 100.0)
        seasonals = _seasonals_by_trading_day(close)
        return JSONResponse({"symbol": symbol, "performance": perf, "seasonals": seasonals})
    except Exception:
        return JSONResponse({"symbol": symbol,
                             "performance": {"1W":None,"1M":None,"3M":None,"6M":None,"YTD":None,"1Y":None},
                             "seasonals": {}})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
