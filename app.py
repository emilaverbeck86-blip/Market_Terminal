from __future__ import annotations
import os, io, csv, time, datetime as dt
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# --- paths / app ---
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

NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()

# A big, liquid watchlist to keep ticker bar full
WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","ORCL","IBM","NOW","SNOW","ABNB","SHOP","PYPL",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B","SCHW",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE","SBUX","TGT","WMT",
    "T","VZ","CMCSA","XOM","CVX","COP","CAT","BA","GE","UPS","FDX","DE",
    "UNH","LLY","MRK","ABBV","JNJ","PFE","UBER","BKNG","SPY","QQQ","DIA","IWM"
]

# --- caching ---
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 25, "market_news": 180}

UA = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}

async def _get(url: str, params: Dict[str, Any] | None = None, timeout: float = 8.0):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4.0), headers=UA) as client:
            r = await client.get(url, params=params)
            if r.status_code == 200:
                return r
    except Exception:
        pass
    return None

# ---------- Quotes: Yahoo primary, Stooq fallback ----------
async def _yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    # Yahoo public quote endpoint (no key)
    out: List[Dict[str, Any]] = []
    if not symbols: return out
    # batch up to ~40 symbols per call
    chunks = [symbols[i:i+40] for i in range(0, len(symbols), 40)]
    for ch in chunks:
        r = await _get("https://query1.finance.yahoo.com/v7/finance/quote",
                       params={"symbols": ",".join(ch)})
        if not r:
            continue
        data = r.json().get("quoteResponse", {}).get("result", [])
        by_sym = {d.get("symbol", "").upper(): d for d in data}
        for s in ch:
            q = by_sym.get(s.upper()) or by_sym.get(s.replace(".", "-").upper())
            price = q.get("regularMarketPrice") if q else None
            chg = q.get("regularMarketChangePercent") if q else None
            if price is not None:
                try: price = round(float(price), 2)
                except Exception: price = None
            if chg is not None:
                try: chg = round(float(chg), 2)
                except Exception: chg = None
            out.append({"symbol": s, "price": price, "change_pct": chg})
    # make sure length matches
    seen = {o["symbol"] for o in out}
    for s in symbols:
        if s not in seen:
            out.append({"symbol": s, "price": None, "change_pct": None})
    return out

def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_', '-')}.us"

async def _stooq_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    url = "https://stooq.com/q/l/"
    s_param = ",".join([_stooq_symbol(s) for s in symbols])
    r = await _get(url, params={"s": s_param, "f": "sd2t2ohlc"})
    out: List[Dict[str, Any]] = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    if not r:
        return out
    reader = csv.DictReader(io.StringIO(r.text))
    rows_by_sym = { (row.get("Symbol") or "").strip().lower(): row for row in reader }
    mapped: Dict[str, Dict[str, Any]] = {}
    for s in symbols:
        key = _stooq_symbol(s)
        row = rows_by_sym.get(key)
        price, chg = None, None
        try:
            if row:
                c = None if row.get("Close") in (None, "", "-") else float(row["Close"])
                o = None if row.get("Open")  in (None, "", "-") else float(row["Open"])
                if c is not None: price = round(c, 2)
                if c is not None and o not in (None, 0):
                    chg = round((c - o) / o * 100.0, 2)
        except Exception:
            pass
        mapped[s] = {"symbol": s, "price": price, "change_pct": chg}
    return [mapped[s] for s in symbols]

async def _stable_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    data = await _yahoo_quotes(symbols)
    # if Yahoo failed entirely (rare), try Stooq
    if all(d.get("price") is None for d in data):
        data = await _stooq_quotes(symbols)
    # final guard: set change_pct to 0 if missing but price present (keeps movers alive)
    for d in data:
        if d["price"] is not None and d.get("change_pct") is None:
            d["change_pct"] = 0.0
    return data

# ---------- Metrics & profile ----------
async def _stooq_history(sym: str, days: int = 800) -> pd.Series:
    r = await _get("https://stooq.com/q/d/l/", params={"s": _stooq_symbol(sym), "i": "d"})
    if not r: return pd.Series(dtype=float)
    df = pd.read_csv(io.StringIO(r.text))
    if df.empty or "Close" not in df: return pd.Series(dtype=float)
    df["Date"] = pd.to_datetime(df["Date"], errors="coerce")
    df = df.dropna(subset=["Date"]).set_index("Date").sort_index()
    if len(df) > days: df = df.iloc[-days:]
    return df["Close"].astype(float)

def _ret(close: pd.Series, bdays: int) -> Optional[float]:
    if close is None or close.empty or len(close) <= bdays: return None
    start = close.iloc[-(bdays+1)]
    last  = close.iloc[-1]
    if not start: return None
    return float((last - start) / start * 100.0)

CURATED_DESC = {
    "AAPL":"Apple designs iPhone, Mac and services like the App Store and iCloud.",
    "MSFT":"Microsoft builds Windows, Office and Azure cloud services.",
    "NVDA":"NVIDIA designs GPUs and AI accelerators.",
    "AMZN":"Amazon runs e-commerce marketplaces and AWS cloud.",
    "META":"Meta operates Facebook, Instagram and WhatsApp.",
    "GOOGL":"Alphabet spans Search, YouTube, Android and Cloud.",
    "TSLA":"Tesla manufactures EVs and energy products.",
    "SPY":"ETF tracking the S&P 500 index.",
    "QQQ":"ETF tracking the Nasdaq-100 index."
}
async def _profile(symbol: str) -> Dict[str, str]:
    if symbol in CURATED_DESC:
        return {"symbol":symbol, "name":symbol, "description":CURATED_DESC[symbol]}
    return {"symbol":symbol, "name":symbol, "description":"Publicly traded U.S. company."}

# ---------- News ----------
analyzer = SentimentIntensityAnalyzer()

async def _finnhub_news(symbol: str, limit=30) -> List[Dict[str, Any]]:
    if not FINNHUB_API_KEY: return []
    try:
        end = dt.date.today(); start = end - dt.timedelta(days=30)
        r = await _get("https://finnhub.io/api/v1/company-news",
                       params={"symbol":symbol,"from":start.isoformat(),"to":end.isoformat(),"token":FINNHUB_API_KEY})
        if not r: return []
        data = r.json()
        return [{"title":a.get("headline"),"url":a.get("url"),"source":a.get("source"),
                 "summary":a.get("summary") or "", "published_at":a.get("datetime")} for a in data[:limit]]
    except Exception:
        return []

async def _newsapi_news(symbol: str, limit=30) -> List[Dict[str, Any]]:
    if not NEWS_API_KEY: return []
    try:
        r = await _get("https://newsapi.org/v2/everything",
                       params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":limit})
        if not r: return []
        data = r.json()
        out=[]
        for a in data.get("articles", []):
            out.append({"title":a.get("title"),"url":a.get("url"),
                        "source":(a.get("source") or {}).get("name"),
                        "summary":a.get("description"),"published_at":a.get("publishedAt")})
        return out
    except Exception:
        return []

async def _market_news(limit=30)->List[Dict[str,Any]]:
    if FINNHUB_API_KEY:
        r = await _get("https://finnhub.io/api/v1/news", params={"category":"general","minId":0,"token":FINNHUB_API_KEY})
        if r:
            data=r.json()[:limit]
            return [{"title":a.get("headline"),"url":a.get("url"),"source":a.get("source"),
                     "summary":a.get("summary") or "", "published_at":a.get("datetime")} for a in data]
    if NEWS_API_KEY:
        r = await _get("https://newsapi.org/v2/top-headlines", params={"country":"us","category":"business","pageSize":limit})
        if r:
            data=r.json()
            return [{"title":a.get("title"),"url":a.get("url"),
                     "source":(a.get("source") or {}).get("name"),
                     "summary":a.get("description"),"published_at":a.get("publishedAt")}
                    for a in data.get("articles", [])]
    return []

# ---------- routes ----------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx): return PlainTextResponse("templates/index.html not found.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now=_now(); c=CACHE["tickers"]
    if c["data"] and now-c["ts"]<TTL["tickers"]: return JSONResponse(c["data"])
    data=await _stable_quotes(WATCHLIST)
    c["data"]=data; c["ts"]=now
    return JSONResponse(data)

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _stable_quotes(WATCHLIST))
    v = [r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    v.sort(key=lambda x: x["change_pct"], reverse=True)
    return JSONResponse({"gainers": v[:10], "losers": list(reversed(v[-10:]))})

@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)): return JSONResponse(await _profile(symbol))

@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    try:
        close = await _stooq_history(symbol, days=800)
        if close is None or close.empty: raise RuntimeError("no history")
        perf = {"1W": _ret(close, 5), "1M": _ret(close, 21), "3M": _ret(close, 63),
                "6M": _ret(close, 126), "YTD": None, "1Y": _ret(close, 252)}
        y = dt.datetime.utcnow().year
        yseg = close[close.index.year == y]
        if not yseg.empty: perf["YTD"] = float((close.iloc[-1] - yseg.iloc[0]) / yseg.iloc[0] * 100.0)
        prof = await _profile(symbol)
        return JSONResponse({"symbol": symbol, "performance": perf, "profile": prof})
    except Exception:
        return JSONResponse({"symbol": symbol,
                             "performance": {"1W":None,"1M":None,"3M":None,"6M":None,"YTD":None,"1Y":None},
                             "profile": await _profile(symbol)})

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    data = await _finnhub_news(symbol, 40)
    if not data: data = await _newsapi_news(symbol, 40)
    return JSONResponse(data or [])

@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now-c["ts"]<TTL["market_news"]: return JSONResponse(c["data"])
    data=await _market_news(60)
    c["data"]=data; c["ts"]=now
    return JSONResponse(data)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
