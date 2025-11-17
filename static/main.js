// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let currentSymbol = "AAPL";
let currentTheme = "dark";
let tvWidget = null;

// Simple macro data (illustrative only)
const MACRO_DATA = {
  inflation: {
    US: 3.4,
    Eurozone: 2.8,
    UK: 3.1,
    Japan: 2.2,
    China: 0.8,
    Canada: 2.6,
    Australia: 3.0,
    Brazil: 4.5,
    India: 4.2,
  },
  rates: {
    US: 5.5,
    Eurozone: 4.5,
    UK: 5.25,
    Japan: 0.1,
    China: 3.45,
    Canada: 5.0,
    Australia: 4.35,
    Brazil: 10.75,
    India: 6.5,
  },
  gdp: {
    US: 2.1,
    Eurozone: 0.9,
    UK: 0.8,
    Japan: 1.0,
    China: 4.8,
    Canada: 1.6,
    Australia: 1.9,
    Brazil: 2.3,
    India: 6.2,
  },
  unemployment: {
    US: 3.9,
    Eurozone: 6.5,
    UK: 4.3,
    Japan: 2.6,
    China: 5.0,
    Canada: 5.5,
    Australia: 3.9,
    Brazil: 7.8,
    India: 7.1,
  },
};

// ---------------------------------------------------------------------
// TradingView chart
// ---------------------------------------------------------------------

function createChart() {
  if (!window.TradingView) return;

  const container = document.getElementById("chart-container");
  if (!container) return;

  container.innerHTML = ""; // clear old widget if any

  // Map some index shortcuts back to TradingView symbols
  const tvSymbol = currentSymbol;

  tvWidget = new TradingView.widget({
    container_id: "chart-container",
    symbol: tvSymbol,
    autosize: true,
    interval: "60",
    timezone: "Etc/UTC",
    theme: currentTheme === "dark" ? "dark" : "light",
    style: "1",
    locale: "en",
    toolbar_bg: "rgba(0,0,0,0)",
    hide_top_toolbar: false,
    hide_legend: false,
    withdateranges: true,
  });

  const chartTitle = document.getElementById("chart-title");
  if (chartTitle) chartTitle.textContent = `Chart – ${currentSymbol}`;
}

// ---------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------

async function safeJsonFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error("Request failed", url, err);
    return null;
  }
}

// ---------------------------------------------------------------------
// Tickers bar
// ---------------------------------------------------------------------

async function loadTickers() {
  const data = await safeJsonFetch("/api/tickers");
  const strip = document.getElementById("ticker-strip");
  if (!strip) return;

  if (!data || !Array.isArray(data.tickers) || data.tickers.length === 0) {
    strip.innerHTML = '<span class="placeholder">Ticker data unavailable</span>';
    return;
  }

  strip.innerHTML = "";

  data.tickers.forEach((t) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = t.symbol;

    const symbol = document.createElement("span");
    symbol.className = "ticker-symbol";
    symbol.textContent = t.symbol;

    const price = document.createElement("span");
    price.className = "ticker-price";
    price.textContent =
      typeof t.price === "number" ? t.price.toFixed(2) : "–";

    const change = document.createElement("span");
    const pct = t.changePercent;
    let cls = "";
    if (typeof pct === "number") {
      if (pct > 0) cls = "ticker-change-pos";
      else if (pct < 0) cls = "ticker-change-neg";
      change.textContent = `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
    } else {
      change.textContent = "–";
    }
    change.className = cls || "";

    item.appendChild(symbol);
    item.appendChild(price);
    item.appendChild(change);

    item.addEventListener("click", () => {
      selectSymbol(t.symbol);
    });

    strip.appendChild(item);
  });
}

// ---------------------------------------------------------------------
// News
// ---------------------------------------------------------------------

async function loadNews() {
  const list = document.getElementById("news-list");
  const title = document.getElementById("news-title");
  if (!list) return;

  if (title) title.textContent = `News – ${currentSymbol}`;

  const data = await safeJsonFetch(`/api/news?symbol=${currentSymbol}`);
  if (!data || !Array.isArray(data.items)) {
    list.innerHTML = '<div class="placeholder">No headlines.</div>';
    return;
  }

  if (data.items.length === 0) {
    list.innerHTML = '<div class="placeholder">No headlines.</div>';
    return;
  }

  list.innerHTML = "";
  data.items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "news-item";
    row.addEventListener("click", () => {
      window.open(item.link, "_blank", "noopener");
    });

    const t = document.createElement("div");
    t.className = "news-title";
    t.textContent = item.title;

    const meta = document.createElement("div");
    meta.className = "news-meta";
    meta.textContent = `${item.source || ""}${
      item.published ? " • " + item.published : ""
    }`;

    row.appendChild(t);
    row.appendChild(meta);
    list.appendChild(row);
  });
}

// ---------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------

async function loadInsights() {
  const data = await safeJsonFetch(`/api/insights?symbol=${currentSymbol}`);
  const title = document.getElementById("insights-title");
  if (title) title.textContent = `Market Insights: ${currentSymbol}`;

  const fields = {
    "1W": document.getElementById("insight-1w"),
    "1M": document.getElementById("insight-1m"),
    "3M": document.getElementById("insight-3m"),
    "6M": document.getElementById("insight-6m"),
    YTD: document.getElementById("insight-ytd"),
    "1Y": document.getElementById("insight-1y"),
  };

  const desc = document.getElementById("insights-description");

  if (!data || !data.changes) {
    Object.values(fields).forEach((el) => el && (el.textContent = "–"));
    if (desc) desc.textContent = "No performance snapshot available.";
    return;
  }

  Object.entries(fields).forEach(([key, el]) => {
    if (!el) return;
    const v = data.changes[key];
    if (typeof v === "number") {
      el.textContent = `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
      el.style.color = v > 0 ? "var(--accent-green)" : v < 0 ? "var(--accent-red)" : "";
    } else {
      el.textContent = "–";
      el.style.color = "";
    }
  });

  if (desc && data.description) {
    desc.textContent = data.description;
  }
}

// ---------------------------------------------------------------------
// Movers
// ---------------------------------------------------------------------

async function loadMovers() {
  const data = await safeJsonFetch("/api/movers");
  const gainersList = document.getElementById("gainers-list");
  const losersList = document.getElementById("losers-list");
  if (!gainersList || !losersList) return;

  gainersList.innerHTML = "";
  losersList.innerHTML = "";

  if (!data) {
    gainersList.innerHTML =
      '<li class="placeholder">No data</li>';
    losersList.innerHTML =
      '<li class="placeholder">No data</li>';
    return;
  }

  const renderSide = (items, container, positive) => {
    if (!items || items.length === 0) {
      container.innerHTML =
        '<li class="placeholder">No data</li>';
      return;
    }
    items.forEach((m) => {
      const li = document.createElement("li");
      li.className = "mover-row";
      const left = document.createElement("span");
      left.textContent = m.symbol;
      const right = document.createElement("span");
      const pct = m.changePercent;
      if (typeof pct === "number") {
        right.textContent = `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
        right.style.color =
          pct > 0 ? "var(--accent-green)" : pct < 0 ? "var(--accent-red)" : "";
      } else {
        right.textContent = "–";
      }
      li.appendChild(left);
      li.appendChild(right);
      container.appendChild(li);
    });
  };

  renderSide(data.gainers, gainersList, true);
  renderSide(data.losers, losersList, false);
}

// ---------------------------------------------------------------------
// Macro maps – pure front-end visualisation
// ---------------------------------------------------------------------

function renderMacroMap(metric) {
  const container = document.getElementById("macro-map");
  if (!container) return;
  const data = MACRO_DATA[metric];
  if (!data) return;

  // compute simple quartiles for coloring
  const values = Object.values(data);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const step = (max - min) / 4 || 1;

  function level(v) {
    const d = v - min;
    if (d <= step) return 1;
    if (d <= 2 * step) return 2;
    if (d <= 3 * step) return 3;
    return 4;
  }

  container.innerHTML = "";

  Object.entries(data).forEach(([country, value]) => {
    const div = document.createElement("div");
    div.className = `macro-country macro-level-${level(value)}`;

    const name = document.createElement("div");
    name.className = "macro-country-name";
    name.textContent = country;

    const val = document.createElement("div");
    val.className = "macro-country-value";

    let unit = "";
    if (metric === "inflation") unit = "% YoY";
    else if (metric === "rates") unit = "% policy rate";
    else if (metric === "gdp") unit = "% YoY";
    else if (metric === "unemployment") unit = "%";

    val.textContent = `${value.toFixed(1)} ${unit}`;

    div.appendChild(name);
    div.appendChild(val);
    container.appendChild(div);
  });
}

function setupMacroTabs() {
  const tabs = document.querySelectorAll(".macro-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const metric = tab.dataset.metric || "inflation";
      renderMacroMap(metric);
    });
  });
}

// ---------------------------------------------------------------------
// Symbol selection & theme
// ---------------------------------------------------------------------

function selectSymbol(symbol) {
  currentSymbol = symbol;
  createChart();
  loadNews();
  loadInsights();
}

function setupMenuShortcuts() {
  const shortcuts = document.querySelectorAll(".menu-item.shortcut");
  shortcuts.forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.dataset.symbol;
      if (sym) {
        // For index shortcuts we keep the TV symbol,
        // but use generic AAPL-like symbol for news/insights if needed.
        currentSymbol = sym;
        createChart();
        loadNews();
        loadInsights();
      }
      document
        .getElementById("menu-dropdown")
        ?.classList.add("hidden");
    });
  });

  // Tile visibility
  const tileCheckboxes = document.querySelectorAll(
    ".menu-checkbox input[type='checkbox']"
  );
  tileCheckboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.dataset.tileId;
      if (!id) return;
      const tile = document.getElementById(id);
      if (!tile) return;
      tile.style.display = cb.checked ? "" : "none";
    });
  });
}

function setupMenuToggle() {
  const btn = document.getElementById("menu-button");
  const dd = document.getElementById("menu-dropdown");
  if (!btn || !dd) return;

  btn.addEventListener("click", () => {
    dd.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!dd.classList.contains("hidden")) {
      if (!dd.contains(e.target) && !btn.contains(e.target)) {
        dd.classList.add("hidden");
      }
    }
  });
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const body = document.body;
    if (body.classList.contains("theme-dark")) {
      body.classList.remove("theme-dark");
      body.classList.add("theme-light");
      currentTheme = "light";
    } else {
      body.classList.remove("theme-light");
      body.classList.add("theme-dark");
      currentTheme = "dark";
    }
    createChart();
  });
}

// ---------------------------------------------------------------------
// Column resizers (horizontal)
// ---------------------------------------------------------------------

function setupColResizers() {
  const resizers = document.querySelectorAll(".col-resizer");
  resizers.forEach((resizer) => {
    const rowEl = resizer.parentElement;
    if (!rowEl) return;

    let dragging = false;

    resizer.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const rect = rowEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const total = rect.width;
      const leftFrac = Math.min(Math.max(x / total, 0.2), 0.8);
      rowEl.style.gridTemplateColumns = `minmax(0, ${leftFrac}fr) 6px minmax(0, ${
        1 - leftFrac
      }fr)`;
    });

    window.addEventListener("mouseup", () => {
      dragging = false;
      document.body.style.userSelect = "";
    });
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  // Default theme
  document.body.classList.add("theme-dark");

  setupThemeToggle();
  setupMenuToggle();
  setupMenuShortcuts();
  setupMacroTabs();
  setupColResizers();

  createChart();
  loadTickers();
  loadNews();
  loadInsights();
  loadMovers();
  renderMacroMap("inflation");

  // Poll tickers + movers occasionally
  setInterval(loadTickers, 60000); // 1 min
  setInterval(loadMovers, 120000); // 2 min
});
