from __future__ import annotations
import os, time, traceback
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

import httpx
import yfinance as yf

# ---------- Paths ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# ---------- Env ----------
load_dotenv(os.path.join(BASE_DIR, ".env"))
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()

# ---------- App ----------
app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------- Watchlist (US stocks; TradingView-friendly) ----------
WATCHLIST: List[str] = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT"
]

# ---------- Cache (sticky; never return empty to the client) ----------
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},   # list[ {symbol, price, change_pct} ]
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 45, "market_news": 180}  # make yfinance happier

def _safe_float(x)->Optional[float]:
    try:
        f=float(x);  return None if f!=f else f
    except: return None

def _pct(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None,0): return None
    return (last-prev)/prev*100.0

def _compute_movers(rows: List[Dict[str, Any]])->Dict[str,List[Dict[str,Any]]]:
    valid=[r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    valid.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": valid[:8], "losers": list(reversed(valid[-8:]))}

def _keep_last(cache_key: str, new_data: Optional[Any]) -> Any:
    """Sticky cache: keep previous good snapshot when fetch fails."""
    c=CACHE[cache_key]
    if new_data:
        c["data"]=new_data; c["ts"]=_now()
    return c["data"]

# ---------- Prices (yfinance batched; robust) ----------
def _fetch_tickers(symbols: List[str]) -> List[Dict[str, Any]]:
    """
    Download 5 days of daily bars, compute change vs previous close.
    If anything fails, reuse last cache snapshot (prevents UI empty/zeros).
    """
    try:
        df = yf.download(
            tickers=" ".join(symbols),
            period="5d", interval="1d",
            auto_adjust=False, progress=False, threads=False
        )
        out: List[Dict[str, Any]] = []
        if getattr(df, "columns", None) is not None and df.columns.nlevels == 2:
            for s in symbols:
                try:
                    closes = df[s]["Close"].dropna()
                    if len(closes) < 2:
                        out.append({"symbol": s, "price": None, "change_pct": None}); continue
                    last = _safe_float(closes.iloc[-1])
                    prev = _safe_float(closes.iloc[-2])
                    chg  = _pct(last, prev)
                    out.append({"symbol": s, "price": round(last,2) if last is not None else None,
                                "change_pct": round(chg,2) if chg is not None else None})
                except Exception:
                    out.append({"symbol": s, "price": None, "change_pct": None})
        else:
            # Single-symbol fallback (shouldn't happen here)
            for s in symbols:
                out.append({"symbol": s, "price": None, "change_pct": None})
        # if all None, refuse to overwrite cache
        if not any(isinstance(r.get("price"), (int,float)) for r in out):
            raise RuntimeError("empty batch")
        return out
    except Exception as e:
        print("yfinance batch error:", e, traceback.format_exc())
        # return None to indicate failure; caller will keep previous cache
        return None

# ---------- News (NewsAPI) ----------
async def _news_symbol(symbol: str, page_size: int = 20) -> List[Dict[str, Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable headlines.",
                 "url":"#", "source":"Local"}]
    try:
        url = "https://newsapi.org/v2/everything"
        params = {"q": symbol, "language": "en", "sortBy": "publishedAt", "pageSize": page_size}
        headers = {"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(url, params=params, headers=headers)
        if r.status_code != 200:
            return [{"title": f"NewsAPI error {r.status_code}.", "url":"#", "source":"NewsAPI"}]
        data = r.json()
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
        print("news error:", e)
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

async def _market_news(page_size: int = 20) -> List[Dict[str, Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable market headlines.",
                 "url":"#", "source":"Local"}]
    try:
        url = "https://newsapi.org/v2/top-headlines"
        params = {"country": "us", "category": "business", "pageSize": page_size}
        headers = {"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r = await client.get(url, params=params, headers=headers)
        if r.status_code != 200:
            return [{"title": f"NewsAPI error {r.status_code}.", "url":"#", "source":"NewsAPI"}]
        data = r.json()
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
        print("market news error:", e)
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# ---------- Profile / Description ----------
@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)):
    """
    Returns a short business description for the company.
    Sticky: empty/failure returns a generic fallback.
    """
    try:
        t = yf.Ticker(symbol)
        info = t.get_info() or {}
        desc = info.get("longBusinessSummary") or info.get("description") or ""
        name = info.get("shortName") or info.get("longName") or symbol
        if not desc:
            raise RuntimeError("no description")
        return JSONResponse(content={"symbol": symbol, "name": name, "description": desc})
    except Exception as e:
        print("profile error:", e)
        return JSONResponse(content={
            "symbol": symbol,
            "name": symbol,
            "description": "No official description available right now."
        })

# ---------- Routes ----------
@app.get("/health")
def health(): return {"ok": True}

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
def api_tickers():
    now=_now(); c=CACHE["tickers"]
    # serve cached if fresh
    if c["data"] and now - c["ts"] < TTL["tickers"]:
        return JSONResponse(content=c["data"])
    # fetch new snapshot
    data = _fetch_tickers(WATCHLIST)
    snapshot = _keep_last("tickers", data)  # keeps last on failure
    # if we still never had a snapshot, synthesize placeholders
    if not snapshot:
        snapshot = [{"symbol": s, "price": None, "change_pct": None} for s in WATCHLIST]
        CACHE["tickers"]["data"] = snapshot
        CACHE["tickers"]["ts"] = now
    return JSONResponse(content=snapshot)

@app.get("/api/movers")
def api_movers():
    # use the same sticky tickers snapshot to compute movers
    rows = CACHE["tickers"]["data"] or _fetch_tickers(WATCHLIST) or []
    return JSONResponse(content=_compute_movers(rows))

@app.get("/api/quote")
def api_quote(symbol: str = Query(...)):
    # quote uses the same batch logic but only returns this symbol from cache
    rows = CACHE["tickers"]["data"] or _fetch_tickers(WATCHLIST) or []
    for r in rows:
        if r["symbol"] == symbol:
            return JSONResponse(content={
                "symbol": symbol,
                "price": r.get("price"),
                "change_pct": r.get("change_pct"),
                "previous_close": None
            })
    return JSONResponse(content={"symbol": symbol})

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    return JSONResponse(content=await _news_symbol(symbol))

@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    # simple sentiment from symbol news
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        news = await _news_symbol(symbol, page_size=20)
        analyzer = SentimentIntensityAnalyzer()
        scores=[]
        for n in news:
            text=(n.get("title") or "")+". "+(n.get("summary") or "")
            scores.append(analyzer.polarity_scores(text)["compound"])
        comp = sum(scores)/len(scores) if scores else 0.0
        return JSONResponse(content={"compound": comp})
    except Exception:
        return JSONResponse(content={"compound": 0.0})

@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now - c["ts"] < TTL["market_news"]:
        return JSONResponse(content=c["data"])
    data = await _market_news(page_size=30)
    CACHE["market_news"]["data"]=data; CACHE["market_news"]["ts"]=now
    return JSONResponse(content=data)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
