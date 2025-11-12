from __future__ import annotations
import os, time, csv, io, asyncio, math, datetime as dt
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import httpx
import yfinance as yf
import pandas as pd

# ---------- Paths / App ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

load_dotenv(os.path.join(BASE_DIR, ".env"))
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()         # optional (NewsAPI)
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()   # optional (Finnhub)

app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------- Watchlist ----------
WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT"
]

# ---------- Cache ----------
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 60, "market_news": 180}

# ---------- Helpers ----------
def _safe_float(x) -> Optional[float]:
    try:
        f = float(x)
        return None if math.isnan(f) or math.isinf(f) else f
    except Exception:
        return None

def _pct(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None, 0):
        return None
    return (last - prev) / prev * 100.0

def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_', '-')}.us"

async def _stooq_last_prev(client: httpx.AsyncClient, sym: str) -> Dict[str, Optional[float]]:
    url = f"https://stooq.com/q/d/l/?s={_stooq_symbol(sym)}&i=d"
    try:
        r = await client.get(url, timeout=12)
        if r.status_code != 200 or not r.text:
            return {"last": None, "prev": None}
        rows = list(csv.reader(io.StringIO(r.text)))
        if rows and rows[0] and rows[0][0].lower() == "date":
            rows = rows[1:]
        if not rows:
            return {"last": None, "prev": None}
        last = _safe_float(rows[-1][4]) if len(rows[-1]) >= 5 else None
        prev = _safe_float(rows[-2][4]) if len(rows) >= 2 and len(rows[-2]) >= 5 else None
        return {"last": last, "prev": prev}
    except Exception:
        return {"last": None, "prev": None}

def _yf_last_prev(sym: str) -> Dict[str, Optional[float]]:
    last = prev = None
    try:
        t = yf.Ticker(sym)
        fi = getattr(t, "fast_info", None)
        if fi:
            for k in ("last_price","lastPrice","lastTradePrice","regularMarketPrice"):
                if k in fi: last = _safe_float(fi[k]); break
            for k in ("previous_close","previousClose","regularMarketPreviousClose"):
                if k in fi: prev = _safe_float(fi[k]); break
        if last is None or prev is None:
            hist = t.history(period="2d", interval="1d", auto_adjust=False)
            if hist is not None and not hist.empty:
                last = _safe_float(hist["Close"].iloc[-1])
                if len(hist) >= 2:
                    prev = _safe_float(hist["Close"].iloc[-2])
    except Exception:
        pass
    return {"last": last, "prev": prev}

async def _batch_quotes(symbols: List[str]) -> Optional[List[Dict[str, Any]]]:
    out: List[Dict[str, Any]] = []
    # Prefer Yahoo
    yahoo_rows: List[Dict[str, Any]] = []
    for s in symbols:
        dp = _yf_last_prev(s)
        chg = _pct(dp["last"], dp["prev"])
        yahoo_rows.append({
            "symbol": s,
            "price": round(dp["last"], 2) if dp["last"] is not None else None,
            "change_pct": round(chg, 2) if chg is not None else None
        })
    if any(isinstance(r.get("price"), (int,float)) for r in yahoo_rows):
        out = yahoo_rows
    else:
        # Fallback Stooq
        sem = asyncio.Semaphore(10)
        async with httpx.AsyncClient() as client:
            async def one(s: str):
                async with sem:
                    dp = await _stooq_last_prev(client, s)
                    chg = _pct(dp["last"], dp["prev"])
                    return {"symbol": s,
                            "price": round(dp["last"], 2) if dp["last"] is not None else None,
                            "change_pct": round(chg, 2) if chg is not None else None}
            res = await asyncio.gather(*[one(s) for s in symbols], return_exceptions=True)
        for i, r in enumerate(res):
            if isinstance(r, Exception):
                out.append({"symbol": symbols[i], "price": None, "change_pct": None})
            else:
                out.append(r)
    if not any(isinstance(r.get("price"), (int,float)) for r in out):
        return None
    return out

def _movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    v = [r for r in rows if isinstance(r.get("change_pct"), (int, float))]
    v.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": v[:8], "losers": list(reversed(v[-8:]))}

# ---------- News Providers ----------
def _yahoo_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    try:
        t = yf.Ticker(symbol)
        items = getattr(t, "news", None) or []
        out=[]
        for a in items[:limit]:
            out.append({"title": a.get("title"),
                        "url": a.get("link") or a.get("url"),
                        "source": (a.get("publisher") or "Yahoo"),
                        "summary": a.get("summary") or "",
                        "published_at": ""})
        return out
    except Exception:
        return []

async def _finnhub_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    if not FINNHUB_API_KEY: return []
    try:
        # Company news over recent window
        end = dt.date.today()
        start = end - dt.timedelta(days=30)
        url = "https://finnhub.io/api/v1/company-news"
        params = {"symbol": symbol, "from": start.isoformat(), "to": end.isoformat(), "token": FINNHUB_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(url, params=params)
        if r.status_code != 200: return []
        data = r.json()
        out=[]
        for a in data[:limit]:
            out.append({"title": a.get("headline"),
                        "url": a.get("url"),
                        "source": a.get("source"),
                        "summary": a.get("summary") or "",
                        "published_at": a.get("datetime")})
        return out
    except Exception:
        return []

async def _news_symbol(symbol: str, page_size: int = 30) -> List[Dict[str, Any]]:
    # 1) Finnhub (if key)  2) NewsAPI (if key)  3) Yahoo fallback
    first = await _finnhub_news(symbol, page_size)
    if first: return first

    if NEWS_API_KEY:
        try:
            url="https://newsapi.org/v2/everything"
            params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":page_size}
            headers={"X-Api-Key": NEWS_API_KEY}
            async with httpx.AsyncClient(timeout=12) as client:
                r=await client.get(url, params=params, headers=headers)
            if r.status_code==200:
                data=r.json(); out=[]
                for a in data.get("articles", []):
                    out.append({"title":a.get("title"),"url":a.get("url"),
                                "source":(a.get("source") or {}).get("name"),
                                "summary":a.get("description"),"published_at":a.get("publishedAt")})
                if out: return out
        except Exception:
            pass

    yn = _yahoo_news(symbol, page_size)
    return yn or [{"title":"No recent headlines found.","url":"#","source":"News"}]

async def _market_news(page_size: int = 30) -> List[Dict[str, Any]]:
    # Try Finnhub general news (category=general)
    if FINNHUB_API_KEY:
        try:
            url="https://finnhub.io/api/v1/news"
            params={"category":"general","minId":0,"token":FINNHUB_API_KEY}
            async with httpx.AsyncClient(timeout=12) as client:
                r=await client.get(url, params=params)
            if r.status_code==200:
                data=r.json()[:page_size]
                out=[]
                for a in data:
                    out.append({"title":a.get("headline"), "url":a.get("url"),
                                "source":a.get("source"), "summary":a.get("summary") or "",
                                "published_at":a.get("datetime")})
                if out: return out
        except Exception:
            pass

    # NewsAPI top-headlines (optional)
    if NEWS_API_KEY:
        try:
            url="https://newsapi.org/v2/top-headlines"
            params={"country":"us","category":"business","pageSize":page_size}
            headers={"X-Api-Key": NEWS_API_KEY}
            async with httpx.AsyncClient(timeout=12) as client:
                r=await client.get(url, params=params, headers=headers)
            if r.status_code==200:
                data=r.json(); out=[]
                for a in data.get("articles", []):
                    out.append({"title":a.get("title"),"url":a.get("url"),
                                "source":(a.get("source") or {}).get("name"),
                                "summary":a.get("description"),"published_at":a.get("publishedAt")})
                if out: return out
        except Exception:
            pass

    # Fallback: SPY news
    yn = _yahoo_news("SPY", page_size)
    return yn or [{"title":"No US market headlines right now.","url":"#","source":"News"}]

# ---------- Profile ----------
def _trim_sentences(text: str, limit: int = 420) -> str:
    if not text: return ""
    text = " ".join(text.split())
    if len(text) <= limit: return text
    enders = ".!?"
    cut = text[:limit+1]
    last = max(cut.rfind(ch) for ch in enders)
    if last < 60: return cut.rstrip() + "…"
    return cut[:last+1]

# ---------- Insights ----------
def _period_return(series: pd.Series, days: int) -> Optional[float]:
    if series is None or series.empty: return None
    end = series.dropna()
    if end.empty: return None
    last_idx = end.index.max()
    start_idx = last_idx - pd.tseries.offsets.BDay(days)
    start_series = end[end.index <= start_idx]
    if start_series.empty:
        return None
    start_price = start_series.iloc[-1]
    last_price = end.loc[last_idx]
    if start_price in (None, 0) or pd.isna(start_price): return None
    return float((last_price - start_price) / start_price * 100.0)

def _seasonals_by_trading_day(close: pd.Series) -> Dict[str, List[List[float]]]:
    """Return last 3 years as {YYYY: [[idx, pct], ...]} where idx = 1..N trading days since Jan-1."""
    if close is None or close.empty: return {}
    years = sorted(list(set(close.index.year)))[-3:]
    out: Dict[str, List[List[float]]] = {}
    for y in years:
        seg = close[close.index.year == y].dropna()
        if seg.empty: continue
        base = float(seg.iloc[0])
        pts: List[List[float]] = []
        for n, (ts, val) in enumerate(seg.items(), start=1):
            pct = ((float(val) - base) / base) * 100.0 if base else 0.0
            pts.append([n, pct])
        out[str(y)] = pts
    return out

@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    try:
        t = yf.Ticker(symbol)
        end = dt.datetime.utcnow()
        start = end - dt.timedelta(days=800)
        hist = t.history(start=start, end=end, interval="1d", auto_adjust=False)
        if hist is None or hist.empty:
            raise RuntimeError("no history")
        close = hist["Close"]
        perf = {
            "1W": _period_return(close, 5),
            "1M": _period_return(close, 21),
            "3M": _period_return(close, 63),
            "6M": _period_return(close, 126),
            "YTD": None,
            "1Y": _period_return(close, 252),
        }
        y = end.year
        ytd_seg = close[close.index.year == y]
        if not ytd_seg.empty:
            perf["YTD"] = float((close.iloc[-1] - ytd_seg.iloc[0]) / ytd_seg.iloc[0] * 100.0)
        seasonals = _seasonals_by_trading_day(close)
        return JSONResponse({"symbol": symbol, "performance": perf, "seasonals": seasonals})
    except Exception:
        return JSONResponse({"symbol": symbol, "performance": {"1W":None,"1M":None,"3M":None,"6M":None,"YTD":None,"1Y":None}, "seasonals": {}})

# ---------- Routes ----------
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
    if data is not None:
        c["data"] = data; c["ts"] = now
    return JSONResponse(c["data"] or [{"symbol": s, "price": None, "change_pct": None} for s in WATCHLIST])

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _batch_quotes(WATCHLIST)) or []
    return JSONResponse(_movers(rows))

@app.get("/api/news")
async def api_news(symbol: str = Query(...)): return JSONResponse(await _news_symbol(symbol))

@app.get("/api/market-news")
async def api_market_news():
    now = _now(); c = CACHE["market_news"]
    if c["data"] and now - c["ts"] < TTL["market_news"]:
        return JSONResponse(c["data"])
    data = await _market_news(50)
    c["data"] = data; c["ts"] = now
    return JSONResponse(data)

@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        analyzer = SentimentIntensityAnalyzer()
        news = await _news_symbol(symbol, page_size=30)
        vals = []
        for n in news:
            txt = (n.get("title") or "") + ". " + (n.get("summary") or "")
            vals.append(analyzer.polarity_scores(txt)["compound"])
        comp = sum(vals)/len(vals) if vals else 0.0
        return JSONResponse({"compound": comp})
    except Exception:
        return JSONResponse({"compound": 0.0})

@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)):
    try:
        t = yf.Ticker(symbol)
        info = t.get_info() or {}
        desc = info.get("longBusinessSummary") or info.get("description") or ""
        name = info.get("shortName") or info.get("longName") or symbol
        return JSONResponse({"symbol": symbol, "name": name, "description": _trim_sentences(desc)})
    except Exception:
        return JSONResponse({"symbol": symbol, "name": symbol, "description": "No description available right now."})

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
