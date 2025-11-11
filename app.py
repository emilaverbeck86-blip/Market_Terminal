from __future__ import annotations
import os, time, csv, io, asyncio, traceback
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import httpx
import yfinance as yf

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

load_dotenv(os.path.join(BASE_DIR, ".env"))
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()

app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

WATCHLIST: List[str] = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT"
]

def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},      # list[{symbol, price, change_pct}]
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 60, "market_news": 180}

def _safe_float(x)->Optional[float]:
    try:
        f=float(x);  return None if f!=f else f
    except: return None

def _pct(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None,0): return None
    return (last-prev)/prev*100.0

def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_','-')}.us"

async def _stooq_last_prev(client: httpx.AsyncClient, sym: str) -> Dict[str, Optional[float]]:
    url = f"https://stooq.com/q/d/l/?s={_stooq_symbol(sym)}&i=d"
    try:
        r = await client.get(url, timeout=10)
        if r.status_code != 200 or not r.text:
            return {"last": None, "prev": None}
        rows = list(csv.reader(io.StringIO(r.text)))
        if rows and rows[0] and rows[0][0].lower()=="date": rows = rows[1:]
        if len(rows) == 0: return {"last": None, "prev": None}
        last = _safe_float(rows[-1][4]) if len(rows[-1])>=5 else None
        prev = _safe_float(rows[-2][4]) if len(rows)>=2 and len(rows[-2])>=5 else None
        return {"last": last, "prev": prev}
    except Exception:
        return {"last": None, "prev": None}

async def _batch_quotes(symbols: List[str]) -> Optional[List[Dict[str, Any]]]:
    out: List[Dict[str, Any]] = []
    sem = asyncio.Semaphore(10)
    async with httpx.AsyncClient() as client:
        async def one(s: str):
            async with sem:
                data = await _stooq_last_prev(client, s)
                chg = _pct(data["last"], data["prev"])
                return {
                    "symbol": s,
                    "price": round(data["last"],2) if data["last"] is not None else None,
                    "change_pct": round(chg,2) if chg is not None else None
                }
        res = await asyncio.gather(*[one(s) for s in symbols], return_exceptions=True)
    for i, r in enumerate(res):
        if isinstance(r, Exception):
            out.append({"symbol": symbols[i], "price": None, "change_pct": None})
        else:
            out.append(r)
    # if every price is None, signal failure so we keep old cache
    if not any(isinstance(r.get("price"), (int,float)) for r in out):
        return None
    return out

def _movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    v=[r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    v.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": v[:8], "losers": list(reversed(v[-8:]))}

# -------- News --------
async def _news_symbol(symbol: str, page_size: int = 20) -> List[Dict[str, Any]]:
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
            return [{"title":f"NewsAPI error {r.status_code}.","url":"#","source":"NewsAPI"}]
        data=r.json(); out=[]
        for a in data.get("articles", []):
            out.append({
                "title":a.get("title"),"url":a.get("url"),
                "source":(a.get("source") or {}).get("name"),
                "summary":a.get("description"),"published_at":a.get("publishedAt"),
            })
        return out or [{"title":"No recent headlines found.","url":"#","source":"NewsAPI"}]
    except Exception as e:
        print("news error:", e, traceback.format_exc())
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

async def _market_news(page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable market headlines.",
                 "url":"#","source":"Local"}]
    try:
        url="https://newsapi.org/v2/top-headlines"
        params={"country":"us","category":"business","pageSize":page_size}
        headers={"X-Api-Key":NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r=await client.get(url, params=params, headers=headers)
        if r.status_code!=200:
            return [{"title":f"NewsAPI error {r.status_code}.","url":"#","source":"NewsAPI"}]
        data=r.json(); out=[]
        for a in data.get("articles", []):
            out.append({
                "title":a.get("title"),"url":a.get("url"),
                "source":(a.get("source") or {}).get("name"),
                "summary":a.get("description"),"published_at":a.get("publishedAt"),
            })
        return out or [{"title":"No US market headlines right now.","url":"#","source":"NewsAPI"}]
    except Exception as e:
        print("market news error:", e, traceback.format_exc())
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# -------- Company blurb --------
@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)):
    try:
        t = yf.Ticker(symbol)
        info = t.get_info() or {}
        desc = info.get("longBusinessSummary") or info.get("description") or ""
        name = info.get("shortName") or info.get("longName") or symbol
        if not desc: raise RuntimeError("no description")
        return JSONResponse({"symbol":symbol,"name":name,"description":desc})
    except Exception:
        return JSONResponse({"symbol":symbol,"name":symbol,"description":"No description available right now."})

# -------- Routes --------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found.", status_code=500)
    return Jinja2Templates(directory=TEMPLATES_DIR).TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now=_now(); c=CACHE["tickers"]
    if c["data"] and now-c["ts"]<TTL["tickers"]:
        return JSONResponse(c["data"])
    data = await _batch_quotes(WATCHLIST)
    if data is not None:
        c["data"]=data; c["ts"]=now
    return JSONResponse(c["data"] or [{"symbol":s,"price":None,"change_pct":None} for s in WATCHLIST])

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _batch_quotes(WATCHLIST)) or []
    return JSONResponse(_movers(rows))

@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)):
    rows = CACHE["tickers"]["data"] or (await _batch_quotes(WATCHLIST)) or []
    for r in rows:
        if r["symbol"]==symbol:
            return JSONResponse({"symbol":symbol,"price":r.get("price"),"change_pct":r.get("change_pct")})
    return JSONResponse({"symbol":symbol})

@app.get("/api/news")
async def api_news(symbol: str = Query(...)): return JSONResponse(await _news_symbol(symbol))
@app.get("/api/sentiment")
async def api_sentiment(symbol: str = Query(...)):
    try:
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        analyzer=SentimentIntensityAnalyzer()
        news=await _news_symbol(symbol, page_size=20)
        scores=[analyzer.polarity_scores((n.get("title") or "")+". "+(n.get("summary") or ""))["compound"] for n in news]
        comp = sum(scores)/len(scores) if scores else 0.0
        return JSONResponse({"compound": comp})
    except Exception:
        return JSONResponse({"compound": 0.0})
@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now-c["ts"]<TTL["market_news"]: return JSONResponse(c["data"])
    data=await _market_news(30); c["data"]=data; c["ts"]=now; return JSONResponse(data)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
