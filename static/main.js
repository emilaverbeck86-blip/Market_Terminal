// Endpoints -----------------------------------------------------------

const TICKERS_ENDPOINT = "/api/tickers";
const INSIGHTS_ENDPOINT = "/api/insights";
const MOVERS_ENDPOINT = "/api/movers";
const NEWS_ENDPOINT = "/api/news";

// DOM -----------------------------------------------------------------

const tickerScroll = document.getElementById("tickerScroll");
const tvContainer = document.getElementById("tvContainer");
const chartTitle = document.getElementById("chartTitle");
const insightsTitle = document.getElementById("insightsTitle");
const companyDescription = document.getElementById("companyDescription");

const perfEls = {
  "1W": document.getElementById("perf1W"),
  "1M": document.getElementById("perf1M"),
  "3M": document.getElementById("perf3M"),
  "6M": document.getElementById("perf6M"),
  YTD: document.getElementById("perfYTD"),
  "1Y": document.getElementById("perf1Y"),
};

const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");
const newsList = document.getElementById("newsList");

const themeToggle = document.getElementById("themeToggle");
const settingsBtn = document.getElementById("settingsBtn");
const settingsMenu = document.getElementById("settingsMenu");

// State ---------------------------------------------------------------

let currentSymbol = "AAPL";
let tickerNodes = new Map();

// Helpers -------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function fmtPct(v) {
  if (v == null || isNaN(v)) return "0.00%";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function fmtPctNoSign(v) {
  if (v == null || isNaN(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

// Theme ---------------------------------------------------------------

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("mt_theme", theme);
  themeToggle.checked = theme === "light";
}

function initTheme() {
  const stored = localStorage.getItem("mt_theme");
  const theme = stored === "light" ? "light" : "dark";
  applyTheme(theme);
  themeToggle.addEventListener("change", () => {
    applyTheme(themeToggle.checked ? "light" : "dark");
  });
}

// Settings menu -------------------------------------------------------

function initSettingsMenu() {
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    settingsMenu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      settingsMenu.classList.remove("open");
    }
  });

  // Tile toggles
  const toggles = settingsMenu.querySelectorAll("[data-tile-toggle]");
  toggles.forEach((toggle) => {
    const name = toggle.dataset.tileToggle;
    const tile = document.querySelector(`.tile[data-tile="${name}"]`);
    if (!tile) return;

    toggle.addEventListener("change", () => {
      tile.classList.toggle("hidden", !toggle.checked);
    });
  });

  // Tile close buttons
  const closes = document.querySelectorAll("[data-tile-close]");
  closes.forEach((btn) => {
    const name = btn.dataset.tileClose;
    const tile = document.querySelector(`.tile[data-tile="${name}"]`);
    const toggle = settingsMenu.querySelector(
      `[data-tile-toggle="${name}"]`
    );
    if (!tile) return;
    btn.addEventListener("click", () => {
      tile.classList.add("hidden");
      if (toggle) toggle.checked = false;
    });
  });
}

// TradingView ---------------------------------------------------------

function tradingViewSymbol(sym) {
  if (sym === "SPX_INDEX") return "CAPITALCOM:US500";
  if (sym === "NDX_INDEX") return "CAPITALCOM:US100";
  return sym;
}

function mountTradingView(symbol) {
  chartTitle.textContent = `Chart – ${symbol}`;
  tvContainer.innerHTML = "";

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const div = document.createElement("div");
    div.className = "muted";
    div.style.padding = "8px";
    div.textContent =
      "TradingView widget could not load (check adblock or network).";
    tvContainer.appendChild(div);
    return;
  }

  new TradingView.widget({
    symbol: tradingViewSymbol(symbol),
    interval: "60",
    timezone: "Etc/UTC",
    theme:
      document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark",
    style: "1",
    toolbar_bg: "#000000",
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: false,
    container_id: "tvContainer",
    autosize: true,
  });
}

// Ticker bar ----------------------------------------------------------

function buildTickerBar(data) {
  clearChildren(tickerScroll);
  tickerNodes.clear();

  const extended = data.concat(data);

  extended.forEach((row) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = row.symbol;

    const symSpan = document.createElement("span");
    symSpan.className = "ticker-symbol";
    symSpan.textContent = row.symbol;

    const priceSpan = document.createElement("span");
    priceSpan.className = "ticker-price";
    priceSpan.textContent =
      row.price != null ? row.price.toFixed(2) : "—";

    const chgSpan = document.createElement("span");
    chgSpan.className = "ticker-change";
    const chg = row.change_pct ?? 0;
    if (chg > 0) chgSpan.classList.add("chg-pos");
    else if (chg < 0) chgSpan.classList.add("chg-neg");
    chgSpan.textContent = fmtPct(chg);

    item.appendChild(symSpan);
    item.appendChild(priceSpan);
    item.appendChild(chgSpan);

    item.addEventListener("click", () =>
      onSymbolSelect(row.symbol)
    );

    tickerScroll.appendChild(item);

    if (!tickerNodes.has(row.symbol)) {
      tickerNodes.set(row.symbol, { priceSpan, chgSpan });
    }
  });
}

function updateTickerBar(data) {
  data.forEach((row) => {
    const nodes = tickerNodes.get(row.symbol);
    if (!nodes) return;
    if (row.price != null) {
      nodes.priceSpan.textContent = row.price.toFixed(2);
    }
    const chg = row.change_pct ?? 0;
    nodes.chgSpan.textContent = fmtPct(chg);
    nodes.chgSpan.classList.remove("chg-pos", "chg-neg");
    if (chg > 0) nodes.chgSpan.classList.add("chg-pos");
    else if (chg < 0) nodes.chgSpan.classList.add("chg-neg");
  });
}

async function loadTickers(initial = false) {
  try {
    const data = await fetchJSON(TICKERS_ENDPOINT);
    if (initial || tickerNodes.size === 0) {
      if (data.length && !initial) {
        currentSymbol = currentSymbol || data[0].symbol;
      }
      buildTickerBar(data);
    } else {
      updateTickerBar(data);
    }
  } catch (err) {
    console.error("tickers error", err);
  }
}

// Insights ------------------------------------------------------------

function renderInsights(perf, description) {
  const keys = ["1W", "1M", "3M", "6M", "YTD", "1Y"];

  keys.forEach((k) => {
    const el = perfEls[k];
    if (!el) return;
    const v = perf[k];
    el.classList.remove("pos", "neg");
    if (v == null || isNaN(v)) {
      el.textContent = "—";
      return;
    }
    el.textContent = fmtPctNoSign(v);
    if (v > 0) el.classList.add("pos");
    else if (v < 0) el.classList.add("neg");
  });

  companyDescription.textContent =
    description || "No company profile available at this time.";
}

async function loadInsights(symbol) {
  try {
    const data = await fetchJSON(
      `${INSIGHTS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    insightsTitle.textContent = `Market Insights: ${
      data.symbol || symbol
    }`;
    renderInsights(data.performance || {}, data.description || "");
  } catch (err) {
    console.error("insights error", err);
    renderInsights({}, "");
  }
}

// Movers --------------------------------------------------------------

function renderMovers(data) {
  const gainers = data.gainers || [];
  const losers = data.losers || [];

  clearChildren(gainersBody);
  clearChildren(losersBody);

  function addRow(tbody, row) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.symbol}</td>
      <td style="text-align:right">${row.price?.toFixed(2) ?? "—"}</td>
      <td style="text-align:right">${fmtPct(row.change_pct)}</td>
    `;
    tr.addEventListener("click", () =>
      onSymbolSelect(row.symbol)
    );
    tbody.appendChild(tr);
  }

  gainers.forEach((r) => addRow(gainersBody, r));
  losers.forEach((r) => addRow(losersBody, r));

  if (!gainers.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="3" class="muted">No data.</td>';
    gainersBody.appendChild(tr);
  }
  if (!losers.length) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td colspan="3" class="muted">No data.</td>';
    losersBody.appendChild(tr);
  }
}

async function loadMovers() {
  try {
    const data = await fetchJSON(MOVERS_ENDPOINT);
    renderMovers(data);
  } catch (err) {
    console.error("movers error", err);
    clearChildren(gainersBody);
    clearChildren(losersBody);
    const tr1 = document.createElement("tr");
    tr1.innerHTML =
      '<td colspan="3" class="muted">Failed to load.</td>';
    gainersBody.appendChild(tr1);
    const tr2 = document.createElement("tr");
    tr2.innerHTML =
      '<td colspan="3" class="muted">Failed to load.</td>';
    losersBody.appendChild(tr2);
  }
}

// News ---------------------------------------------------------------

function renderNewsList(container, articles, emptyText) {
  clearChildren(container);
  if (!articles || !articles.length) {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = emptyText;
    container.appendChild(div);
    return;
  }

  articles.forEach((a) => {
    const item = document.createElement("div");
    item.className = "news-item";

    const link = document.createElement("a");
    link.href = a.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = a.title || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "news-meta";
    const src = a.source || "Unknown";
    const ts = a.published_at || "";
    meta.textContent = ts ? `${src} · ${ts}` : src;

    item.appendChild(link);
    item.appendChild(meta);
    container.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML =
    '<div class="muted">Loading news…</div>';
  try {
    const data = await fetchJSON(
      `${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    renderNewsList(newsList, data, "No headlines.");
  } catch (err) {
    console.error("news error", err);
    renderNewsList(
      newsList,
      [],
      "Failed to load news."
    );
  }
}

// Symbol selection & shortcuts --------------------------------------

async function onSymbolSelect(symbol) {
  currentSymbol = symbol;

  chartTitle.textContent = `Chart – ${symbol}`;
  insightsTitle.textContent = `Market Insights: ${symbol}`;

  mountTradingView(symbol);

  await Promise.all([
    loadInsights(symbol),
    loadNews(symbol),
  ]);
}

function initShortcuts() {
  const buttons = document.querySelectorAll(
    ".shortcut-btn"
  );
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.shortcut;
      if (type === "spx") {
        onSymbolSelect("SPX_INDEX");
      } else if (type === "nasdaq") {
        onSymbolSelect("NDX_INDEX");
      }
    });
  });
}

// Boot ----------------------------------------------------------------

function init() {
  initTheme();
  initSettingsMenu();
  initShortcuts();

  // Always show something, even if /api/tickers has issues
  onSymbolSelect(currentSymbol).catch(console.error);

  // Fire-and-forget background loads
  loadTickers(true).catch(console.error);
  loadMovers().catch(console.error);

  setInterval(() => loadTickers(false).catch(console.error), 60_000);
  setInterval(() => loadMovers().catch(console.error), 120_000);
}

document.addEventListener("DOMContentLoaded", init);
