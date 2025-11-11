from __future__ import annotations
import os, time, csv, io, asyncio, traceback
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
import httpx

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

# ---------- Watchlist (US stocks only; TradingView friendly) ----------
WATCHLIST: List[str] = [
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
    "movers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 10, "movers": 30, "market_news": 180}

# ---------- Utilities ----------
def _stooq_symbol(sym: str) -> str:
    # stooq uses lowercase, dash for class, and ".us" suffix for US tickers
    return f"{sym.lower().replace('.', '-').replace('_','-')}.us"

def _safe_float(x) -> Optional[float]:
    try:
        f = float(x)
        if f != f:  # NaN
            return None
        return f
    except Exception:
        return None

def _pct(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None, 0): return None
    return (last - prev) / prev * 100.0

# ---------- Stooq data (no key, fast & stable) ----------
# We fetch last & previous close per symbol (daily) and compute % change.

async def _stooq_last_prev(client: httpx.AsyncClient, symbol: str) -> Dict[str, Optional[float]]:
    url = f"https://stooq.com/q/d/l/?s={_stooq_symbol(symbol)}&i=d"
    try:
        r = await client.get(url, timeout=10)
        if r.status_code != 200 or not r.text:
            return {"last": None, "prev": None}
        rows = list(csv.reader(io.StringIO(r.text)))
        if rows and rows[0] and rows[0][0].lower() == "date":
            rows = rows[1:]
        if not rows:
            return {"last": None, "prev": None}
        # last line -> last close; prev line -> previous close (if available)
        last_close = _safe_float(rows[-1][4]) if len(rows[-1]) >= 5 else None
        prev_close = _safe_float(rows[-2][4]) if len(rows) >= 2 and len(rows[-2]) >= 5 else None
        return {"last": last_close, "prev": prev_close}
    except Exception:
        return {"last": None, "prev": None}

async def _batch_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    sem = asyncio.Semaphore(12)  # limit concurrency for Render free tier

    async def worker(sym: str) -> Dict[str, Any]:
        async with sem:
            async with httpx.AsyncClient() as client:
                data = await _stooq_last_prev(client, sym)
                chg = _pct(data["last"], data["prev"])
                return {
                    "symbol": sym,
                    "price": round(data["last"], 2) if data["last"] is not None else None,
                    "change_pct": round(chg, 2) if chg is not None else None
                }

    tasks = [worker(s) for s in symbols]
    for r in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(r, Exception):
            out.append({"symbol": symbols[len(out)], "price": None, "change_pct": None})
        else:
            out.append(r)
    return out

def _movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    valid = [r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    valid.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": valid[:8], "losers": list(reversed(valid[-8:]))}

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
            return [{"title": f"NewsAPI error {r.status_code}.", "url": "#", "source": "NewsAPI"}]
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
        return out or [{"title": "No recent headlines found.", "url":"#", "source":"NewsAPI"}]
    except Exception as e:
        print("news error:", e, traceback.format_exc())
        return [{"title":"Could not reach NewsAPI (network/timeout).", "url":"#", "source":"Server"}]

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
        print("market news error:", e, traceback.format_exc())
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# ---------- Sentiment ----------
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _an = SentimentIntensityAnalyzer()
except Exception:
    _an = None

def _sentiment(news: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not news or _an is None: return {"compound": 0.0}
    scores=[]
    for n in news:
        text = (n.get("title") or "") + ". " + (n.get("summary") or "")
        scores.append(_an.polarity_scores(text)["compound"])
    comp = sum(scores)/len(scores) if scores else 0.0
    return {"compound": comp}

# ---------- Routes ----------
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
    if c["data"] and now - c["ts"] < TTL["tickers"]:
        return JSONResponse(content=c["data"])
    rows = await _batch_quotes(WATCHLIST)
    # duplicate once client-side for scroll; here we give clean unique list
    c["ts"]=now; c["data"]=rows
    return JSONResponse(content=rows)

@app.get("/api/movers")
async def api_movers():
    now=_now(); c=CACHE["movers"]
    if c["data"] and now - c["ts"] < TTL["movers"]:
        return JSONResponse(content=c["data"])
    rows = await _batch_quotes(WATCHLIST)
    data = _movers(rows)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)):
    try:
        async with httpx.AsyncClient() as client:
            data = await _stooq_last_prev(client, symbol)
        chg = _pct(data["last"], data["prev"])
        return JSONResponse(content={
            "symbol": symbol,
            "price": round(data["last"],2) if data["last"] is not None else None,
            "change_pct": round(chg,2) if chg is not None else None,
            "previous_close": data["prev"]
        })
    except Exception as e:
        print("quote error:", e, traceback.format_exc())
        return JSONResponse(content={"symbol": symbol}, status_code=200)

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    return JSONResponse(content=await _news_symbol(symbol))

@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    news = await _news_symbol(symbol, page_size=20)
    return JSONResponse(content=_sentiment(news))

@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now - c["ts"] < TTL["market_news"]:
        return JSONResponse(content=c["data"])
    data = await _market_news(page_size=30)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")), workers=1)
