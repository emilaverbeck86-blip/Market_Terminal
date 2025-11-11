from __future__ import annotations
import os, time, datetime, re, traceback
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

import httpx
import yfinance as yf

# ---------------- Paths (Render-safe) ----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# ---------------- Env ----------------
load_dotenv(os.path.join(BASE_DIR, ".env"))  # local use
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()

# ---------------- FastAPI ----------------
app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------------- Watchlist (US stocks that work on TradingView) ----------------
WATCHLIST: List[str] = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT"
]

# ---------------- Cache ----------------
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "movers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 10, "movers": 30, "market_news": 180}

# ---------------- Helpers ----------------
def _safe_float(x) -> Optional[float]:
    try:
        f = float(x)
        if f != f:  # NaN
            return None
        return f
    except Exception:
        return None

def _compute_change(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None, 0): return None
    return (last - prev) / prev * 100.0

# ---------------- Prices via yfinance (batched) ----------------
def _fetch_tickers(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Pull 2 days of daily data and compute % change vs previous close.
    Always returns a list matching input order.
    """
    out: List[Dict[str, Any]] = []
    try:
        df = yf.download(
            tickers=" ".join(symbols),
            period="2d", interval="1d",
            auto_adjust=False, progress=False, threads=True
        )
        if getattr(df, "columns", None) is not None and df.columns.nlevels == 2:
            for s in symbols:
                try:
                    closes = df[s]["Close"].dropna()
                    last = _safe_float(closes.iloc[-1]) if len(closes) else None
                    prev = _safe_float(closes.iloc[-2]) if len(closes) > 1 else last
                    chg  = _compute_change(last, prev)
                    out.append({"symbol": s, "price": round(last,2) if last is not None else None,
                                "change_pct": round(chg,2) if chg is not None else None})
                except Exception:
                    out.append({"symbol": s, "price": None, "change_pct": None})
        else:
            # Single-symbol edge case
            try:
                closes = df["Close"].dropna()
                last = _safe_float(closes.iloc[-1]) if len(closes) else None
                prev = _safe_float(closes.iloc[-2]) if len(closes) > 1 else last
                chg  = _compute_change(last, prev)
                out.append({"symbol": symbols[0], "price": round(last,2) if last is not None else None,
                            "change_pct": round(chg,2) if chg is not None else None})
            except Exception:
                out.append({"symbol": symbols[0], "price": None, "change_pct": None})
    except Exception as e:
        print("yfinance batch error:", e, traceback.format_exc())
        out = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    return out

def _compute_movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    valid = [r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    valid.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": valid[:8], "losers": list(reversed(valid[-8:]))}

# ---------------- News (NewsAPI) ----------------
async def _fetch_news_symbol(symbol:str, page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable headlines.",
                 "url":"#", "source":"Local"}]
    try:
        url="https://newsapi.org/v2/everything"
        params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":page_size}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r=await client.get(url, params=params, headers=headers)
            if r.status_code!=200:
                return [{"title":f"NewsAPI error {r.status_code}. Check NEWS_API_KEY.",
                         "url":"#", "source":"NewsAPI"}]
            data=r.json()
            out=[]
            for a in data.get("articles", []):
                out.append({
                    "title": a.get("title"),
                    "url": a.get("url"),
                    "source": (a.get("source") or {}).get("name"),
                    "summary": a.get("description"),
                    "published_at": a.get("publishedAt"),
                })
            return out or [{"title":"No recent headlines found.","url":"#","source":"NewsAPI"}]
    except Exception as e:
        print("NEWSAPI symbol exception:", e)
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

async def _fetch_market_news(page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable US market headlines.",
                 "url":"#", "source":"Local"}]
    try:
        url="https://newsapi.org/v2/top-headlines"
        params={"country":"us","category":"business","pageSize":page_size}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r=await client.get(url, params=params, headers=headers)
            if r.status_code!=200:
                return [{"title":f"NewsAPI error {r.status_code}. Check NEWS_API_KEY.",
                         "url":"#", "source":"NewsAPI"}]
            data=r.json()
            out=[]
            for a in data.get("articles", []):
                out.append({
                    "title": a.get("title"),
                    "url": a.get("url"),
                    "source": (a.get("source") or {}).get("name"),
                    "summary": a.get("description"),
                    "published_at": a.get("publishedAt"),
                })
            return out or [{"title":"No US market headlines right now.","url":"#","source":"NewsAPI"}]
    except Exception as e:
        print("NEWSAPI market exception:", e)
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# ---------------- Sentiment ----------------
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _an = SentimentIntensityAnalyzer()
except Exception:
    _an = None

def _sentiment_aggregate(news: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not news or _an is None: return {"compound": 0.0, "detail": []}
    scores=[]
    for n in news:
        text=(n.get("title") or "")+". "+(n.get("summary") or "")
        vs=_an.polarity_scores(text)
        scores.append(vs["compound"])
    comp = sum(scores)/len(scores) if scores else 0.0
    return {"compound": comp}

# ---------------- Routes ----------------
@app.get("/health")
def health(): return {"ok": True}

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found in this deploy.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now=_now(); c=CACHE["tickers"]
    if c["data"] and now-c["ts"]<TTL["tickers"]:
        return JSONResponse(content=c["data"])
    rows = _fetch_tickers(WATCHLIST)
    # ensure we always return at least something
    if not rows:
        rows=[{"symbol":"TSLA","price":None,"change_pct":None}]
    c["ts"]=now; c["data"]=rows
    return JSONResponse(content=rows)

@app.get("/api/movers")
async def api_movers():
    now=_now(); c=CACHE["movers"]
    if c["data"] and now-c["ts"]<TTL["movers"]:
        return JSONResponse(content=c["data"])
    rows = _fetch_tickers(WATCHLIST)
    data = _compute_movers(rows)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)):
    try:
        t = yf.Ticker(symbol)
        fi = getattr(t, "fast_info", None) or {}
        prev = fi.get("previous_close")
        last = fi.get("last_price") or fi.get("last_traded") or fi.get("last")
        chg = _compute_change(_safe_float(last), _safe_float(prev))
        return JSONResponse(content={
            "symbol": symbol,
            "price": round(float(last),2) if last else None,
            "change_pct": round(float(chg),2) if chg is not None else None,
            "day_low": fi.get("day_low"), "day_high": fi.get("day_high"),
            "year_low": fi.get("year_low"), "year_high": fi.get("year_high"),
            "volume": fi.get("volume"), "market_cap": fi.get("market_cap"),
            "previous_close": prev
        })
    except Exception as e:
        print("quote error", e)
        return JSONResponse(content={"symbol":symbol}, status_code=200)

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    return JSONResponse(content=await _fetch_news_symbol(symbol))

@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    news=await _fetch_news_symbol(symbol)
    return JSONResponse(content=_sentiment_aggregate(news))

@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now-c["ts"]<TTL["market_news"]:
        return JSONResponse(content=c["data"])
    data=await _fetch_market_news(page_size=30)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
