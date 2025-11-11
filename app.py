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

# ---------- Paths ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# ---------- Env ----------
load_dotenv(dotenv_path=os.path.join(BASE_DIR, ".env"))  # local only
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "")
TE_KEY = os.getenv("TE_KEY", "")

# ---------- FastAPI ----------
app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------- Cache ----------
def _now() -> float: return time.time()
CACHE: Dict[str, Any] = {"tickers":{"ts":0.0,"data":None},
                         "market_news":{"ts":0.0,"data":None},
                         "calendar":{"ts":0.0,"data":None}}
TTL = {"tickers": 5, "market_news": 180, "calendar": 1800}

# ---------- Minimal tickers (no yfinance to avoid platform hiccups) ----------
# We’ll serve static prices (None) so UI is alive; you can re-enable yfinance later.
TICKER_SYMBOLS = ["AAPL","MSFT","NVDA","TSLA","AMZN","BTCUSDT","ETHUSDT"]
def _fetch_tickers_stub()->List[Dict[str,Any]]:
    # Always succeed; UI will show price as "—"
    return [{"symbol": s, "price": None, "change_pct": 0.0} for s in TICKER_SYMBOLS]

# ---------- News helpers ----------
async def _fetch_news_symbol(symbol:str, page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY:
        # No key → show helpful stub, not a failure
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable live headlines.",
                 "url":"#", "source":"Local", "summary":"", "published_at":""}]
    try:
        url="https://newsapi.org/v2/everything"
        params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":page_size}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=12) as client:
            r=await client.get(url, params=params, headers=headers)
            if r.status_code!=200:
                print("NEWSAPI symbol error:", r.status_code, r.text[:300])
                # Show stub so frontend doesn’t show “Failed to load”
                return [{"title":f"NewsAPI error {r.status_code}. Check NEWS_API_KEY.",
                         "url":"#", "source":"NewsAPI", "summary":"", "published_at":""}]
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
        print("NEWSAPI symbol exception:", e, traceback.format_exc())
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
                print("NEWSAPI market error:", r.status_code, r.text[:300])
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
        print("NEWSAPI market exception:", e, traceback.format_exc())
        return [{"title":"Could not reach NewsAPI (network/timeout).","url":"#","source":"Server"}]

# ---------- TradingEconomics calendar (robust + guest fallback) ----------
_DATE_MS_RE = re.compile(r"/Date\((\d+)")
def _fmt_te_date(val: Any) -> str:
    if isinstance(val, (int, float)):
        dt = datetime.datetime.utcfromtimestamp(val/1000.0)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    if isinstance(val, str):
        m = _DATE_MS_RE.search(val)
        if m:
            try:
                ms = int(m.group(1))
                dt = datetime.datetime.utcfromtimestamp(ms/1000.0)
                return dt.strftime("%Y-%m-%d %H:%M UTC")
            except Exception:
                return val
        return val
    return ""

async def _te_calendar_request(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    url = "https://api.tradingeconomics.com/calendar"
    async with httpx.AsyncClient(timeout=12) as client:
        # a) single key
        if TE_KEY and ":" not in TE_KEY:
            p=dict(params); p["c"]=TE_KEY
            r=await client.get(url, params=p)
            if r.status_code==200 and isinstance(r.json(), list) and r.json():
                return r.json()
            else:
                print("TE single-key status:", r.status_code, r.text[:200])
        # b) client:secret
        if TE_KEY and ":" in TE_KEY:
            client_id, secret = TE_KEY.split(":",1)
            p=dict(params); p["client"]=client_id; p["key"]=secret
            r=await client.get(url, params=p)
            if r.status_code==200 and isinstance(r.json(), list) and r.json():
                return r.json()
            else:
                print("TE client/secret status:", r.status_code, r.text[:200])
        # c) guest fallback
        p=dict(params); p["client"]="guest"; p["key"]="guest"
        r=await client.get(url, params=p)
        if r.status_code==200 and isinstance(r.json(), list):
            return r.json()
        print("TE guest status:", r.status_code, r.text[:200])
    return []

async def _fetch_calendar_us() -> List[Dict[str, Any]]:
    d1 = datetime.date.today()
    d2 = d1 + datetime.timedelta(days=14)
    params = {
        "country": "United States",
        "importance": "2,3",  # medium + high
        "d1": d1.isoformat(),
        "d2": d2.isoformat(),
    }
    raw = await _te_calendar_request(params)
    if not raw:
        return []
    out=[]
    KEYWORDS = (
        "CPI","Consumer Price Index","Inflation",
        "PPI","Producer Price Index",
        "Non-Farm","Nonfarm","Payrolls","Unemployment","FOMC","Average Hourly Earnings"
    )
    for ev in raw:
        title = ev.get("Event") or ev.get("event") or ""
        if not title:
            continue
        country = (ev.get("Country") or ev.get("CountryCode") or "US")
        # Keep macro-sensitive; or keep explicit USD tagged
        currency = (ev.get("Category") or ev.get("Currency") or "").upper()
        if not any(k.lower() in title.lower() for k in KEYWORDS):
            if currency != "USD":  # allow TE items that are clearly USD
                continue
        dt_str   = _fmt_te_date(ev.get("DateUtc") or ev.get("Date") or ev.get("DateSpan") or "")
        actual   = ev.get("Actual") or ev.get("ActualValue") or ev.get("Value") or ""
        forecast = ev.get("Forecast") or ev.get("Estimate") or ""
        previous = ev.get("Previous") or ev.get("Prior") or ""
        out.append({
            "datetime": dt_str, "event": title, "country": country,
            "actual": actual, "forecast": forecast, "previous": previous
        })
    out.sort(key=lambda x: x.get("datetime") or "")
    return out

# ---------- Sentiment ----------
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _an = SentimentIntensityAnalyzer()
except Exception:
    _an = None

def _sentiment_aggregate(news: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not news or _an is None:
        return {"compound": 0.0, "detail": []}
    detail=[]
    for n in news:
        text=(n.get("title") or "")+". "+(n.get("summary") or "")
        vs=_an.polarity_scores(text)
        detail.append({"title": n.get("title"), "score": vs["compound"]})
    comp=sum(d["score"] for d in detail)/len(detail) if detail else 0.0
    return {"compound": comp, "detail": detail}

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
    if c["data"] and now-c["ts"]<TTL["tickers"]:
        return JSONResponse(content=c["data"])
    data=_fetch_tickers_stub()
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    data = await _fetch_news_symbol(symbol)
    return JSONResponse(content=data)

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

@app.get("/api/calendar")
async def api_calendar():
    now=_now(); c=CACHE["calendar"]
    if c["data"] and now-c["ts"]<TTL["calendar"]:
        return JSONResponse(content=c["data"])
    data=await _fetch_calendar_us()
    # Always return something, even if empty
    if not data:
        data = [{"datetime":"","event":"No data (check TE_KEY or rate limit).",
                 "country":"US","actual":"","forecast":"","previous":""}]
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)
