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

# ---------- paths ----------
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

# Big watchlist to always fill the bar
WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","ORCL","IBM","NOW","SNOW","ABNB","SHOP","PYPL",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B","SCHW",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE","SBUX","TGT","WMT",
    "T","VZ","CMCSA",
    "XOM","CVX","COP","CAT","BA","GE","UPS","FDX","DE",
    "UNH","LLY","MRK","ABBV","JNJ","PFE",
    "UBER","LYFT","BKNG","SPY","QQQ","DIA","IWM"
]

# ---------- caching ----------
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 45, "market_news": 180}

# ---------- http helper ----------
UA = {"User-Agent": "MarketTerminal/1.3"}
async def _get(url: str, params: Dict[str, Any] | None = None, timeout: float = 8.0):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4.0), headers=UA) as client:
            r = await client.get(url, params=params)
            if r.status_code == 200:
                return r
    except Exception:
        pass
    return None

# ---------- Stooq quotes/history ----------
def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_', '-')}.us"

async def _stooq_bulk_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    # % change = (Close-Open)/Open — fast and single request
    url = "https://stooq.com/q/l/"
    s_param = ",".join([_stooq_symbol(s) for s in symbols])
    r = await _get(url, params={"s": s_param, "f": "sd2t2ohlc"})
    if not r:
        return [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    rows = list(csv.reader(io.StringIO(r.text)))
    if rows and rows[0] and rows[0][0].lower().startswith("symbol"):
        rows = rows[1:]
    out=[]
    for i, s in enumerate(symbols):
        price = chg = None
        row = rows[i] if i < len(rows) else None
        try:
            close = float(row[6]) if row and row[6] not in ("-", "", None) else None
            opn   = float(row[3]) if row and row[3] not in ("-", "", None) else None
            if close is not None: price = round(close, 2)
            if close is not None and opn not in (None, 0):
                chg = round((close - opn) / opn * 100.0, 2)
        except Exception:
            pass
        out.append({"symbol": s, "price": price, "change_pct": chg})
    return out

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

def _seasonals(close: pd.Series) -> Dict[str, List[List[float]]]:
    if close is None or close.empty: return {}
    years = sorted(list(set(close.index.year)))[-3:]
    out: Dict[str, List[List[float]]] = {}
    for y in years:
        seg = close[close.index.year == y].dropna()
        if seg.empty: continue
        base = float(seg.iloc[0]) or 0.0
        pts=[]
        for n, (_, v) in enumerate(seg.items(), start=1):
            pct = ((float(v) - base) / base * 100.0) if base else 0.0
            pts.append([n, pct])
        out[str(y)] = pts
    return out

# ---------- news & sentiment ----------
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

def _sentiment_from_titles(items: List[Dict[str, Any]]) -> float:
    if not items: return 0.0
    scores=[]
    for n in items[:25]:
        text = (n.get("title") or "") + " " + (n.get("summary") or "")
        if not text.strip(): continue
        s = analyzer.polarity_scores(text)["compound"]
        scores.append(s)
    return float(pd.Series(scores).mean()) if scores else 0.0

# ---------- tiny profiles ----------
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
    data=await _stooq_bulk_quotes(WATCHLIST)
    c["data"]=data; c["ts"]=now
    return JSONResponse(data)

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _stooq_bulk_quotes(WATCHLIST))
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
        seasonals = _seasonals(close)
        return JSONResponse({"symbol": symbol, "performance": perf, "seasonals": seasonals})
    except Exception:
        return JSONResponse({"symbol": symbol,
                             "performance": {"1W":None,"1M":None,"3M":None,"6M":None,"YTD":None,"1Y":None},
                             "seasonals": {}})

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    data = await _finnhub_news(symbol, 40)
    if not data: data = await _newsapi_news(symbol, 40)
    return JSONResponse(data or [])

@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    items = await _finnhub_news(symbol, 40) or await _newsapi_news(symbol, 40)
    score = _sentiment_from_titles(items)
    return JSONResponse({"symbol": symbol, "compound": score})

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
