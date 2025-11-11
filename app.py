from __future__ import annotations
import os, time, datetime, re, csv, io, traceback
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

import httpx
import yfinance as yf

# ---------------- Paths (robust for Render) ----------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# ---------------- Env ----------------
load_dotenv(os.path.join(BASE_DIR, ".env"))  # local only
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "")
TE_KEY = os.getenv("TE_KEY", "")  # TradingEconomics (single key OR "client:secret")

# ---------------- FastAPI ----------------
app = FastAPI(title="Market Terminal")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# ---------------- Watchlist (US stocks only, TV supported) ----------------
WATCHLIST: List[str] = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","PYPL","ORCL","IBM","SNOW","ABNB","SHOP",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE",
    "XOM","CVX","CAT","BA","UNH","LLY","MRK","ABBV","UPS","FDX","UBER","LYFT"
]

# ---------------- Cache ----------------
def _now() -> float: return time.time()
CACHE: Dict[str, Any] = {
    "tickers":{"ts":0.0,"data":None},
    "movers":{"ts":0.0,"data":None},
    "market_news":{"ts":0.0,"data":None},
    "calendar":{"ts":0.0,"data":None},
}
TTL = {"tickers": 10, "movers": 30, "market_news": 180, "calendar": 1800}

def _safe_float(x)->Optional[float]:
    try: return float(x)
    except: return None

# ---------------- Stooq fallback (CSV) ----------------
# Stooq returns daily data; good enough to show change vs previous day.
STQ_BASE = "https://stooq.com/q/l/?s={symbols}&i=d"  # CSV

async def _stooq_prices(symbols: List[str]) -> Dict[str, Dict[str, Optional[float]]]:
    """
    Returns {SYM: {"price": last_close, "prev": prev_close}}
    """
    # stooq symbols are lowercase; BRK-B becomes brk-b
    query_syms = ",".join(s.lower() for s in symbols)
    url = STQ_BASE.format(symbols=query_syms)
    out: Dict[str, Dict[str, Optional[float]]] = {s: {"price": None, "prev": None} for s in symbols}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url)
        if r.status_code != 200 or not r.text:
            return out
        # stooq "i=d" endpoint returns one line per symbol with current day only.
        # To calculate change, we hit historical for each symbol (only when needed).
        reader = csv.reader(io.StringIO(r.text))
        # header: Symbol,Date,Time,Open,High,Low,Close,Volume
        rows = list(reader)
        if rows and rows[0] and rows[0][0].lower() == "symbol":
            rows = rows[1:]
        for row in rows:
            try:
                sym_raw = row[0] or ""
                sym = sym_raw.upper()
                close = _safe_float(row[6])
                out[sym]["price"] = close
            except Exception:
                continue
        # fetch prev close (yesterday) per symbol (only for those missing)
        hist_urls = [
            f"https://stooq.com/q/d/l/?s={s.lower()}&i=d" for s in symbols
        ]
        async with httpx.AsyncClient(timeout=10) as client:
            results = await client.gather(*[client.get(u) for u in hist_urls], return_exceptions=True)
        for s, resp in zip(symbols, results):
            try:
                if isinstance(resp, Exception) or resp.status_code != 200: continue
                rdr = csv.reader(io.StringIO(resp.text))
                rows = list(rdr)
                if rows and rows[0] and rows[0][0].lower() == "date":
                    rows = rows[1:]
                if len(rows) >= 2:
                    prev_close = _safe_float(rows[-2][4])  # close column
                    out[s]["prev"] = prev_close
            except Exception:
                pass
        return out
    except Exception as e:
        print("Stooq error:", e)
        return out

# ---------------- Tickers (yfinance with stooq fallback) ----------------
def _compute_change(last: Optional[float], prev: Optional[float]) -> Optional[float]:
    if last is None or prev in (None, 0): return None
    return (last - prev) / prev * 100.0

async def _fetch_tickers(symbols: List[str]) -> List[Dict[str, Any]]:
    # First try yfinance (batched)
    try:
        df = yf.download(
            tickers=" ".join(symbols),
            period="2d", interval="1d",
            auto_adjust=False, progress=False, threads=True
        )
        out: List[Dict[str, Any]] = []
        if getattr(df, "columns", None) is not None and df.columns.nlevels == 2:
            for s in symbols:
                try:
                    closes = df[s]["Close"].dropna()
                    last = _safe_float(closes.iloc[-1]) if len(closes) else None
                    prev = _safe_float(closes.iloc[-2]) if len(closes) > 1 else last
                    chg = _compute_change(last, prev)
                    out.append({"symbol": s, "price": round(last,2) if last else None,
                                "change_pct": round(chg,2) if chg is not None else None})
                except Exception:
                    out.append({"symbol": s, "price": None, "change_pct": None})
        else:
            # single symbol case
            try:
                closes = df["Close"].dropna()
                last = _safe_float(closes.iloc[-1]) if len(closes) else None
                prev = _safe_float(closes.iloc[-2]) if len(closes) > 1 else last
                chg = _compute_change(last, prev)
                out.append({"symbol": symbols[0], "price": round(last,2) if last else None,
                            "change_pct": round(chg,2) if chg is not None else None})
            except Exception:
                out = [{"symbol": symbols[0], "price": None, "change_pct": None}]
        # If yfinance returned all None/zeros, use stooq fallback
        if not any(isinstance(r.get("price"), (int,float)) for r in out):
            raise RuntimeError("yfinance empty; using stooq fallback")
        return out
    except Exception as e:
        print("yfinance error, falling back to stooq:", e)

    # Fallback: Stooq
    stq = await _stooq_prices(symbols)
    out_fallback: List[Dict[str, Any]] = []
    for s in symbols:
        last = stq.get(s, {}).get("price")
        prev = stq.get(s, {}).get("prev")
        chg = _compute_change(last, prev)
        out_fallback.append({
            "symbol": s,
            "price": round(last,2) if last is not None else None,
            "change_pct": round(chg,2) if chg is not None else None
        })
    return out_fallback

async def _fetch_quote(symbol: str) -> Dict[str, Any]:
    # Try yfinance fast_info first
    try:
        t = yf.Ticker(symbol)
        fi = getattr(t, "fast_info", None) or {}
        prev = fi.get("previous_close")
        last = fi.get("last_price") or fi.get("last_traded") or fi.get("last")
        chg = _compute_change(_safe_float(last), _safe_float(prev))
        if last or prev:
            return {
                "symbol": symbol,
                "price": round(float(last),2) if last else None,
                "change_pct": round(float(chg),2) if chg is not None else None,
                "day_low": fi.get("day_low"), "day_high": fi.get("day_high"),
                "year_low": fi.get("year_low"), "year_high": fi.get("year_high"),
                "volume": fi.get("volume"), "market_cap": fi.get("market_cap"),
                "previous_close": prev
            }
    except Exception as e:
        print("quote yfinance error:", e)

    # Fallback: Stooq last & prev
    stq = await _stooq_prices([symbol])
    last = stq.get(symbol, {}).get("price")
    prev = stq.get(symbol, {}).get("prev")
    chg = _compute_change(last, prev)
    return {
        "symbol": symbol,
        "price": round(last,2) if last is not None else None,
        "change_pct": round(chg,2) if chg is not None else None,
        "previous_close": prev
    }

def _compute_movers(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    valid = [r for r in rows if isinstance(r.get("change_pct"), (int,float))]
    valid.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"gainers": valid[:8], "losers": list(reversed(valid[-8:]))}

# ---------------- News (NewsAPI) ----------------
async def _fetch_news_symbol(symbol:str, page_size:int=20)->List[Dict[str,Any]]:
    if not NEWS_API_KEY:
        return [{"title":"Add NEWS_API_KEY in Render → Environment to enable live headlines.",
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

# ---------------- TradingEconomics Calendar (robust + guest fallback) ----------------
_DATE_MS_RE = re.compile(r"/Date\((\d+)")
def _fmt_te_date(val: Any) -> str:
    if isinstance(val, (int, float)):
        dt = datetime.datetime.utcfromtimestamp(val/1000.0)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    if isinstance(val, str):
        m = _DATE_MS_RE.search(val)
        if m:
            try:
                ms = int(m.group(1)); dt = datetime.datetime.utcfromtimestamp(ms/1000.0)
                return dt.strftime("%Y-%m-%d %H:%M UTC")
            except Exception:
                return val
        return val
    return ""

async def _te_get(url: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=12) as client:
        r = await client.get(url, params=params)
        if r.status_code == 200 and isinstance(r.json(), list):
            return r.json()
        return []

async def _te_calendar_request(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    base = "https://api.tradingeconomics.com/calendar"
    # try with your key (single)
    if TE_KEY and ":" not in TE_KEY:
        data = await _te_get(base, {**params, "c": TE_KEY})
        if data: return data
    # try client:secret
    if TE_KEY and ":" in TE_KEY:
        client_id, secret = TE_KEY.split(":",1)
        data = await _te_get(base, {**params, "client": client_id, "key": secret})
        if data: return data
    # try country endpoint + guest
    data = await _te_get(f"{base}/country/united%20states", {**params, "client":"guest", "key":"guest"})
    if data: return data
    # fallback: base + guest
    return await _te_get(base, {**params, "client":"guest", "key":"guest"})

async def _fetch_calendar_us() -> List[Dict[str, Any]]:
    d1 = datetime.date.today()
    d2 = d1 + datetime.timedelta(days=14)
    params = {"importance":"2,3","d1":d1.isoformat(),"d2":d2.isoformat()}
    raw = await _te_calendar_request(params)
    if not raw: return []
    KEYWORDS = ("CPI","Consumer Price Index","Inflation","PPI","Producer Price Index",
                "Non-Farm","Nonfarm","Payrolls","Unemployment","FOMC","Average Hourly Earnings")
    out=[]
    for ev in raw:
        title = (ev.get("Event") or ev.get("event") or "").strip()
        if not title: continue
        country = ev.get("Country") or ev.get("CountryCode") or ""
        currency = (ev.get("Category") or ev.get("Currency") or "").upper()
        if country and country != "United States" and currency != "USD":
            continue
        if not any(k.lower() in title.lower() for k in KEYWORDS) and currency != "USD":
            continue
        dt_str   = _fmt_te_date(ev.get("DateUtc") or ev.get("Date") or ev.get("DateSpan") or "")
        out.append({
            "datetime": dt_str,
            "event": title,
            "country": country or "US",
            "actual": ev.get("Actual") or ev.get("ActualValue") or ev.get("Value") or "",
            "forecast": ev.get("Forecast") or ev.get("Estimate") or "",
            "previous": ev.get("Previous") or ev.get("Prior") or "",
        })
    out.sort(key=lambda x: x.get("datetime") or "")
    return out

# ---------------- Sentiment ----------------
try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
    _an = SentimentIntensityAnalyzer()
except Exception:
    _an = None

def _sentiment_aggregate(news: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not news or _an is None: return {"compound": 0.0, "detail": []}
    detail=[]; 
    for n in news:
        text=(n.get("title") or "")+". "+(n.get("summary") or "")
        vs=_an.polarity_scores(text)
        detail.append({"title": n.get("title"), "score": vs["compound"]})
    comp = sum(d["score"] for d in detail)/len(detail) if detail else 0.0
    return {"compound": comp, "detail": detail}

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
    rows = await _fetch_tickers(WATCHLIST)
    # duplicate to keep the bar visually full
    data = rows
    if len(rows) < 25:
        data = rows * (25 // max(1,len(rows)) + 1)
        data = data[:max(25, len(rows))]
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/movers")
async def api_movers():
    now=_now(); c=CACHE["movers"]
    if c["data"] and now-c["ts"]<TTL["movers"]:
        return JSONResponse(content=c["data"])
    rows = await _fetch_tickers(WATCHLIST)
    data = _compute_movers(rows)
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

@app.get("/api/quote")
async def api_quote(symbol: str = Query(...)):
    q = await _fetch_quote(symbol)
    return JSONResponse(content=q)

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

@app.get("/api/calendar")
async def api_calendar():
    now=_now(); c=CACHE["calendar"]
    if c["data"] and now-c["ts"]<TTL["calendar"]:
        return JSONResponse(content=c["data"])
    data=await _fetch_calendar_us()
    if not data:
        data=[{"datetime":"","event":"No data (TradingEconomics limit / key missing).",
               "country":"US","actual":"","forecast":"","previous":""}]
    c["ts"]=now; c["data"]=data
    return JSONResponse(content=data)

if __name__=="__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
