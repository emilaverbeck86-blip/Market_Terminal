from __future__ import annotations
import os, io, csv, time, datetime as dt
from typing import Any, Dict, List
import httpx, pandas as pd
from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
TMPL = os.path.join(BASE, "templates")
os.makedirs(STATIC, exist_ok=True); os.makedirs(TMPL, exist_ok=True)

app = FastAPI(title="Market Terminal")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/static", StaticFiles(directory=STATIC), name="static")
templates = Jinja2Templates(directory=TMPL)

NEWS_API_KEY      = os.getenv("NEWS_API_KEY","").strip()
FINNHUB_API_KEY   = os.getenv("FINNHUB_API_KEY","").strip()
TWELVEDATA_API_KEY= os.getenv("TWELVEDATA_API_KEY","").strip()

WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE","INTC","CSCO","QCOM","TXN",
    "CRM","ORCL","IBM","NOW","SNOW","ABNB","SHOP","PYPL","JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B","SCHW",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE","SBUX","TGT","WMT","T","VZ","CMCSA","XOM","CVX","COP",
    "CAT","BA","GE","UPS","FDX","DE","UNH","LLY","MRK","ABBV","JNJ","PFE","UBER","BKNG","SPY","QQQ","DIA","IWM"
]

BASE_HEADERS = {"User-Agent":"Mozilla/5.0","Accept":"*/*","Accept-Language":"en-US,en;q=0.9"}
def now(): return time.time()

CACHE: Dict[str, Dict[str, Any]] = {"tickers":{"ts":0.0,"data":None},"mktnews":{"ts":0.0,"data":None}}
TTL = {"tickers":25, "mktnews":180}

async def _get(url:str, params:Dict[str,Any]|None=None, timeout:float=10.0):
    try:
        async with httpx.AsyncClient(headers=BASE_HEADERS, timeout=httpx.Timeout(timeout, connect=4)) as c:
            r = await c.get(url, params=params)
            if r.status_code==200: return r
    except Exception:
        pass
    return None

# ---------------- Quotes (Yahoo → Stooq → TwelveData) ----------------
def _stooq_code(sym:str)->str: return f"{sym.lower().replace('.','-')}.us"

async def _from_yahoo(symbols:List[str])->List[Dict[str,Any]]:
    out=[]
    for i in range(0,len(symbols),35):
        chunk=symbols[i:i+35]
        r = await _get("https://query1.finance.yahoo.com/v7/finance/quote", {"symbols":",".join(chunk)})
        items = (r.json().get("quoteResponse",{}).get("result",[]) if r else [])
        by={ (d.get("symbol") or "").upper(): d for d in items }
        for s in chunk:
            d=by.get(s.upper())
            price = None
            for k in ("regularMarketPrice","postMarketPrice","bid"):
                if d and d.get(k) is not None: price=float(d[k]); break
            chg = None
            for k in ("regularMarketChangePercent","postMarketChangePercent"):
                if d and d.get(k) is not None: chg=float(d[k]); break
            out.append({"symbol":s,"price":round(price,2) if price is not None else None,
                        "change_pct":round(chg,2) if chg is not None else None})
    return out

async def _from_stooq(symbols:List[str])->List[Dict[str,Any]]:
    r = await _get("https://stooq.com/q/l/", {"s":",".join(_stooq_code(s) for s in symbols), "f":"sd2t2ohlc"})
    out=[{"symbol":s,"price":None,"change_pct":None} for s in symbols]
    if not r: return out
    rows={ (row.get("Symbol") or "").strip().lower(): row for row in csv.DictReader(io.StringIO(r.text)) }
    for idx,s in enumerate(symbols):
        row=rows.get(_stooq_code(s))
        if not row: continue
        try:
            c = None if row["Close"] in ("","-") else float(row["Close"])
            o = None if row["Open"]  in ("","-") else float(row["Open"])
            price = round(c,2) if c is not None else None
            chg = round(((c-o)/o)*100,2) if c not in (None,0) and o not in (None,0) else None
            out[idx] = {"symbol":s,"price":price,"change_pct":chg}
        except Exception:
            pass
    return out

async def _from_twelvedata(symbols:List[str])->List[Dict[str,Any]]:
    out=[{"symbol":s,"price":None,"change_pct":None} for s in symbols]
    if not TWELVEDATA_API_KEY: return out
    r = await _get("https://api.twelvedata.com/quote", {"symbol":",".join(symbols),"apikey":TWELVEDATA_API_KEY})
    if not r: return out
    js = r.json()
    for i,s in enumerate(symbols):
        node = js.get(s) if isinstance(js,dict) else None
        if not node: continue
        try:
            price = float(node.get("price")) if node.get("price") else None
            pct   = node.get("percent_change") or node.get("change_percent")
            chg   = float(pct) if pct not in (None,"") else None
        except Exception:
            price, chg = None, None
        out[i].update({"price": round(price,2) if price is not None else None,
                       "change_pct": round(chg,2) if chg is not None else None})
    return out

async def stable_quotes(symbols:List[str])->List[Dict[str,Any]]:
    data = await _from_yahoo(symbols)
    if all(d["price"] is None for d in data): data = await _from_stooq(symbols)
    if all(d["price"] is None for d in data): data = await _from_twelvedata(symbols)
    for d in data:
        if d["price"] is not None and d["change_pct"] is None: d["change_pct"]=0.0
    return data

# ---------------- History / Metrics ----------------
async def stooq_history(sym:str, days:int=800)->pd.Series:
    r = await _get("https://stooq.com/q/d/l/", {"s":_stooq_code(sym), "i":"d"})
    if not r: return pd.Series(dtype=float)
    df = pd.read_csv(io.StringIO(r.text))
    if df.empty or "Close" not in df: return pd.Series(dtype=float)
    df["Date"]=pd.to_datetime(df["Date"], errors="coerce"); df=df.dropna(subset=["Date"]).set_index("Date").sort_index()
    if len(df)>days: df=df.iloc[-days:]
    return df["Close"].astype(float)

def pct(close:pd.Series, bdays:int):
    if close is None or close.empty or len(close)<=bdays: return None
    a=close.iloc[-(bdays+1)]; b=close.iloc[-1]
    return None if not a else float((b-a)/a*100)

CURATED = {
    "AAPL":"Apple designs iPhone, Mac and services like the App Store, Music and iCloud. It drives retention with tight hardware–software integration and is rolling out on-device AI to deepen engagement.",
    "MSFT":"Microsoft runs Windows, Office and Azure. Cloud subscriptions are the growth engine, and Copilot brings AI across the stack. LinkedIn and Xbox add ecosystem reach.",
    "NVDA":"NVIDIA builds GPUs and full AI platforms. Data-center accelerators power training and inference for hyperscalers; CUDA software is a durable moat.",
    "AMZN":"Amazon’s e-commerce scale is complemented by AWS, a high-margin cloud platform. Ads and Prime subscriptions add recurring revenue.",
    "META":"Meta operates Facebook, Instagram and WhatsApp. Ads remain core, supported by AI ranking; messaging engagement keeps expanding.",
    "GOOGL":"Alphabet spans Search, YouTube, Android and Google Cloud. Ads are the cash engine while Cloud scales; heavy investment continues in AI.",
}

async def profile(symbol:str)->Dict[str,str]:
    return {"symbol":symbol,"name":symbol,"description":CURATED.get(symbol,
            "U.S. listed company. Summary unavailable; this placeholder ensures the panel stays readable.")}

# ---------------- News (symbol) ----------------
async def symbol_news(symbol:str, limit:int=30)->List[Dict[str,Any]]:
    # 1) Finnhub company news if key present (last 7 days)
    if FINNHUB_API_KEY:
        today=dt.date.today(); frm=(today-dt.timedelta(days=7)).isoformat()
        r=await _get("https://finnhub.io/api/v1/company-news",
                     {"symbol":symbol,"from":frm,"to":today.isoformat(),"token":FINNHUB_API_KEY})
        if r:
            js=r.json()
            return [{"title":a.get("headline"),"url":a.get("url"),"source":a.get("source"),
                     "summary":a.get("summary") or "", "published_at":a.get("datetime")} for a in js[:limit]]

    # 2) NewsAPI query (needs key)
    if NEWS_API_KEY:
        r=await _get("https://newsapi.org/v2/everything",
                     {"q":symbol,"language":"en","pageSize":limit,"apiKey":NEWS_API_KEY})
        if r:
            data=r.json()
            return [{"title":a.get("title"),"url":a.get("url"),"source":(a.get("source") or {}).get("name"),
                     "summary":a.get("description"),"published_at":a.get("publishedAt")} for a in data.get("articles",[])]

    # 3) Yahoo search (no key)
    r=await _get("https://query1.finance.yahoo.com/v1/finance/search",
                 {"q":symbol,"quotesCount":0,"newsCount":limit})
    if r:
        news=r.json().get("news",[])
        return [{"title":n.get("title"),"url":(n.get("link") or {}).get("url"),
                 "source":n.get("publisher") or "Yahoo","summary":"", "published_at":""} for n in news]
    return []

# ---------------- Market news ----------------
async def market_news(limit:int=40)->List[Dict[str,Any]]:
    if FINNHUB_API_KEY:
        r=await _get("https://finnhub.io/api/v1/news", {"category":"general","minId":0,"token":FINNHUB_API_KEY})
        if r:
            js=r.json()[:limit]
            return [{"title":a.get("headline"),"url":a.get("url"),"source":a.get("source"),
                     "summary":a.get("summary") or "", "published_at":a.get("datetime")} for a in js]
    if NEWS_API_KEY:
        r=await _get("https://newsapi.org/v2/top-headlines", {"country":"us","category":"business","pageSize":limit,"apiKey":NEWS_API_KEY})
        if r:
            js=r.json().get("articles",[])
            return [{"title":a.get("title"),"url":a.get("url"),"source":(a.get("source") or {}).get("name"),
                     "summary":a.get("description"),"published_at":a.get("publishedAt")} for a in js]
    r=await _get("https://query1.finance.yahoo.com/v1/finance/search", {"q":"markets","quotesCount":0,"newsCount":limit})
    if r:
        news=r.json().get("news",[])
        return [{"title":n.get("title"),"url":(n.get("link") or {}).get("url"),
                 "source":n.get("publisher") or "Yahoo","summary":"", "published_at":""} for n in news]
    return []

# ---------------- Routes ----------------
@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    idx = os.path.join(TMPL,"index.html")
    if not os.path.isfile(idx): return PlainTextResponse("templates/index.html missing", status_code=500)
    return templates.TemplateResponse("index.html", {"request":request})

@app.get("/api/tickers")
async def api_tickers():
    c=CACHE["tickers"]; t=now()
    if c["data"] and t-c["ts"]<TTL["tickers"]: return JSONResponse(c["data"])
    data = await stable_quotes(WATCHLIST)
    c["data"]=data; c["ts"]=t
    return JSONResponse(data)

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await stable_quotes(WATCHLIST))
    valid = [r for r in rows if r.get("price") is not None]
    # If we still lack change_pct, compute with Stooq history quick delta
    need = [v for v in valid if v.get("change_pct") is None]
    if need:
        # fallback: compute pct using last 2 closes (rough)
        for v in need:
            try:
                s = await stooq_history(v["symbol"], days=3)
                if len(s)>=2 and s.iloc[-2]!=0:
                    v["change_pct"]=round((s.iloc[-1]-s.iloc[-2])/s.iloc[-2]*100,2)
            except Exception:
                v["change_pct"]=0.0
    valid.sort(key=lambda x: (x.get("change_pct") or 0.0), reverse=True)
    return JSONResponse({"gainers": valid[:10], "losers": list(reversed(valid[-10:]))})

@app.get("/api/metrics")
async def api_metrics(symbol:str=Query(...)):
    close = await stooq_history(symbol, days=800)
    def ret(b): return pct(close,b)
    perf = {"1W":ret(5),"1M":ret(21),"3M":ret(63),"6M":ret(126),"YTD":None,"1Y":ret(252)}
    if not close.empty:
        y=dt.datetime.utcnow().year; seg=close[close.index.year==y]
        if not seg.empty: perf["YTD"]=float((close.iloc[-1]-seg.iloc[0])/seg.iloc[0]*100)
    prof = await profile(symbol)
    return JSONResponse({"symbol":symbol,"performance":perf,"profile":prof})

@app.get("/api/news")
async def api_news(symbol:str=Query(...)):
    return JSONResponse(await symbol_news(symbol, 30))

@app.get("/api/market-news")
async def api_marketnews():
    t=now(); c=CACHE["mktnews"]
    if c["data"] and t-c["ts"]<TTL["mktnews"]: return JSONResponse(c["data"])
    data=await market_news(50); c["data"]=data; c["ts"]=t
    return JSONResponse(data)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
