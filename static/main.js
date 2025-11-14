// Endpoints
const TICKER_ENDPOINT = "/api/tickers";
const MOVERS_ENDPOINT = "/api/movers";
const QUOTE_ENDPOINT = "/api/quote";
const INSIGHTS_ENDPOINT = "/api/insights";
const NEWS_ENDPOINT = "/api/news";
const MARKET_NEWS_ENDPOINT = "/api/market-news";

// DOM
const tickerScroll = document.getElementById("tickerScroll");
const chartTitle = document.getElementById("chartTitle");
const insightsTitle = document.getElementById("insightsTitle");
const insightsDescription = document.getElementById("insightsDescription");
const newsList = document.getElementById("newsList");
const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");

let currentSymbol = "AAPL";
let tickerData = [];
let tickerAnimationRunning = false;
let heatmapLoaded = false;
let heatmapRefreshTimer = null;

const perfIds = ["1W", "1M", "3M", "6M", "YTD", "1Y"];

// ---------------------- helpers ----------------------
function fmtPct(v) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function classForChange(v) {
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------------------- TradingView ----------------------
function tvSymbol(symbol) {
  // assume most are NASDAQ; works for ^GSPC, ^NDX automatically
  if (symbol === "SP500") return "CURRENCYCOM:US500";
  if (symbol === "NASDAQ") return "CURRENCYCOM:US100";
  return `NASDAQ:${symbol}`;
}

function mountTradingView(symbol) {
  const container = document.getElementById("tv_container");
  container.innerHTML = "";
  chartTitle.textContent = `Chart – ${symbol}`;
  if (typeof TradingView === "undefined" || !TradingView.widget) {
    container.textContent = "TradingView failed to load.";
    return;
  }
  new TradingView.widget({
    container_id: "tv_container",
    symbol: tvSymbol(symbol),
    interval: "60",
    timezone: "Etc/UTC",
    theme: document.body.classList.contains("theme-dark") ? "dark" : "light",
    style: "1",
    toolbar_bg: "rgba(0,0,0,0)",
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    allow_symbol_change: false,
    autosize: true,
  });
}

// ---------------------- ticker tape ----------------------
function buildTickerTape(data) {
  tickerScroll.innerHTML = "";
  const row = document.createElement("div");
  row.className = "ticker-row";

  data.forEach((tk) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.sym = tk.symbol;

    const s = document.createElement("span");
    s.className = "sym";
    s.textContent = tk.symbol;

    const p = document.createElement("span");
    p.className = "price";
    p.textContent =
      tk.price !== null && tk.price !== undefined ? tk.price.toFixed(2) : "—";

    const c = document.createElement("span");
    c.className = `chg ${classForChange(tk.change_pct)}`;
    c.textContent = fmtPct(tk.change_pct);

    item.appendChild(s);
    item.appendChild(p);
    item.appendChild(c);

    item.addEventListener("click", () => {
      onSymbolSelect(tk.symbol);
    });

    row.appendChild(item);
  });

  // Duplicate row for smooth scrolling
  const row2 = row.cloneNode(true);
  tickerScroll.appendChild(row);
  tickerScroll.appendChild(row2);

  // trigger animation
  tickerScroll.classList.remove("animate");
  void tickerScroll.offsetWidth;
  tickerScroll.classList.add("animate");
}

async function loadTickers() {
  try {
    const data = await getJSON(TICKER_ENDPOINT);
    if (!Array.isArray(data) || !data.length) return;
    tickerData = data;
    buildTickerTape(data);
  } catch (e) {
    // quietly ignore; keep last values
  }
}

// ---------------------- movers ----------------------
function renderMovers(movers) {
  gainersBody.innerHTML = "";
  losersBody.innerHTML = "";

  (movers.gainers || []).forEach((g) => {
    const tr = document.createElement("tr");
    tr.className = "click-row";
    tr.innerHTML = `
      <td>${g.symbol}</td>
      <td class="num">${g.price ? g.price.toFixed(2) : "—"}</td>
      <td class="num ${classForChange(g.change_pct)}">${fmtPct(
      g.change_pct
    )}</td>
    `;
    tr.addEventListener("click", () => onSymbolSelect(g.symbol));
    gainersBody.appendChild(tr);
  });

  (movers.losers || []).forEach((l) => {
    const tr = document.createElement("tr");
    tr.className = "click-row";
    tr.innerHTML = `
      <td>${l.symbol}</td>
      <td class="num">${l.price ? l.price.toFixed(2) : "—"}</td>
      <td class="num ${classForChange(l.change_pct)}">${fmtPct(
      l.change_pct
    )}</td>
    `;
    tr.addEventListener("click", () => onSymbolSelect(l.symbol));
    losersBody.appendChild(tr);
  });
}

async function loadMovers() {
  try {
    const data = await getJSON(`${MOVERS_ENDPOINT}?limit=5`);
    renderMovers(data);
  } catch (e) {
    // ignore
  }
}

// ---------------------- insights ----------------------
function renderInsights(data) {
  insightsTitle.textContent = `Market Insights: ${data.symbol}`;
  perfIds.forEach((id) => {
    const el = document.getElementById(`perf-${id}`);
    if (!el) return;
    const v = data.periods[id];
    el.textContent = fmtPct(v);
    el.className = `value ${classForChange(v)}`;
  });
  insightsDescription.textContent = data.description || "No profile available.";
}

async function loadInsights(symbol) {
  try {
    const data = await getJSON(
      `${INSIGHTS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    renderInsights(data);
  } catch (e) {
    insightsDescription.textContent = "Could not load insights.";
  }
}

// ---------------------- news ----------------------
function renderNews(articles) {
  newsList.innerHTML = "";
  if (!articles || !articles.length) {
    newsList.textContent = "No headlines.";
    return;
  }
  articles.forEach((n) => {
    const item = document.createElement("div");
    item.className = "news-item";
    const a = document.createElement("a");
    a.href = n.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = n.title || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "news-meta";
    meta.textContent = `${n.source || "Source"}${
      n.published_at ? " · " + n.published_at : ""
    }`;

    item.appendChild(a);
    item.appendChild(meta);
    newsList.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.textContent = "Loading news...";
  try {
    const data = await getJSON(
      `${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    renderNews(data);
  } catch (e) {
    newsList.textContent = "Failed to load news.";
  }
}

// ---------------------- selection ----------------------
async function onSymbolSelect(symbol) {
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([loadInsights(symbol), loadNews(symbol)]);
}

// ---------------------- theme + menu ----------------------
function initTheme() {
  const toggle = document.getElementById("themeToggle");
  if (!toggle) return;

  const stored = localStorage.getItem("mt-theme");
  if (stored === "light") {
    document.body.classList.remove("theme-dark");
    document.body.classList.add("theme-light");
    toggle.checked = false;
  } else {
    document.body.classList.add("theme-dark");
    toggle.checked = true;
  }

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
      localStorage.setItem("mt-theme", "dark");
    } else {
      document.body.classList.remove("theme-dark");
      document.body.classList.add("theme-light");
      localStorage.setItem("mt-theme", "light");
    }
    // remount chart with new theme
    mountTradingView(currentSymbol);
  });
}

function initMenu() {
  const btn = document.getElementById("settingsButton");
  const menu = document.getElementById("settingsMenu");
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  });

  document.addEventListener("click", () => {
    menu.classList.add("hidden");
  });

  menu.addEventListener("click", (e) => e.stopPropagation());

  // tile toggles
  const checks = menu.querySelectorAll("input[type=checkbox][data-tile]");
  checks.forEach((ch) => {
    ch.addEventListener("change", () => {
      const tileId = ch.getAttribute("data-tile");
      const tile = document.getElementById(tileId);
      if (!tile) return;
      tile.style.display = ch.checked ? "" : "none";
    });
  });

  // tile close buttons
  const closeBtns = document.querySelectorAll("[data-tile-close]");
  closeBtns.forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.getAttribute("data-tile-close");
      const tile = document.getElementById(id);
      if (!tile) return;
      tile.style.display = "none";
      // uncheck in menu
      const chk = menu.querySelector(`input[data-tile="${id}"]`);
      if (chk) chk.checked = false;
    });
  });
}

// ---------------------- heatmap ----------------------
function showHeatmap() {
  const overlay = document.getElementById("heatmapOverlay");
  overlay.classList.add("visible");

  const container = document.getElementById("heatmapWidget");
  if (!heatmapLoaded) {
    container.innerHTML = "";
    const script = document.createElement("script");
    script.src =
      "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = `
    {
      "dataSource": "SPX500",
      "grouping": "sector",
      "blockSize": "market_cap_basic",
      "blockColor": "change",
      "locale": "en",
      "colorTheme": "${
        document.body.classList.contains("theme-dark") ? "dark" : "light"
      }",
      "symbolUrl": "",
      "hasTopBar": true,
      "isZoomEnabled": true,
      "width": "100%",
      "height": "100%"
    }`;
    container.appendChild(script);
    heatmapLoaded = true;
  }

  if (heatmapRefreshTimer) clearInterval(heatmapRefreshTimer);
  heatmapRefreshTimer = setInterval(() => {
    heatmapLoaded = false;
    showHeatmap();
  }, 60 * 60 * 1000);
}

function hideHeatmap() {
  const overlay = document.getElementById("heatmapOverlay");
  overlay.classList.remove("visible");
}

// ---------------------- shortcuts ----------------------
function initShortcuts() {
  const spBtn = document.getElementById("sp500Button");
  const ndBtn = document.getElementById("nasdaqButton");
  if (spBtn)
    spBtn.addEventListener("click", () => {
      onSymbolSelect("SP500");
    });
  if (ndBtn)
    ndBtn.addEventListener("click", () => {
      onSymbolSelect("NASDAQ");
    });

  const hBtn = document.getElementById("heatmapButton");
  const hClose = document.getElementById("heatmapClose");
  if (hBtn) hBtn.addEventListener("click", showHeatmap);
  if (hClose) hClose.addEventListener("click", hideHeatmap);
}

// ---------------------- boot ----------------------
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initMenu();
  initShortcuts();

  loadTickers();
  setInterval(loadTickers, 15000);
  loadMovers();
  setInterval(loadMovers, 30000);

  onSymbolSelect(currentSymbol);

  // pause ticker animation on hover is handled by CSS
});
