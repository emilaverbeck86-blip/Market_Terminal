from __future__ import annotations
import os, io, csv, time, datetime as dt
from typing import Any, Dict, List, Optional

import httpx
import pandas as pd
from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

# ---- paths / app ----
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

# ---- optional API keys ----
NEWS_API_KEY = os.getenv("NEWS_API_KEY", "").strip()
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "").strip()
TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "").strip()

# ---- watchlist ----
WATCHLIST = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AVGO","AMD","NFLX","ADBE",
    "INTC","CSCO","QCOM","TXN","CRM","ORCL","IBM","NOW","SNOW","ABNB","SHOP","PYPL",
    "JPM","BAC","WFC","GS","MS","V","MA","AXP","BRK-B","SCHW",
    "KO","PEP","PG","MCD","COST","HD","LOW","DIS","NKE","SBUX","TGT","WMT",
    "T","VZ","CMCSA","XOM","CVX","COP","CAT","BA","GE","UPS","FDX","DE",
    "UNH","LLY","MRK","ABBV","JNJ","PFE","UBER","BKNG","SPY","QQQ","DIA","IWM"
]

# ---- caching ----
def _now() -> float: return time.time()
CACHE: Dict[str, Dict[str, Any]] = {
    "tickers": {"ts": 0.0, "data": None},
    "market_news": {"ts": 0.0, "data": None},
}
TTL = {"tickers": 25, "market_news": 180}

BASE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124 Safari/537.36"),
    "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9",
}

async def _get(url: str, params: Dict[str, Any] | None = None, timeout: float = 10.0):
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=4.0),
                                     headers=BASE_HEADERS) as client:
            r = await client.get(url, params=params)
            if r.status_code == 200:
                return r
    except Exception:
        pass
    return None

# ---------- QUOTES ----------
async def _yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    if not symbols: return out
    endpoints = [
        "https://query1.finance.yahoo.com/v7/finance/quote",
        "https://query2.finance.yahoo.com/v7/finance/quote",
    ]
    chunks = [symbols[i:i+35] for i in range(0, len(symbols), 35)]
    for ch in chunks:
        data = None
        for ep in endpoints:
            r = await _get(ep, params={"symbols": ",".join(ch)})
            if r:
                try:
                    data = r.json().get("quoteResponse", {}).get("result", [])
                except Exception:
                    data = None
            if data is not None:
                break
        by_sym = { (d.get("symbol","") or "").upper(): d for d in (data or []) }
        for s in ch:
            q = by_sym.get(s.upper()) or by_sym.get(s.replace(".", "-").upper())
            price, chg = None, None
            if q:
                for pk in ("regularMarketPrice", "postMarketPrice", "bid"):
                    if q.get(pk) is not None: price = float(q[pk]); break
                for ck in ("regularMarketChangePercent", "postMarketChangePercent"):
                    if q.get(ck) is not None: chg = float(q[ck]); break
            out.append({"symbol": s,
                        "price": round(price,2) if price is not None else None,
                        "change_pct": round(chg,2) if chg is not None else None})
    # ensure all present
    seen = {o["symbol"] for o in out}
    for s in symbols:
        if s not in seen:
            out.append({"symbol": s, "price": None, "change_pct": None})
    return out

def _stooq_symbol(sym: str) -> str:
    return f"{sym.lower().replace('.', '-').replace('_', '-')}.us"

async def _stooq_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    url = "https://stooq.com/q/l/"
    s_param = ",".join([_stooq_symbol(s) for s in symbols])
    r = await _get(url, params={"s": s_param, "f": "sd2t2ohlc"})
    out: List[Dict[str, Any]] = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    if not r: return out
    reader = csv.DictReader(io.StringIO(r.text))
    rows_by_sym = { (row.get("Symbol") or "").strip().lower(): row for row in reader }
    for s in symbols:
        row = rows_by_sym.get(_stooq_symbol(s))
        price, chg = None, None
        try:
            if row:
                c = None if row.get("Close") in (None, "", "-") else float(row["Close"])
                o = None if row.get("Open")  in (None, "", "-") else float(row["Open"])
                if c is not None: price = round(c, 2)
                if c is not None and o not in (None, 0): chg = round((c - o) / o * 100.0, 2)
        except Exception: pass
        out[symbols.index(s)] = {"symbol": s, "price": price, "change_pct": chg}
    return out

async def _twelvedata_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    out = [{"symbol": s, "price": None, "change_pct": None} for s in symbols]
    if not TWELVEDATA_API_KEY or not symbols: return out
    # TD supports comma-separated list
    r = await _get("https://api.twelvedata.com/quote",
                   params={"symbol": ",".join(symbols), "apikey": TWELVEDATA_API_KEY})
    if not r: return out
    js = r.json()
    def _one(obj: Dict[str, Any]) -> Dict[str, Any]:
        try:
            price = float(obj.get("price")) if obj.get("price") not in (None,"") else None
            pct = obj.get("percent_change") or obj.get("change_percent")
            chg = float(pct) if pct not in (None,"") else None
        except Exception:
            price, chg = None, None
        return {"price": round(price,2) if price is not None else None,
                "change_pct": round(chg,2) if chg is not None else None}
    # TD may return keyed dict or single object
    for i,s in enumerate(symbols):
        node = js.get(s) if isinstance(js, dict) and s in js else js
        if isinstance(node, dict):
            res = _one(node)
        elif isinstance(node, list) and node:
            res = _one(node[0])
        else:
            res = {"price": None, "change_pct": None}
        out[i].update(res)
    return out

async def _stable_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    data = await _yahoo_quotes(symbols)
    if all(d.get("price") is None for d in data):
        data = await _stooq_quotes(symbols)
    # optional third fallback
    if all(d.get("price") is None for d in data):
        data = await _twelvedata_quotes(symbols)
    for d in data:
        if d["price"] is not None and d.get("change_pct") is None:
            d["change_pct"] = 0.0
    return data

# ---------- metrics / profile ----------
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
    start = close.iloc[-(bdays+1)]; last  = close.iloc[-1]
    if not start: return None
    return float((last - start) / start * 100.0)

CURATED_DESC = {
    "AAPL": "Apple Inc. designs and sells iPhone, iPad, Mac and wearables, tightly integrated with iOS, macOS and watchOS. It monetizes services such as the App Store, Apple Music, iCloud and TV+. The ecosystem drives retention and recurring revenue, and Apple is adding on-device AI to deepen engagement.",
    "MSFT": "Microsoft develops Windows, Office and Azure cloud. Commercial cloud and Office 365 subscriptions are the main growth engines. The company owns LinkedIn, GitHub and Xbox, and is rolling out Copilot across products via its AI investments.",
    "NVDA": "NVIDIA builds GPUs and full AI/accelerated-computing platforms. Data-center products power training and inference for hyperscalers. Its CUDA software stack is a key moat, while gaming, ProViz and auto add diversification.",
    "AMZN": "Amazon runs a global e-commerce marketplace and logistics network. AWS provides cloud infrastructure with industry-leading scale. Advertising and Prime subscriptions add high-margin recurring revenue; investments continue in AI and automation.",
    "META": "Meta Platforms operates Facebook, Instagram and WhatsApp. Advertising is the core business, supported by AI ranking and recommendations. The company is investing in mixed reality and continues to grow messaging engagement.",
    "GOOGL": "Alphabet spans Google Search, YouTube, Android and Google Cloud. Ads remain the profit engine, while Cloud grows rapidly. Alphabet invests in AI for search and productivity; Other Bets like Waymo target longer-term opportunities.",
    "TSLA": "Tesla manufactures EVs and energy storage. It focuses on vertical integration, software-defined vehicles and manufacturing efficiency. Energy and autonomy initiatives complement its automotive business.",
    "SPY": "SPDR S&P 500 ETF provides broad U.S. large-cap exposure. High liquidity and tight tracking make it a portfolio staple.",
    "QQQ": "Invesco QQQ tracks the Nasdaq-100, providing tech-tilted large-cap exposure with deep liquidity."
}

async def _profile(symbol: str) -> Dict[str, str]:
    if symbol in CURATED_DESC:
        return {"symbol":symbol, "name":symbol, "description":CURATED_DESC[symbol]}
    return {"symbol":symbol, "name":symbol,
            "description":"Publicly traded U.S. company with diversified operations and ongoing investment in growth and efficiency."}

# ---------- market news ----------
async def _market_news(limit=40)->List[Dict[str,Any]]:
    # Finnhub general news
    if FINNHUB_API_KEY:
        r = await _get("https://finnhub.io/api/v1/news", params={"category":"general","minId":0,"token":FINNHUB_API_KEY})
        if r:
            data=r.json()[:limit]
            return [{"title":a.get("headline"),"url":a.get("url"),"source":a.get("source"),
                     "summary":a.get("summary") or "", "published_at":a.get("datetime")} for a in data]
    # NewsAPI top business
    if NEWS_API_KEY:
        r = await _get("https://newsapi.org/v2/top-headlines",
                       params={"country":"us","category":"business","pageSize":limit,"apiKey":NEWS_API_KEY})
        if r:
            data=r.json()
            return [{"title":a.get("title"),"url":a.get("url"),
                     "source":(a.get("source") or {}).get("name"),
                     "summary":a.get("description"),"published_at":a.get("publishedAt")}
                    for a in data.get("articles", [])]
    # Yahoo search fallback (no key)
    r = await _get("https://query1.finance.yahoo.com/v1/finance/search",
                   params={"q":"markets","quotesCount":0,"newsCount":limit})
    if r:
        data=r.json().get("news",[])
        return [{"title":n.get("title"),"url":(n.get("link") or {}).get("url"),
                 "source":(n.get("publisher") or "Yahoo"),"summary":"", "published_at":""} for n in data]
    return []

# ---------- routes ----------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx):
        return PlainTextResponse("templates/index.html not found.", status_code=500)
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/tickers")
async def api_tickers():
    now=_now(); c=CACHE["tickers"]
    if c["data"] and now-c["ts"]<TTL["tickers"]: return JSONResponse(c["data"])
    data=await _stable_quotes(WATCHLIST)
    c["data"]=data; c["ts"]=now
    return JSONResponse(data)

@app.get("/api/movers")
async def api_movers():
    rows = CACHE["tickers"]["data"] or (await _stable_quotes(WATCHLIST))
    valid = [r for r in rows if (r.get("price") is not None)]
    valid.sort(key=lambda x: (x.get("change_pct") if x.get("change_pct") is not None else 0.0), reverse=True)
    gainers = valid[:10]; losers  = list(reversed(valid[-10:]))
    return JSONResponse({"gainers": gainers, "losers": losers})

@app.get("/api/metrics")
async def api_metrics(symbol: str = Query(...)):
    close = await _stooq_history(symbol, days=800)
    perf = {"1W": _ret(close, 5), "1M": _ret(close, 21), "3M": _ret(close, 63),
            "6M": _ret(close, 126), "YTD": None, "1Y": _ret(close, 252)}
    y = dt.datetime.utcnow().year
    yseg = close[close.index.year == y] if not close.empty else pd.Series(dtype=float)
    if not yseg.empty: perf["YTD"] = float((close.iloc[-1] - yseg.iloc[0]) / yseg.iloc[0] * 100.0)
    prof = await _profile(symbol)
    return JSONResponse({"symbol": symbol, "performance": perf, "profile": prof})

@app.get("/api/news")
async def api_news(symbol: str = Query(...)):
    # Quick per-symbol news via Yahoo Search fallback (no key)
    r = await _get("https://query1.finance.yahoo.com/v1/finance/search",
                   params={"q":symbol, "quotesCount":0, "newsCount":30})
    if r:
        data=r.json().get("news",[])
        return JSONResponse([{"title":n.get("title"),"url":(n.get("link") or {}).get("url"),
                              "source":(n.get("publisher") or "Yahoo"),"summary":"", "published_at":""}
                             for n in data])
    return JSONResponse([])

@app.get("/api/market-news")
async def api_market_news():
    now=_now(); c=CACHE["market_news"]
    if c["data"] and now-c["ts"]<TTL["market_news"]: return JSONResponse(c["data"])
    data=await _market_news(50)
    c["data"]=data; c["ts"]=now
    return JSONResponse(data)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT","8000")), workers=1)
