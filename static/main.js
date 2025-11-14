// Endpoints
const TICKER_ENDPOINT = "/api/tickers";
const MOVERS_ENDPOINT = "/api/movers";
const METRICS_ENDPOINT = "/api/metrics";
const NEWS_ENDPOINT = "/api/news";
const MKT_NEWS_ENDPOINT = "/api/market-news";

// DOM
const tickerScroll = document.getElementById("tickerScroll");
const tvContainer = document.getElementById("tvContainer");
const chartTitle = document.getElementById("chartTitle");
const insightsTitle = document.getElementById("insightsTitle");
const perfEls = {
  "1W": document.getElementById("perf1W"),
  "1M": document.getElementById("perf1M"),
  "3M": document.getElementById("perf3M"),
  "6M": document.getElementById("perf6M"),
  YTD: document.getElementById("perfYTD"),
  "1Y": document.getElementById("perf1Y")
};
const companyDescription = document.getElementById("companyDescription");
const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");
const newsList = document.getElementById("newsList");
const marketNewsList = document.getElementById("marketNewsList");

const settingsBtn = document.getElementById("settingsBtn");
const settingsMenu = document.getElementById("settingsMenu");
const themeToggle = document.getElementById("themeToggle");
const spxShortcut = document.getElementById("spxShortcut");
const nasdaqShortcut = document.getElementById("nasdaqShortcut");

let currentSymbol = "AAPL";
let tickersData = [];
let tvWidget = null;

// TradingView symbol mapping (capital.com for indices)
function tvSymbol(sym) {
  if (sym === "SPY") return "CAPITALCOM:US500";
  if (sym === "QQQ") return "CAPITALCOM:US100";
  return sym;
}

// Helpers ----------------------------------------------------------

function fmtPct(v) {
  if (v == null || !isFinite(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${s}${Math.abs(v).toFixed(2)}%`;
}

function applyPerfClass(el, v) {
  el.classList.remove("pos", "neg", "muted");
  if (v == null || !isFinite(v)) {
    el.classList.add("muted");
    return;
  }
  if (v > 0.05) el.classList.add("pos");
  else if (v < -0.05) el.classList.add("neg");
  else el.classList.add("muted");
}

// TradingView ------------------------------------------------------

function mountTradingView(symbol) {
  chartTitle.textContent = `Chart – ${symbol}`;
  tvContainer.innerHTML = "";

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.style.padding = "10px";
    msg.textContent =
      "TradingView widget could not be loaded (script blocked or offline).";
    tvContainer.appendChild(msg);
    return;
  }

  tvWidget = new TradingView.widget({
    symbol: tvSymbol(symbol),
    interval: "60",
    timezone: "Etc/UTC",
    theme: document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
    style: "1",
    locale: "en",
    toolbar_bg: "#000000",
    container_id: "tvContainer",
    autosize: true,
    hide_top_toolbar: false,
    hide_legend: false
  });
}

// Ticker bar -------------------------------------------------------

function buildTickerBar(items) {
  tickersData = items;
  tickerScroll.innerHTML = "";

  const twice = [...items, ...items]; // duplicate for smooth scroll
  twice.forEach((row) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = row.symbol;

    const sym = document.createElement("span");
    sym.className = "ticker-symbol";
    sym.textContent = row.symbol;

    const price = document.createElement("span");
    price.className = "ticker-price";
    price.textContent =
      row.price == null || !isFinite(row.price)
        ? "—"
        : row.price.toFixed(2);

    const chg = document.createElement("span");
    chg.className = "ticker-change";
    const pct = row.change_pct || 0;
    if (pct > 0.05) chg.classList.add("chg-pos");
    else if (pct < -0.05) chg.classList.add("chg-neg");
    chg.textContent = fmtPct(pct);

    item.append(sym, price, chg);
    item.addEventListener("click", () => onSymbolSelect(row.symbol));
    tickerScroll.appendChild(item);
  });
}

async function loadTickers(init = false) {
  try {
    const r = await fetch(TICKER_ENDPOINT);
    const data = await r.json();
    if (!Array.isArray(data)) return;
    if (init || tickersData.length === 0) {
      buildTickerBar(data);
      if (init && data.length) {
        currentSymbol = "AAPL";
        onSymbolSelect(currentSymbol);
      }
    } else {
      tickersData = data;
      // simple refresh: rebuild items with updated pct/price
      buildTickerBar(data);
    }
  } catch (e) {
    // ignore
  }
}

// Movers -----------------------------------------------------------

function renderMovers(data) {
  gainersBody.innerHTML = "";
  losersBody.innerHTML = "";

  const renderSide = (tbody, rows) => {
    if (!rows || !rows.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 3;
      td.className = "muted";
      td.textContent = "No data.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${r.symbol}</td>
        <td style="text-align:right">${r.price != null ? r.price.toFixed(2) : "—"}</td>
        <td style="text-align:right" class="${
          r.change_pct > 0.05 ? "chg-pos" : r.change_pct < -0.05 ? "chg-neg" : ""
        }">${fmtPct(r.change_pct)}</td>
      `;
      tr.addEventListener("click", () => onSymbolSelect(r.symbol));
      tbody.appendChild(tr);
    });
  };

  renderSide(gainersBody, data.gainers);
  renderSide(losersBody, data.losers);
}

async function loadMovers() {
  try {
    const r = await fetch(MOVERS_ENDPOINT);
    const data = await r.json();
    renderMovers(data);
  } catch (e) {
    gainersBody.innerHTML =
      '<tr><td class="muted">Failed to load.</td></tr>';
    losersBody.innerHTML =
      '<tr><td class="muted">Failed to load.</td></tr>';
  }
}

// Metrics / Insights -----------------------------------------------

function renderMetrics(symbol, data) {
  insightsTitle.textContent = `Market Insights: ${symbol}`;
  const perf = data.performance || {};

  const map = {
    "1W": "1W",
    "1M": "1M",
    "3M": "3M",
    "6M": "6M",
    YTD: "YTD",
    "1Y": "1Y"
  };

  Object.entries(map).forEach(([key, label]) => {
    const el = perfEls[label];
    if (!el) return;
    const v = perf[key];
    el.textContent = fmtPct(v);
    applyPerfClass(el, v);
  });

  const desc = ((data.profile || {}).description || "").trim();
  companyDescription.textContent =
    desc || "No profile available at this time.";
}

async function loadMetrics(symbol) {
  try {
    const r = await fetch(`${METRICS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const data = await r.json();
    renderMetrics(symbol, data);
  } catch (e) {
    companyDescription.textContent = "Failed to load company profile.";
  }
}

// News -------------------------------------------------------------

function renderNewsList(container, articles) {
  container.innerHTML = "";
  if (!articles || !articles.length) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = "No headlines.";
    container.appendChild(div);
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

    item.append(a, meta);
    container.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const r = await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const data = await r.json();
    renderNewsList(newsList, data);
  } catch (e) {
    newsList.innerHTML = '<div class="muted">Failed to load news.</div>';
  }
}

async function loadMarketNews() {
  marketNewsList.innerHTML = '<div class="muted">Loading…</div>';
  try {
    const r = await fetch(MKT_NEWS_ENDPOINT);
    const data = await r.json();
    renderNewsList(marketNewsList, data);
  } catch (e) {
    marketNewsList.innerHTML =
      '<div class="muted">Failed to load market news.</div>';
  }
}

// Symbol selection -------------------------------------------------

async function onSymbolSelect(symbol) {
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([loadMetrics(symbol), loadNews(symbol)]);
}

// Theme / settings -------------------------------------------------

function initTheme() {
  const stored = localStorage.getItem("mt_theme");
  if (stored === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    themeToggle.checked = true;
  } else {
    document.documentElement.setAttribute("data-theme", "dark");
    themeToggle.checked = false;
  }
}

function bindSettings() {
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsMenu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      settingsMenu.classList.remove("open");
    }
  });

  themeToggle.addEventListener("change", () => {
    const mode = themeToggle.checked ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", mode);
    localStorage.setItem("mt_theme", mode);
    // re-mount TV chart so it picks up theme
    mountTradingView(currentSymbol);
  });

  // tile toggles
  document
    .querySelectorAll("[data-tile-toggle]")
    .forEach((checkbox) => {
      checkbox.addEventListener("change", (e) => {
        const tile = e.target.getAttribute("data-tile-toggle");
        const el = document.querySelector(`[data-tile="${tile}"]`);
        if (!el) return;
        el.classList.toggle("hidden", !e.target.checked);
      });
    });

  // tile close buttons sync with toggles
  document.querySelectorAll("[data-tile-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tile = btn.getAttribute("data-tile-close");
      const el = document.querySelector(`[data-tile="${tile}"]`);
      if (!el) return;
      el.classList.add("hidden");
      const toggle = document.querySelector(
        `[data-tile-toggle="${tile}"]`
      );
      if (toggle) toggle.checked = false;
    });
  });
}

// Shortcuts --------------------------------------------------------

function bindShortcuts() {
  spxShortcut.addEventListener("click", () => {
    onSymbolSelect("SPY");
  });
  nasdaqShortcut.addEventListener("click", () => {
    onSymbolSelect("QQQ");
  });
}

// Boot -------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  bindSettings();
  bindShortcuts();

  loadTickers(true);
  loadMovers();
  loadMarketNews();

  setInterval(() => loadTickers(false), 60000); // 60s
  setInterval(loadMovers, 120000); // 2 min
  setInterval(loadMarketNews, 300000); // 5 min
});
