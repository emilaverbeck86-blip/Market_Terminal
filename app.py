import os
from datetime import datetime, timezone
from typing import List, Dict, Any

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

static_dir = os.path.join(BASE_DIR, "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

# ---------- Config ----------

WATCHLIST = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA",
    "AVGO", "AMD", "NFLX", "ADBE", "INTC", "CSCO",
    "QCOM", "TXN", "CRM", "JPM", "BAC", "WFC", "GS",
    "V", "MA", "XOM", "CVX", "UNH", "LLY", "ABBV"
]

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
YAHOO_PROFILE_URL = (
    "https://query1.finance.yahoo.com/v10/finance/quoteSummary/{symbol}"
    "?modules=assetProfile"
)
YAHOO_NEWS_URL = (
    "https://query2.finance.yahoo.com/v1/finance/search"
)  # q, newsCount


# ---------- Utility helpers ----------

def yahoo_quotes(symbols: List[str]) -> Dict[str, Dict[str, Any]]:
    if not symbols:
        return {}
    params = {"symbols": ",".join(symbols)}
    r = requests.get(YAHOO_QUOTE_URL, params=params, timeout=8)
    r.raise_for_status()
    data = r.json().get("quoteResponse", {}).get("result", [])
    out: Dict[str, Dict[str, Any]] = {}
    for q in data:
        sym = q.get("symbol")
        if not sym:
            continue
        price = q.get("regularMarketPrice")
        change = q.get("regularMarketChangePercent")
        out[sym] = {
            "symbol": sym,
            "price": float(price) if price is not None else None,
            "change_pct": float(change) if change is not None else None,
        }
    return out


def yahoo_perf_and_profile(symbol: str) -> Dict[str, Any]:
    # Performance: use 1Y daily chart and compute 1W/1M/3M/6M/YTD/1Y
    out = {
        "symbol": symbol,
        "perf": {},
        "profile": "",
    }
    try:
        chart_params = {"range": "1y", "interval": "1d"}
        cr = requests.get(
            YAHOO_CHART_URL.format(symbol=symbol),
            params=chart_params,
            timeout=10,
        )
        cr.raise_for_status()
        cdata = cr.json()["chart"]["result"][0]
        closes = cdata["indicators"]["quote"][0]["close"]
        timestamps = cdata["timestamp"]
        if not closes or not timestamps:
            raise ValueError("No chart data")

        series = [
            (datetime.fromtimestamp(t, tz=timezone.utc), c)
            for t, c in zip(timestamps, closes)
            if c is not None
        ]
        if not series:
            raise ValueError("Empty series")

        series.sort(key=lambda x: x[0])
        end_price = series[-1][1]
        end_date = series[-1][0].date()

        def pct_change(days: int) -> float | None:
            target_date = end_date.toordinal() - days
            # find first point with date ordinal <= target_date
            candidates = [p for (d, p) in series if d.date().toordinal() <= target_date]
            if not candidates:
                return None
            start = candidates[-1]
            return (end_price - start) / start * 100.0 if start else None

        out["perf"] = {
            "1W": pct_change(7),
            "1M": pct_change(30),
            "3M": pct_change(90),
            "6M": pct_change(180),
            "YTD": pct_change(end_date.timetuple().tm_yday - 1),
            "1Y": pct_change(365),
        }
    except Exception:
        pass

    # Profile
    try:
        pr = requests.get(YAHOO_PROFILE_URL.format(symbol=symbol), timeout=8)
        pr.raise_for_status()
        result = pr.json()["quoteSummary"]["result"]
        if result:
            summary = result[0]["assetProfile"].get("longBusinessSummary", "")
            if summary:
                # shorten to ~6 sentences
                parts = summary.split(". ")
                out["profile"] = ". ".join(parts[:6]).strip()
    except Exception:
        pass

    return out


def yahoo_symbol_news(symbol: str, limit: int = 30) -> List[Dict[str, Any]]:
    try:
        params = {"q": symbol, "newsCount": limit}
        r = requests.get(YAHOO_NEWS_URL, params=params, timeout=8)
        r.raise_for_status()
        data = r.json()
        items = data.get("news", [])
        out = []
        for n in items:
            title = n.get("title")
            link = n.get("link")
            publisher = n.get("publisher")
            ts = n.get("providerPublishTime")
            if not title or not link:
                continue
            when = ""
            if ts:
                dt = datetime.fromtimestamp(ts, tz=timezone.utc)
                when = dt.strftime("%Y-%m-%d %H:%M UTC")
            out.append(
                {
                    "title": title,
                    "url": link,
                    "source": publisher or "",
                    "published_at": when,
                }
            )
        return out
    except Exception:
        # fallback: empty list
        return []


# ---------- Routes: pages ----------

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(
        "index.html",
        {"request": request},
    )


@app.get("/fundamentals", response_class=HTMLResponse)
async def fundamentals_page(request: Request):
    return templates.TemplateResponse(
        "fundamentals.html",
        {"request": request},
    )


# ---------- Routes: APIs ----------

@app.get("/api/tickers")
async def api_tickers():
    quotes = yahoo_quotes(WATCHLIST)
    data = []
    for sym in WATCHLIST:
        q = quotes.get(sym, {"symbol": sym, "price": None, "change_pct": None})
        data.append(q)
    return JSONResponse(data)


@app.get("/api/insights")
async def api_insights(symbol: str):
    info = yahoo_perf_and_profile(symbol)
    # convert None to null-friendly
    return JSONResponse(info)


@app.get("/api/news")
async def api_news(symbol: str):
    return JSONResponse(yahoo_symbol_news(symbol))


@app.get("/api/movers")
async def api_movers():
    quotes = yahoo_quotes(WATCHLIST)
    items = list(quotes.values())
    items = [q for q in items if q.get("change_pct") is not None]
    if not items:
        return JSONResponse({"gainers": [], "losers": []})

    items.sort(key=lambda x: x["change_pct"])
    losers = items[:5]
    gainers = items[-5:][::-1]
    return JSONResponse({"gainers": gainers, "losers": losers})


# simple health check
@app.get("/health")
async def health():
    return {"status": "ok"}
