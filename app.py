from __future__ import annotations
import os, time, datetime, re
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

import httpx, yfinance as yf

# Load env
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))

app = FastAPI(title="Market Terminal")

# Static & templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

NEWS_API_KEY = os.getenv("NEWS_API_KEY", "")
TE_KEY = os.getenv("TE_KEY")  # TradingEconomics key (single or "client:key")

TICKER_SYMBOLS: List[str] = [
    "AAPL","MSFT","AMZN","TSLA","NVDA","META","GOOGL","AMD",
    "NFLX","JPM","BAC","XOM","INTC","AVGO","PEP","KO","DIS",
    "PFE","NKE","BA","BTC-USD","ETH-USD","XRP-USD"
]

CACHE: Dict[str, Any] = {
    "tickers":{"ts":0.0,"data":None},
    "market_news":{"ts":0.0,"data":None},
    "calendar":{"ts":0.0,"data":None},
}
CACHE_TTL = {"tickers": 5, "market_news": 180, "calendar": 1800}

def _now() -> float:
    return time.time()

# --------------------- Tickers ---------------------
def _fetch_tickers(symbols:List[str])->List[Dict[str,Any]]:
    res=[]
    for s in symbols:
        price=change=None
        try:
            t=yf.Ticker(s)
            info=t.info
            price=info.get("regularMarketPrice")
            prev=info.get("regularMarketPreviousClose") or info.get("previousClose")
            if price is None or prev is None:
                hist=t.history(period="2d")
                if not hist.empty:
                    price=float(hist["Close"].iloc[-1])
                    prev=float(hist["Close"].iloc[-2]) if len(hist["Close"])>1 else price
            if price and prev:
                change=(price-prev)/prev*100.0
        except Exception:
            pass
        symbol_for_ui = s.replace("-USD","USDT").replace("-","")
        res.append({
            "symbol": symbol_for_ui,
            "price": float(price) if price is not None else None,
            "change_pct": float(change) if change is not None else None
        })
    return res

# --------------------- News ---------------------
async def _fetch_news_symbol(symbol:str, page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY: return []
    try:
        url="https://newsapi.org/v2/everything"
        params={"q":symbol,"language":"en","sortBy":"publishedAt","pageSize":page_size}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=10) as client:
            r=await client.get(url, params=params, headers=headers)
            if r.status_code!=200: return []
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
            return out
    except Exception:
        return []

async def _fetch_market_news(page_size:int=20)->List[Dict[str,Any]]:
    # US business headlines (general, not tied to a ticker)
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY to .env for live US market headlines","url":"#","source":"Local"}]
    try:
        url="https://newsapi.org/v2/top-headlines"
        params={"country":"us","category":"business","pageSize":page_size}
        headers={"X-Api-Key": NEWS_API_KEY}
        async with httpx.AsyncClient(timeout=10) as client:
            r=await client.get(url, params=params, headers=headers)
            if r.status_code!=200: return []
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
            return out
    except Exception:
        return []

# --------------------- TradingEconomics Calendar (robust) ---------------------
_DATE_MS_RE = re.compile(r"/Date\((\d+)")
def _fmt_te_date(val: Any) -> str:
    """
    TE sometimes returns '/Date(1700000000000)/'. Convert to 'YYYY-MM-DD HH:MM UTC'.
    Otherwise pass through string.
    """
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

async def _te_calendar_request(params: Dict[str, Any], key: Optional[str]) -> List[Dict[str, Any]]:
    """Try both auth styles; return raw TE events or []"""
    url = "https://api.tradingeconomics.com/calendar"
    async with httpx.AsyncClient(timeout=12) as client:
        # 1) single key ?c=KEY
        if key:
            p = dict(params)
            p["c"] = key
            r = await client.get(url, params=p)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and data:
                    return data
        # 2) legacy pair ?client=...&key=...
        if key and ":" in key:
            client_id, secret = key.split(":", 1)
            p = dict(params)
            p.pop("c", None)
            p["client"] = client_id
            p["key"] = secret
            r = await client.get(url, params=p)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, list) and data:
                    return data
        # 3) demo fallback guest:guest to guarantee rows
        p = dict(params)
        p.pop("c", None)
        p["client"] = "guest"
        p["key"] = "guest"
        r = await client.get(url, params=p)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                return data
    return []

async def _fetch_calendar_high_impact() -> List[Dict[str, Any]]:
    """
    USD-only, importance = medium + high. Not tied to the selected ticker.
    Returns [{datetime,event,country,actual,forecast,previous}]
    """
    d1 = datetime.date.today()
    d2 = d1 + datetime.timedelta(days=14)

    # TE can be picky; try a few variants that should all represent USD/US events
    country_variants = ["United States", "united states", "US"]
    importance_variants = ["2,3", "3,2"]  # medium+high

    KEYWORDS = (
        "CPI","Consumer Price Index","Inflation",
        "PPI","Producer Price Index",
        "Non-Farm","Nonfarm","Payrolls","Unemployment","FOMC","Average Hourly Earnings"
    )

    # Try multiple request shapes until we get rows
    raw: List[Dict[str, Any]] = []
    for country in country_variants:
        for imp in importance_variants:
            params = {
                "country": country,
                "importance": imp,
                "d1": d1.isoformat(),
                "d2": d2.isoformat(),
                # 'group': 'currency'  # not required but exists in some TE docs
            }
            raw = await _te_calendar_request(params, TE_KEY)
            if raw:
                break
        if raw:
            break

    if not raw:
        return []

    out: List[Dict[str, Any]] = []
    for ev in raw:
        title = ev.get("Event") or ev.get("event") or ""
        country = ev.get("Country") or ev.get("CountryCode") or "US"
        currency = (ev.get("Category") or ev.get("Currency") or "").upper()

        # Keep USD/US only, and broadly macro-sensitive items (CPI/PPI/NFP/unemployment, etc.)
        if country.lower() not in ("united states","us"):
            continue
        if not any(k.lower() in title.lower() for k in KEYWORDS):
            # still allow if TE marks currency explicitly as USD
            if currency != "USD":
                continue

        dt_str   = _fmt_te_date(ev.get("DateUtc") or ev.get("Date") or ev.get("DateSpan") or "")
        actual   = ev.get("Actual") or ev.get("ActualValue") or ev.get("Value")
        forecast = ev.get("Forecast") or ev.get("Estimate")
        previous = ev.get("Previous") or ev.get("Prior")

        out.append({
            "datetime": dt_str,
            "event": title,
            "country": country,
            "actual": actual if actual is not None else "",
            "forecast": forecast if forecast is not None else "",
            "previous": previous if previous is not None else "",
        })

    # sort by datetime text (already ISO-ish)
    out.sort(key=lambda x: x.get("datetime") or "")
    return out

# --------------------- Sentiment ---------------------
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

# --------------------- Routes ---------------------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now=_now(); c=CACHE["tickers"]
    if c["data"] and now-c["ts"]<CACHE_TTL["tickers"]:
        return JSONResponse(content=c["data"])
    data=_fetch_tickers(TICKER_SYMBOLS)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

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
    if c["data"] and now-c["ts"]<CACHE_TTL["market_news"]:
        return JSONResponse(content=c["data"])
    data=await _fetch_market_news(page_size=30)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/calendar")
async def api_calendar():
    now=_now(); c=CACHE["calendar"]
    if c["data"] and now-c["ts"]<CACHE_TTL["calendar"]:
        return JSONResponse(content=c["data"])
    data=await _fetch_calendar_high_impact()
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
