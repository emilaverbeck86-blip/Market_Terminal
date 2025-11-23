let currentSymbol = "AAPL";
let lastTheme = "dark";
let macroChart = null;
let worldMapReady = false;
const HEATMAP_SCRIPT_URL =
  "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";

let tvWidget = null;
let chartFallbackActive = false;
let chartRetryTimer = null;

const COUNTRY_NAMES = {
  US: "United States",
  CA: "Canada",
  BR: "Brazil",
  DE: "Germany",
  UK: "United Kingdom",
  FR: "France",
  ZA: "South Africa",
  IN: "India",
  CN: "China",
  JP: "Japan",
  AU: "Australia",
};

const MACRO_METRIC_LABELS = {
  inflation: "Inflation",
  rates: "Central Bank Rate",
  gdp: "GDP Growth",
  unemployment: "Unemployment",
};

const ROW_MIN_HEIGHT = 180;
const ROW_MAX_HEIGHT = 520;

const COL_MIN_WIDTH = 220;
const COL_MAX_WIDTH = 800;

// --------------------------------------------------------------
// Utilities
// --------------------------------------------------------------

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

function formatPct(p) {
  if (p === null || p === undefined || isNaN(p)) return "–";
  const v = Number(p);
  const abs = Math.abs(v);
  if (abs >= 100) return `${v.toFixed(0)}%`;
  return `${v.toFixed(2)}%`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// --------------------------------------------------------------
// Theme handling
// --------------------------------------------------------------

function applyTheme(theme) {
  const body = document.body;
  if (theme === "light") {
    body.classList.remove("theme-dark");
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
    body.classList.add("theme-dark");
  }
  lastTheme = theme;
}

function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", () => {
    const next = lastTheme === "dark" ? "light" : "dark";
    applyTheme(next);
    if (macroChart) {
      macroChart.resize();
    }
  });
}

// --------------------------------------------------------------
// Layout / resizers
// --------------------------------------------------------------

function setRowHeight(rowId, value) {
  const clamped = clamp(value, ROW_MIN_HEIGHT, ROW_MAX_HEIGHT);
  document.documentElement.style.setProperty(`--${rowId}-height`, clamped + "px");
}

function setColWidth(rowId, colVar, value) {
  const clamped = clamp(value, COL_MIN_WIDTH, COL_MAX_WIDTH);
  document.documentElement.style.setProperty(
    `--${rowId}-${colVar}`,
    clamped + "px"
  );
}

function setupRowResizers() {
  document.querySelectorAll("[data-row-resizer]").forEach((resizer) => {
    const rowId = resizer.getAttribute("data-row-resizer");
    const rowEl = document.querySelector(`.mt-row[data-row="${rowId.slice(-1)}"]`);
    if (!rowEl) return;

    let startY = 0;
    let startHeight = 0;

    const onDown = (event) => {
      event.preventDefault();
      startY = event.touches ? event.touches[0].clientY : event.clientY;
      const style = getComputedStyle(document.documentElement);
      const h = parseFloat(style.getPropertyValue(`--${rowId}-height`)) || 260;
      startHeight = h;
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    };

    const onMove = (event) => {
      const y = event.touches ? event.touches[0].clientY : event.clientY;
      const delta = y - startY;
      setRowHeight(rowId, startHeight + delta);
      if (macroChart) macroChart.resize();
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };

    resizer.addEventListener("mousedown", onDown);
    resizer.addEventListener("touchstart", onDown, { passive: false });
  });
}

function setupColResizers() {
  document.querySelectorAll("[data-col-resizer]").forEach((resizer) => {
    const id = resizer.getAttribute("data-col-resizer");
    const row = resizer.closest(".mt-row");
    if (!row) return;
    const leftVar = `--${id}-col1`;
    const rightVar = `--${id}-col2`;

    let startX = 0;
    let startLeftWidth = 0;

    const onDown = (event) => {
      event.preventDefault();
      startX = event.touches ? event.touches[0].clientX : event.clientX;
      const style = getComputedStyle(document.documentElement);
      startLeftWidth =
        parseFloat(style.getPropertyValue(leftVar)) ||
        row.querySelector(".mt-col")?.offsetWidth ||
        row.clientWidth / 2;
      if (startLeftWidth < COL_MIN_WIDTH / 2) {
        startLeftWidth = row.clientWidth / 2;
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    };

    const onMove = (event) => {
      const x = event.touches ? event.touches[0].clientX : event.clientX;
      const delta = x - startX;
      const newLeft = clamp(startLeftWidth + delta, COL_MIN_WIDTH, COL_MAX_WIDTH);
      const newRight = row.clientWidth - newLeft - 8;
      document.documentElement.style.setProperty(leftVar, newLeft + "px");
      document.documentElement.style.setProperty(rightVar, newRight + "px");
      if (macroChart) macroChart.resize();
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };

    resizer.addEventListener("mousedown", onDown);
    resizer.addEventListener("touchstart", onDown, { passive: false });
  });
}

// --------------------------------------------------------------
// TradingView chart
// --------------------------------------------------------------

function renderChartPlaceholder(message) {
  const container = document.getElementById("tv-chart");
  if (!container) return;
  container.innerHTML = `<div class="mt-chart-placeholder">${message}</div>`;
  chartFallbackActive = true;
}

function loadChart(symbol) {
  currentSymbol = symbol.toUpperCase();
  document.getElementById("chart-symbol").textContent = currentSymbol;

  const containerId = "tv-chart";
  const theme = lastTheme === "dark" ? "dark" : "light";

  if (chartRetryTimer) {
    clearTimeout(chartRetryTimer);
    chartRetryTimer = null;
  }

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    renderChartPlaceholder("Loading interactive chart…");
    chartRetryTimer = setTimeout(() => {
      chartRetryTimer = null;
      loadChart(currentSymbol);
    }, 1500);
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  chartFallbackActive = false;

  tvWidget = new TradingView.widget({
    autosize: true,
    symbol: currentSymbol,
    interval: "60",
    container_id: containerId,
    timezone: "Etc/UTC",
    theme: theme,
    style: "1",
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: false,
    hide_side_toolbar: false,
    hide_volume: false,
    details: false,
    hotlist: false,
    calendar: false,
  });
}

function openSymbol(symbol) {
  try {
    loadChart(symbol);
  } catch (error) {
    console.error("open symbol error", error);
  }
  refreshAllForSymbol(symbol);
}

// --------------------------------------------------------------
// Ticker bar
// --------------------------------------------------------------

async function refreshTickerBar() {
  try {
    const data = await getJSON("/api/tickers");
    const bar = document.getElementById("ticker-bar");
    bar.innerHTML = "";
    const strip1 = document.createElement("div");
    const strip2 = document.createElement("div");
    strip1.className = "mt-ticker-strip";
    strip2.className = "mt-ticker-strip";

    const items = data.tickers || [];
    for (let i = 0; i < 2; i++) {
      const strip = i === 0 ? strip1 : strip2;
      items.forEach((t) => {
        const el = document.createElement("div");
        el.className = "mt-ticker-item";
        const price = Number(t.price).toFixed(2);
        const change = Number(t.change_pct);
        const changeClass = change >= 0 ? "pos" : "neg";
        el.innerHTML =
          `<span class="mt-ticker-symbol">${t.symbol}</span>` +
          `<span>${price}</span> ` +
          `<span class="mt-ticker-change ${changeClass}">${formatPct(change)}</span>`;
        el.addEventListener("click", () => {
          openSymbol(t.symbol);
        });
        strip.appendChild(el);
      });
    }

    bar.appendChild(strip1);
    bar.appendChild(strip2);
  } catch (e) {
    console.error("ticker bar error", e);
  }
}

// --------------------------------------------------------------
// News
// --------------------------------------------------------------

async function refreshNews(symbol) {
  const newsBox = document.getElementById("news-list");
  if (!newsBox) return;
  newsBox.innerHTML = "";
  try {
    const data = await getJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const items = data.items || [];
    if (!items.length) {
      newsBox.innerHTML = `<div class="mt-news-empty">No news available.</div>`;
      return;
    }

    items.forEach((item) => {
      const el = document.createElement("a");
      el.href = item.url;
      el.target = "_blank";
      el.rel = "noopener noreferrer";
      el.className = "mt-news-item";
      const source = item.source || "News";
      const published = item.published_at || "";
      el.innerHTML =
        `<div class="mt-news-title">${item.title}</div>` +
        `<div class="mt-news-meta"><span>${source}</span><span>${published}</span></div>`;
      newsBox.appendChild(el);
    });
  } catch (e) {
    console.error("news error", e);
    newsBox.innerHTML = `<div class="mt-news-empty">Unable to load news.</div>`;
  }
}

// --------------------------------------------------------------
// Insights
// --------------------------------------------------------------

async function refreshInsights(symbol) {
  const root = document.querySelector(".mt-insights");
  if (!root) return;

  const profileEl = document.getElementById("insights-profile");
  const tiles = root.querySelectorAll(".mt-insight-value");
  tiles.forEach((tile) => {
    tile.textContent = "–";
    tile.classList.remove("pos", "neg");
  });
  profileEl.textContent = "Loading performance snapshot…";

  try {
    const data = await getJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
    const periods = data.periods || {};
    Object.entries(periods).forEach(([period, val]) => {
      const cell = root.querySelector(`.mt-insight-value[data-period="${period}"]`);
      if (!cell) return;
      if (val === null || val === undefined) {
        cell.textContent = "–";
        return;
      }
      const num = Number(val);
      cell.textContent = formatPct(num);
      cell.classList.add(num >= 0 ? "pos" : "neg");
    });

    profileEl.textContent =
      data.profile ||
      "This snapshot combines recent price performance and a short descriptive profile to give you a quick fundamental impression inside the terminal.";
  } catch (e) {
    console.error("insights error", e);
    profileEl.textContent = "No performance snapshot available at this time.";
  }
}

// --------------------------------------------------------------
// Calendar
// --------------------------------------------------------------

async function refreshCalendar() {
  try {
    const data = await getJSON("/api/calendar");
    const tbody = document.getElementById("calendar-body");
    if (!tbody) return;
    tbody.innerHTML = "";
    (data.events || []).forEach((ev) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${ev.time}</td>` +
        `<td>${ev.country}</td>` +
        `<td>${ev.event}</td>` +
        `<td>${ev.actual}</td>` +
        `<td>${ev.forecast}</td>` +
        `<td>${ev.previous}</td>`;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error("calendar error", e);
  }
}

// --------------------------------------------------------------
// Movers
// --------------------------------------------------------------

async function refreshMovers() {
  try {
    const data = await getJSON("/api/movers");
    const gainersDiv = document.getElementById("movers-gainers");
    const losersDiv = document.getElementById("movers-losers");
    if (!gainersDiv || !losersDiv) return;
    gainersDiv.innerHTML = "";
    losersDiv.innerHTML = "";

    const renderMover = (target, mover) => {
      const row = document.createElement("div");
      row.className = "mt-mover-row";
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      const changeValue = Number(mover.change_pct);
      row.innerHTML =
        `<span>${mover.symbol}</span>` +
        `<span class="mt-mover-change ${
          changeValue >= 0 ? "pos" : "neg"
        }">${formatPct(changeValue)}</span>`;
      const activate = () => openSymbol(mover.symbol);
      row.addEventListener("click", activate);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
      target.appendChild(row);
    };

    (data.gainers || []).forEach((g) => renderMover(gainersDiv, g));
    (data.losers || []).forEach((g) => renderMover(losersDiv, g));
  } catch (e) {
    console.error("movers error", e);
  }
}

// --------------------------------------------------------------
// Macro world map (ECharts)
// --------------------------------------------------------------

async function ensureWorldMap() {
  if (worldMapReady) return;
  if (typeof echarts === "undefined") {
    console.error("ECharts not loaded for macro map");
    return;
  }
  if (!echarts.getMap("world")) {
    console.warn(
      "ECharts world map not registered. Make sure world.js is included in index.html."
    );
    return;
  }
  worldMapReady = true;
}


async function initMacroChart() {
  const dom = document.getElementById("macro-map");
  if (!dom) return;
  macroChart = echarts.init(dom, null, { renderer: "canvas" });
  await ensureWorldMap();
  await loadMacroData("inflation");
}

function setupMacroTabs() {
  document.querySelectorAll(".mt-macro-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".mt-macro-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const metric = btn.getAttribute("data-metric");
      loadMacroData(metric);
    });
  });
}

// --------------------------------------------------------------
// Menu & Heatmap
// --------------------------------------------------------------

function setupMenuAndShortcuts() {
  const menuToggle = document.getElementById("menu-toggle");
  const dropdown = document.getElementById("menu-dropdown");
  if (menuToggle && dropdown) {
    menuToggle.addEventListener("click", (event) => {
      event.stopPropagation();
      dropdown.classList.toggle("open");
    });
    document.addEventListener("click", (event) => {
      if (!dropdown.contains(event.target) && event.target !== menuToggle) {
        dropdown.classList.remove("open");
      }
    });
  }
  document.querySelectorAll(".mt-menu-item[data-shortcut-symbol]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.getAttribute("data-shortcut-symbol");
      if (sym) {
        openSymbol(sym);
      }
      if (dropdown && dropdown.classList.contains("open")) {
        dropdown.classList.remove("open");
      }
    });
  });
}

let heatmapScriptLoaded = false;

function ensureHeatmapScript() {
  return new Promise((resolve, reject) => {
    if (heatmapScriptLoaded) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = HEATMAP_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      heatmapScriptLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error("Heatmap script load failed"));
    document.body.appendChild(script);
  });
}

async function initHeatmapWidget() {
  const container = document.getElementById("heatmap-widget");
  if (!container) return;
  container.innerHTML = "";
  await ensureHeatmapScript();
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.async = true;
  script.innerHTML = JSON.stringify(
    {
      colorTheme: lastTheme === "dark" ? "dark" : "light",
      dateRange: "1D",
      exchange: "US",
      showSymbolLogo: true,
      isTransparent: false,
      showFloatingTooltip: false,
      width: "100%",
      height: "100%",
      plotType: "heatmap",
      scaleMode: "percent",
      fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    },
    null,
    2
  );
  container.innerHTML = "";
  container.appendChild(script);
}

function setupHeatmapModal() {
  const openBtn = document.getElementById("heatmap-link");
  const modal = document.getElementById("heatmap-modal");
  if (!openBtn || !modal) return;
  const closeBtn = modal.querySelector(".mt-modal-close");
  const openModal = async () => {
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    try {
      await initHeatmapWidget();
    } catch (e) {
      console.error("heatmap widget error", e);
    }
  };
  const closeModal = () => {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  };
  openBtn.addEventListener("click", (event) => {
    event.preventDefault();
    openModal();
  });
  if (closeBtn) {
    closeBtn.addEventListener("click", closeModal);
  }
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) {
      closeModal();
    }
  });
}


// --------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------

function refreshAllForSymbol(symbol) {
  const sym = symbol.toUpperCase();
  currentSymbol = sym;
  document.getElementById("chart-symbol").textContent = sym;
  document.getElementById("news-symbol").textContent = sym;
  document.getElementById("insights-symbol").textContent = sym;
  refreshNews(sym);
  refreshInsights(sym);
}

// --------------------------------------------------------------
// Init
// --------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  applyTheme("dark");
  initThemeToggle();
  setupMenuAndShortcuts();
  setupHeatmapModal();
  setupRowResizers();
  setupColResizers();

  loadChart(currentSymbol);
  refreshAllForSymbol(currentSymbol);
  refreshCalendar();
  refreshMovers();
  refreshTickerBar();
  setInterval(refreshTickerBar, 20000);
  setInterval(refreshMovers, 90000);
  setInterval(() => refreshNews(currentSymbol), 60000);

  setupMacroTabs();
  await initMacroChart();
});
