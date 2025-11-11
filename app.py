from __future__ import annotations
import os, time, datetime, re
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Request, Query
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware

import httpx, yfinance as yf

# ── Resolve absolute paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

# Ensure folders exist so starlette doesn't crash even if repo missed them
os.makedirs(STATIC_DIR, exist_ok=True)
os.makedirs(TEMPLATES_DIR, exist_ok=True)

# Load .env (local dev only; on Render use Environment tab)
load_dotenv(dotenv_path=os.path.join(BASE_DIR, ".env"))

app = FastAPI(title="Market Terminal")

# Mount static / set templates using absolute paths
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)

NEWS_API_KEY = os.getenv("NEWS_API_KEY", "")
TE_KEY = os.getenv("TE_KEY")

# … (keep the rest of your code exactly as before) …

@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    index_path = os.path.join(TEMPLATES_DIR, "index.html")
    if not os.path.isfile(index_path):
        # helpful message if template wasn’t deployed yet
        return PlainTextResponse(
            "templates/index.html not found. Make sure your repo has templates/index.html and static/*. ",
            status_code=500
        )
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/health")
def health():
    return {"ok": True}

# … keep all other routes unchanged …
