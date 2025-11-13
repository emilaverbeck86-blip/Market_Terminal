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
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

async def _get(url: str, params: Dict[str, Any] | None = None, timeout: float = 10.0):
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=4.0),
            headers=BASE_HEADERS
        ) as client:
            r = await client.get(url, params=params)
            if r.status_code == 200:
                return r
    except Exception:
        pass
    return None

# ---------- QUOTES ----------
async def _yahoo_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    """Yahoo query1 -> query2 retry. Returns price/change_pct or None."""
    out: List[Dict[str, Any]] = []
    if not symbols:
        return out

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
                # Try several fields Yahoo uses
                for pk in ("regularMarketPrice", "postMarketPrice", "bid"):
                    if q.get(pk) is not None:
                        price = float(q[pk]); break
                for ck in ("regularMarketChangePercent", "postMarketChangePercent"):
                    if q.get(ck) is not None:
                        chg = float(q[ck]); break
            out.append({
                "symbol": s,
                "price": round(price, 2) if price is not None else None,
                "change_pct": round(chg, 2) if chg is not None else None
            })
    # guarantee all symbols present
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
    if not r:
        return out
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
                if c is not None and o not in (None, 0):
                    chg = round((c - o) / o * 100.0, 2)
        except Exception:
            pass
        out[symbols.index(s)] = {"symbol": s, "price": price, "change_pct": chg}
    return out

async def _stable_quotes(symbols: List[str]) -> List[Dict[str, Any]]:
    data = await _yahoo_quotes(symbols)
    if all(d.get("price") is None for d in data):
        data = await _stooq_quotes(symbols)
    # keep movers alive
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
    start = close.iloc[-(bdays+1)]
    last  = close.iloc[-1]
    if not start: return None
    return float((last - start) / start * 100.0)

# --- expanded curated descriptions (3–5 sentences) ---
CURATED_DESC = {
    "AAPL": "Apple Inc. designs and sells iPhone, iPad, Mac and wearables, tightly integrated with its software platforms iOS, macOS and watchOS. The company monetizes services such as the App Store, Apple Music, iCloud and Apple TV+. Apple’s ecosystem drives high customer retention and recurring revenue. It is expanding into on-device AI to deepen platform engagement.",
    "MSFT": "Microsoft develops Windows, Office and the Azure cloud platform. Azure and Office 365 are subscription-driven, providing recurring revenue at scale. The company owns LinkedIn, GitHub and Xbox, and invests heavily in AI through Copilot and its partnership with OpenAI. Commercial cloud is the primary growth engine.",
    "NVDA": "NVIDIA designs GPUs and accelerated computing platforms. Its data-center products power AI training and inference for hyperscalers and enterprises. The CUDA ecosystem and software stack are key differentiators. NVIDIA also addresses gaming, professional visualization and automotive markets.",
    "AMZN": "Amazon operates a global e-commerce marketplace and logistics network. AWS provides cloud infrastructure and platform services with industry-leading scale. Advertising and Prime subscriptions add high-margin revenue streams. The company continues to invest in automation, AI and last-mile delivery.",
    "META": "Meta Platforms operates Facebook, Instagram, WhatsApp and Messenger. It monetizes primarily through targeted advertising while investing in AI for ranking and recommendations. The company is also building infrastructure for mixed reality and the metaverse. Messaging and Reels engagement are key focus areas.",
    "GOOGL": "Alphabet spans Google Search, YouTube, Android and Google Cloud. Advertising is the core business, while Cloud is growing rapidly. Alphabet invests in AI for search, generative models and productivity. Other Bets fund long-term initiatives like Waymo.",
    "TSLA": "Tesla manufactures electric vehicles and energy storage solutions. The company focuses on vertical integration, software-defined vehicles and manufacturing efficiency. Energy generation and storage complement its automotive segment. Autonomy and next-gen platforms are strategic priorities.",
    "SPY": "SPDR S&P 500 ETF Trust tracks the S&P 500 index, providing exposure to large-cap U.S. equities. The fund is widely used for beta exposure and asset allocation. Liquidity and tight tracking are distinguishing features.",
    "QQQ": "Invesco QQQ Trust tracks the Nasdaq-100 index, emphasizing large-cap growth and technology. It is frequently used by investors for tech-tilted exposure. High liquidity and options depth are key attributes."
}

async def _profile(symbol: str) -> Dict[str, str]:
    if symbol in CURATED_DESC:
        return {"symbol":symbol, "name":symbol, "description":CURATED_DESC[symbol]}
    return {"symbol":symbol, "name":symbol, "description":"Publicly traded U.S. company with operations spanning multiple segments and revenue streams."}

# ---------- news (unchanged) ----------
async def _market_news(limit=30)->List[Dict[str,Any]]:
    # keep your previous logic (Finnhub/NewsAPI) — omitted here for brevity
    return []

# ---------- routes ----------
@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    idx = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(idx): return PlainTextResponse("templates/index.html not found.", status_code=500)
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
    gainers = valid[:10]
    losers  = list(reversed(valid[-10:]))
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
