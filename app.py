import time
from datetime import datetime, timezone
from typing import List, Dict, Any
import xml.etree.ElementTree as ET

import requests
import yfinance as yf
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI()

# Static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ---------------------------------------------------------------------------
# Constants / Config
# ---------------------------------------------------------------------------

YAHOO_QUOTE_URL = "https://query1.finance.yahoo.com/v7/finance/quote"
YAHOO_NEWS_RSS = "https://feeds.finance.yahoo.com/rss/2.0/headline"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

WATCHLIST: List[str] = [
    "AAPL", "MSFT", "NVDA", "META", "GOOGL", "TSLA", "AVGO", "AMD",
    "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "TXN", "CRM",
    "JPM", "BAC", "WFC", "GS", "V", "MA",
    "XOM", "CVX", "UNH", "LLY", "ABBV",
]

FALLBACK_QUOTES: List[Dict[str, Any]] = [
    {"symbol": "AAPL", "price": 192.32, "change_pct": 0.85},
    {"symbol": "MSFT", "price": 417.56, "change_pct": 0.42},
    {"symbol": "NVDA", "price": 123.12, "change_pct": -1.18},
    {"symbol": "META", "price": 480.76, "change_pct": 0.25},
    {"symbol": "GOOGL", "price": 156.18, "change_pct": -0.12},
    {"symbol": "TSLA", "price": 182.44, "change_pct": -2.34},
    {"symbol": "AVGO", "price": 1588.42, "change_pct": 1.66},
    {"symbol": "AMD", "price": 178.11, "change_pct": 1.02},
    {"symbol": "JPM", "price": 201.87, "change_pct": 0.54},
    {"symbol": "XOM", "price": 118.22, "change_pct": -0.33},
]

FALLBACK_NEWS: List[Dict[str, str]] = [
    {
        "title": "{symbol} draws active trader interest amid heavy volume",
        "url": "https://finance.yahoo.com/quote/{symbol}",
        "source": "Terminal Briefing",
    },
    {
        "title": "Analysts break down the latest setup in {symbol}",
        "url": "https://finance.yahoo.com/quote/{symbol}/analysis",
        "source": "Analyst Desk",
    },
    {
        "title": "Institutional flows show fresh momentum building in {symbol}",
        "url": "https://finance.yahoo.com/quote/{symbol}/holder",
        "source": "Market Terminal",
