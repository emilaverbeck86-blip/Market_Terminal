from __future__ import annotations
import os, time, csv, io, math, asyncio, datetime as dt
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import httpx
import yfinance as yf

# ---------------- Paths / App ----------------
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

# ---------------- Watchlist ----------------
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
    "tickers": {"ts": 0.0, "data": None},           # [{symbol, price, change_pct}]
    "market_news": {"ts": 0.0, "data": None},       # market news cache
    "stats": {},                                    # per-symbol small caches
}
TTL = {"tickers": 30, "market_news": 180, "stats": 180}

def _safe_float(x)->Optional[float]:
    try:
        f=float(x);  return None if f!=f else f
    except: return None

# ---------------- Quotes: Yahoo batch, fallback Stooq ----------------
async def _yahoo_batch(client: httpx.AsyncClient, symbols: List[str]) -> Optional[List[Dict[str, Any]]]:
    try:
        q = ",".join(symbols)
        url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={q}"
        r = await client.get(url, timeout=10)
        if r.status_code != 200: return None
        res = r.json().get("quoteResponse", {}).get("result", [])
        out=[]
        for s in symbols:
            row = next((x for x in res if (x.get("symbol") or "").upper()==s), None)
            if not row:
                out.append({"symbol": s, "price": None, "change_pct": None})
                continue
            price = _safe_float(row.get("regularMarketPrice"))
            chg = _safe_float(row.get("regularMarketChangePercent"))
            prev = _safe_float(row.get("regularMarketPreviousClose"))
            if chg is None and (price is not None and prev not in (None,0)):
                chg = (price-prev)/prev*100.0
            out.append({
                "symbol": s,
                "price": round(price,2) if price is not None else None,
                "change_pct": round(chg,2) if chg is not None else None
            })
        if not any(isinstance(r.get("price"), (int,float)) for r in out):
            return None
        return out
    except Exception:
        return None

def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_','-')}.us"

async def _stooq_batch(client: httpx.AsyncClient, symbols: List[str]) -> Optional[List[Dict[str, Any]]]:
    # daily last/prev (not intraday) — used only as fallback
    async def one(s: str):
        url = f"https://stooq.com/q/d/l/?s={_stooq_symbol(s)}&i=d"
        try:
            r = await client.get(url, timeout=10)
            if r.status_code != 200 or not r.text:
                return {"symbol": s, "price": None, "change_pct": None}
            rows = list(csv.reader(io.StringIO(r.text)))
            if rows and rows[0] and rows[0][0].lower()=="date": rows = rows[1:]
            if not rows: return {"symbol": s, "price": None, "change_pct": None}
            last = _safe_float(rows[-1][4]) if len(rows[-1])>=5 else None
            prev = _safe_float(rows[-2][4]) if len(rows)>=2 and len(rows[-2])>=5 else None
            chg = (last-prev)/prev*100.0 if (last is not None and prev not in (None,0)) else None
            return {"symbol": s, "price": round(last,2) if last is not None else None,
                    "change_pct": round(chg,2) if chg is not None else None}
        except Exception:
            return {"symbol": s, "price": None, "change_pct": None}
    res = await asyncio.gather(*[one(s) for s in symbols], return_exceptions=True)
    out=[]
    for i, r in enumerate(res):
        if isinstance(r, Exception):
            out.append({"symbol": symbols[i], "price": None, "change_pct": None})
        else:
            out.append(r)
    if not any(isinstance(x.get("price"), (int,float)) for x in out):
        return None
    return out

async def _batch_quotes(symbols: List[str]) -> Optional[List[Dict[str, Any]]]:
    async with httpx.AsyncClient() as client:
        data = await _yahoo_batch(client, symbols)
        if data is not None:
            return data
        return await _stooq_batch(client, symbols)

def _movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    v=[r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    v.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": v[:8], "losers": list(reversed(v[-8:]))}

# ---------------- News ----------------
async def _news_symbol(symbol: str, page_size: int = 20) -> List[Dict[str, Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable headlines.",
                 "url":"#","source":"Local"}]
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
            out.append({"title":a.get("title"),"url":a.get("url"),
                        "source":(a.get("source") or {}).get("name"),
                        "summary":a.get("description"),"published_at":a.get("publishedAt")})
        return out or [{"title":"No recent headlines found.","url":"#","source":"NewsAPI"}]
    except Exception:
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
            out.append({"title":a.get("title"),"url":a.get("url"),
                        "source":(a.get("source") or {}).get("name"),
                        "summary":a.get("description"),"published_at":a.get("publishedAt")})
        return out or [{"title":"No US market headlines right now.","url":"#","source":"NewsAPI"}]
    except Exception:
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# ---------------- Profile / Summary helper ----------------
def _trim_sentences(text: str, limit: int = 420) -> str:
    if not text: return ""
    text = " ".join(text.split())
    if len(text) <= limit: return text
    enders = ".!?"
    cut = text[:limit+1]
    last = max(cut.rfind(ch) for ch in enders)
    if last < 60:  # if we didn't find a sensible sentence end
        return cut.rstrip() + "…"
    return cut[:last+1]

# ---------------- Snapshot endpoints (for the new tile) ----------------
def _pct_change(a: Optional[float], b: Optional[float]) -> Optional[float]:
    if a is None or b in (None,0): return None
    return (a-b)/b*100.0

async def _history(symbol: str, start: dt.datetime) -> Optional[Any]:
    try:
        df = yf.download(symbol, start=start.date(), progress=False, auto_adjust=False, actions=False)
        if df is None or df.empty: return None
        return df
    except Exception:
        return None

@app.get("/api/stats")
async def api_stats(symbol: str = Query(...)):
    # cache small stats per symbol
    key = f"stats:{symbol.upper()}"
    now = _now()
    ent = CACHE["stats"].get(key, {"ts": 0, "data": None})
    if ent["data"] and now - ent["ts"] < TTL["stats"]:
        return JSONResponse(ent["data"])

    out: Dict[str, Any] = {"symbol": symbol}
    try:
        t = yf.Ticker(symbol)
        finfo = t.fast_info or {}
        vol = finfo.get("last_volume") or finfo.get("volume")
        avgvol = finfo.get("ten_day_average_volume") or finfo.get("three_month_average_volume")
        out["volume"] = int(vol) if isinstance(vol, (int,float)) else None
        out["avg_volume_30d"] = int(avgvol) if isinstance(avgvol, (int,float)) else None
    except Exception:
        out["volume"] = None; out["avg_volume_30d"] = None

    # performance
    today = dt.datetime.utcnow()
    periods = {
        "1W": today - dt.timedelta(days=7),
        "1M": today - dt.timedelta(days=30),
        "3M": today - dt.timedelta(days=90),
        "6M": today - dt.timedelta(days=180),
        "YTD": dt.datetime(today.year, 1, 1),
        "1Y": today - dt.timedelta(days=365),
    }
    perf={}
    hist = await _history(symbol, min(periods.values()))
    if hist is not None and not hist.empty:
        close_series = hist["Close"].dropna()
        last = float(close_series.iloc[-1])
        for label, start in periods.items():
            ref = close_series.loc[close_series.index >= start]
            if ref.empty:
                perf[label] = None
            else:
                base = float(ref.iloc[0])
                perf[label] = round(_pct_change(last, base) or 0.0, 2)
    out["performance"] = perf

    # seasonals: lines for 2023, 2024, 2025 normalized
    seasonals=[]
    try:
        hist2 = await _history(symbol, today - dt.timedelta(days=900))
        if hist2 is not None and not hist2.empty:
            hist2 = hist2["Close"].dropna()
            for yr in [2023, 2024, 2025]:
                seg = hist2[hist2.index.year == yr]
                if seg.empty: 
                    continue
                base = float(seg.iloc[0])
                pts = []
                for ts, val in seg.items():
                    pct = (_safe_float(val) - base)/base*100.0 if base else 0.0
                    pts.append({"t": ts.strftime("%Y-%m-%d"), "v": round(pct,2)})
                seasonals.append({"year": yr, "points": pts})
    except Exception:
        pass

    # technicals: simple rules using SMA/RSI
    tech = {"score": 50, "label":"Neutral"}
    try:
        df = await _history(symbol, today - dt.timedelta(days=400))
        if df is not None and not df.empty:
            c = df["Close"].astype(float)
            sma20 = c.rolling(20).mean()
            sma50 = c.rolling(50).mean()
            sma200 = c.rolling(200).mean()
            delta = c.diff()
            up = delta.clip(lower=0)
            down = -1*delta.clip(upper=0)
            rsi = 100 - 100/(1 + (up.rolling(14).mean() / (down.rolling(14).mean()+1e-9)))
            last = c.iloc[-1]; rsi_last = float(rsi.iloc[-1])
            s = 50
            if last > sma50.iloc[-1]: s += 15
            else: s -= 15
            if sma50.iloc[-1] > sma200.iloc[-1]: s += 15
            else: s -= 15
            if rsi_last > 55: s += 10
            elif rsi_last < 45: s -= 10
            s = max(0, min(100, int(round(s))))
            if s >= 80: lab="Strong buy"
            elif s >= 60: lab="Buy"
            elif s <= 20: lab="Strong sell"
            elif s <= 40: lab="Sell"
            else: lab="Neutral"
            tech = {"score": s, "label": lab}
    except Exception:
        pass

    out["seasonals"] = seasonals
    out["technicals"] = tech
    CACHE["stats"][key] = {"ts": now, "data": out}
    return JSONResponse(out)

# ---------------- API routes ----------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

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

@app.get("/api/profile")
async def api_profile(symbol: str = Query(...)):
    try:
        t = yf.Ticker(symbol)
        info = t.get_info() or {}
        desc = info.get("longBusinessSummary") or info.get("description") or ""
        name = info.get("shortName") or info.get("longName") or symbol
        return JSONResponse({"symbol":symbol,"name":name,"description":_trim_sentences(desc)})
    except Exception:
        return JSONResponse({"symbol":symbol,"name":symbol,"description":"No description available right now."})

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
