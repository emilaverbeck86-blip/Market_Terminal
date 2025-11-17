let currentSymbol = "AAPL";
let lastTheme = "dark";
let macroChart = null;
let worldMapReady = false;

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
const ROW_STORAGE_PREFIX = "mt-row-";
<<<<<<< ours
const COL_STORAGE_KEY = "mt-center-cols";
=======
const COL_STORAGE_PREFIX = "mt-cols-";
let heatmapModalOpen = false;
>>>>>>> theirs

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
  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(2) + "%";
}

function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch (err) {
    // ignore storage errors
  }
}

function safeStorageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function saveRowHeight(varName, value) {
  safeStorageSet(`${ROW_STORAGE_PREFIX}${varName}`, value);
}

function applySavedRowHeights() {
  document.querySelectorAll(".mt-row[data-height-var]").forEach((row) => {
    const varName = row.getAttribute("data-height-var");
    const stored = varName
      ? safeStorageGet(`${ROW_STORAGE_PREFIX}${varName}`)
      : null;
    if (varName && stored) {
      document.documentElement.style.setProperty(varName, stored);
    }
  });
}

<<<<<<< ours
function saveCenterCols(value) {
  safeStorageSet(COL_STORAGE_KEY, value);
}

function applySavedCenterCols() {
  const row = document.querySelector(".mt-row-center");
  const stored = safeStorageGet(COL_STORAGE_KEY);
  if (!row || !stored) return;
  const [left, right] = stored.split(",");
  if (left && right) {
    row.style.setProperty("--center-col1", left);
    row.style.setProperty("--center-col2", right);
  }
=======
function saveColWidths(key, value) {
  safeStorageSet(`${COL_STORAGE_PREFIX}${key}`, value);
}

function applySavedColWidths() {
  document.querySelectorAll(".mt-row[data-col-key]").forEach((row) => {
    const key = row.getAttribute("data-col-key");
    const leftVar = row.getAttribute("data-col-left");
    const rightVar = row.getAttribute("data-col-right");
    if (!key || !leftVar || !rightVar) return;
    const stored = safeStorageGet(`${COL_STORAGE_PREFIX}${key}`);
    if (!stored) return;
    const [left, right] = stored.split(",");
    if (left && right) {
      row.style.setProperty(leftVar, left.trim());
      row.style.setProperty(rightVar, right.trim());
    }
  });
>>>>>>> theirs
}

// --------------------------------------------------------------
// TradingView chart
// --------------------------------------------------------------

let tvWidget = null;

function loadChart(symbol) {
  currentSymbol = symbol.toUpperCase();
  document.getElementById("chart-symbol").textContent = currentSymbol;
  document.getElementById("news-symbol").textContent = currentSymbol;
  document.getElementById("insights-symbol").textContent = currentSymbol;

  const containerId = "tv-chart";

  if (tvWidget) {
    tvWidget.setSymbol(currentSymbol);
    return;
  }

  tvWidget = new TradingView.widget({
    symbol: currentSymbol,
    interval: "60",
    container_id: containerId,
    autosize: true,
    hide_top_toolbar: false,
    hide_legend: false,
    theme: lastTheme === "dark" ? "dark" : "light",
    locale: "en",
  });
}

function updateChartTheme() {
  if (!tvWidget) return;
  const theme = lastTheme === "dark" ? "dark" : "light";
  // easiest: recreate widget
  tvWidget = null;
  document.getElementById("tv-chart").innerHTML = "";
  loadChart(currentSymbol);
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
          loadChart(t.symbol);
          refreshAllForSymbol(t.symbol);
        });
        strip.appendChild(el);
      });
    }

    bar.appendChild(strip1);
    bar.appendChild(strip2);
  } catch (e) {
    console.error("ticker error", e);
  }
}

// --------------------------------------------------------------
// News
// --------------------------------------------------------------

async function refreshNews(symbol) {
  try {
    const data = await getJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const container = document.getElementById("news-container");
    container.innerHTML = "";
    const items = data.items || [];
    if (!items.length) {
      container.innerHTML =
        '<div class="mt-placeholder">No headlines available.</div>';
      return;
    }
    items.forEach((n) => {
      const row = document.createElement("div");
      row.className = "mt-news-item";
      const a = document.createElement("a");
      a.className = "mt-news-title";
      a.href = n.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = n.title;
      const meta = document.createElement("div");
      meta.className = "mt-news-meta";
      meta.textContent = `${n.source || ""} ${n.published_at || ""}`;
      row.appendChild(a);
      row.appendChild(meta);
      container.appendChild(row);
    });
  } catch (e) {
    console.error("news error", e);
  }
}

// --------------------------------------------------------------
// Insights
// --------------------------------------------------------------

async function refreshInsights(symbol) {
  try {
    const data = await getJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
    const periods = data.periods || {};
    document.querySelectorAll(".mt-insight-value").forEach((el) => {
      const key = el.getAttribute("data-period");
      const val = periods[key] ?? null;
      el.textContent = formatPct(val);
      el.classList.remove("pos", "neg");
      if (val !== null && !isNaN(val)) {
        if (Number(val) > 0) el.classList.add("pos");
        if (Number(val) < 0) el.classList.add("neg");
      }
    });
    const profile = data.profile || "";
    document.getElementById("insights-profile").textContent = profile;
  } catch (e) {
    console.error("insights error", e);
  }
}

// --------------------------------------------------------------
// Macro world map (ECharts)
// --------------------------------------------------------------

async function initMacroChart() {
  const dom = document.getElementById("macro-map");
  if (!dom) return;
  macroChart = echarts.init(dom, null, { renderer: "canvas" });
  await ensureWorldMap();
  await loadMacroData("inflation");
}

async function ensureWorldMap() {
  if (worldMapReady || echarts.getMap("terminal-world")) {
    worldMapReady = true;
    return;
  }
<<<<<<< ours
  try {
    const res = await fetch("/static/world-simple.geo.json");
    const geoJson = await res.json();
    echarts.registerMap("terminal-world", geoJson);
    worldMapReady = true;
  } catch (err) {
    console.error("world map error", err);
  }
=======
  const sources = [
    "https://fastly.jsdelivr.net/npm/echarts@5/map/json/world.json",
    "/static/world-simple.geo.json",
  ];
  for (const src of sources) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const geoJson = await res.json();
      echarts.registerMap("terminal-world", geoJson);
      worldMapReady = true;
      return;
    } catch (err) {
      console.warn("world map load failed", src, err);
    }
  }
  console.error("world map error: no sources available");
>>>>>>> theirs
}

async function loadMacroData(metric) {
  if (!macroChart) return;
  try {
    await ensureWorldMap();
    const data = await getJSON(`/api/macro?metric=${metric}`);
    const metricName = data.metric || metric;
    const values = data.data || [];

    const seriesData = values.map((d) => {
      const rawValue =
        d.value === null || d.value === undefined ? null : Number(d.value);
      const numericValue = rawValue !== null && !isNaN(rawValue) ? rawValue : null;
      return {
        name: COUNTRY_NAMES[d.code] || d.code,
        value: numericValue,
        code: d.code,
      };
    });

    const numericValues = seriesData
      .map((d) => (typeof d.value === "number" && !isNaN(d.value) ? d.value : null))
      .filter((v) => v !== null);
    let minVal = numericValues.length ? Math.min(...numericValues) : 0;
    let maxVal = numericValues.length ? Math.max(...numericValues) : 10;
    if (minVal === maxVal) {
      maxVal = minVal + 1;
    }

    const label = MACRO_METRIC_LABELS[metricName] || metricName.toUpperCase();

    const option = {
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const code = params.data?.code ? ` (${params.data.code})` : "";
          const value =
            params.value === undefined || params.value === null
              ? "N/A"
              : `${params.value}%`;
          return `${params.name || params.data?.code || ""}${code}<br/>${label}: ${value}`;
        },
      },
      visualMap: {
        min: Math.floor(minVal),
        max: Math.ceil(maxVal),
        left: "left",
        top: "bottom",
        text: ["High", "Low"],
        calculable: false,
        inRange: {
          color: ["#22c55e", "#eab308", "#ef4444"],
        },
      },
      series: [
        {
          type: "map",
          map: "terminal-world",
          roam: true,
          emphasis: { label: { show: false } },
          data: seriesData,
        },
      ],
    };

    macroChart.setOption(option);
  } catch (e) {
    console.error("macro error", e);
  }
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
// Calendar
// --------------------------------------------------------------

async function refreshCalendar() {
  try {
    const data = await getJSON("/api/calendar");
    const tbody = document.querySelector("#calendar-table tbody");
    tbody.innerHTML = "";
    (data.events || []).forEach((e) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        `<td>${e.time}</td>` +
        `<td>${e.country}</td>` +
        `<td>${e.event}</td>` +
        `<td>${e.actual}</td>` +
        `<td>${e.forecast}</td>` +
        `<td>${e.previous}</td>`;
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
    gainersDiv.innerHTML = "";
    losersDiv.innerHTML = "";

    (data.gainers || []).forEach((g) => {
      const row = document.createElement("div");
      row.className = "mt-mover-row";
      const ch = Number(g.change_pct);
      row.innerHTML =
        `<span>${g.symbol}</span>` +
        `<span class="mt-mover-change ${ch >= 0 ? "pos" : "neg"}">${formatPct(
          ch
        )}</span>`;
      gainersDiv.appendChild(row);
    });

    (data.losers || []).forEach((g) => {
      const row = document.createElement("div");
      row.className = "mt-mover-row";
      const ch = Number(g.change_pct);
      row.innerHTML =
        `<span>${g.symbol}</span>` +
        `<span class="mt-mover-change ${ch >= 0 ? "pos" : "neg"}">${formatPct(
          ch
        )}</span>`;
      losersDiv.appendChild(row);
    });
  } catch (e) {
    console.error("movers error", e);
  }
}

// --------------------------------------------------------------
// Theme & menu
// --------------------------------------------------------------

function applyTheme(theme) {
  lastTheme = theme;
  const body = document.body;
  if (theme === "light") {
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
  }
  updateChartTheme();
  if (heatmapModalOpen) {
    loadHeatmapWidget();
  }
}

function setupThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  toggle.checked = false; // dark by default
  toggle.addEventListener("change", () => {
    applyTheme(toggle.checked ? "light" : "dark");
  });
}

function setupMenu() {
  const btn = document.getElementById("menu-toggle");
  const dd = document.getElementById("menu-dropdown");
  btn.addEventListener("click", () => {
    dd.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (!dd.contains(e.target) && !btn.contains(e.target)) {
      dd.classList.remove("open");
    }
  });

  document.querySelectorAll(".mt-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      const sym = item.getAttribute("data-shortcut-symbol");
      loadChart(sym);
      refreshAllForSymbol(sym);
      dd.classList.remove("open");
    });
  });
}

function loadHeatmapWidget() {
  const container = document.getElementById("heatmap-widget");
  if (!container || !window.TradingView) return;
  container.innerHTML = "";
  const theme = lastTheme === "light" ? "light" : "dark";
  new TradingView.widget({
    container_id: "heatmap-widget",
    width: "100%",
    height: "100%",
    dataSource: "S&P500",
    exchange: "US",
    blockSize: "market_cap_basic",
    blockColor: "change",
    colorTheme: theme,
    locale: "en",
    hasTopBar: false,
    showSymbolLogo: true,
    isDataSetEnabled: true,
    isSymbolTooltipEnabled: true,
    symbolSettings: [],
    plotType: "heatmap",
  });
}

function setupHeatmapModal() {
  const trigger = document.getElementById("heatmap-link");
  const modal = document.getElementById("heatmap-modal");
  if (!trigger || !modal) return;
  const closeBtn = modal.querySelector(".mt-modal-close");

  const close = () => {
    heatmapModalOpen = false;
    modal.classList.remove("open");
    document.body.classList.remove("mt-modal-open");
  };

  const open = () => {
    heatmapModalOpen = true;
    modal.classList.add("open");
    document.body.classList.add("mt-modal-open");
    loadHeatmapWidget();
  };

  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    open();
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", close);
  }

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && heatmapModalOpen) {
      close();
    }
  });
}

// --------------------------------------------------------------
// Layout resizing
<<<<<<< ours
// --------------------------------------------------------------

function setupRowResizers() {
  document.querySelectorAll(".mt-row-resizer").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => startRowResize(event, handle));
    handle.addEventListener(
      "touchstart",
      (event) => startRowResize(event, handle),
      { passive: false }
    );
  });
}

function startRowResize(event, handle) {
  if (event.cancelable) event.preventDefault();
  const row = handle.previousElementSibling;
  if (!row) return;
  const varName = row.getAttribute("data-height-var");
  if (!varName) return;
  const startY = event.touches ? event.touches[0].clientY : event.clientY;
  const startHeight = row.getBoundingClientRect().height;
  document.body.classList.add("mt-resizing-row");

  const onMove = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const delta = clientY - startY;
    const newHeight = Math.max(ROW_MIN_HEIGHT, startHeight + delta);
    document.documentElement.style.setProperty(varName, `${newHeight}px`);
    saveRowHeight(varName, `${newHeight}px`);
    window.dispatchEvent(new Event("resize"));
  };

  const onUp = () => {
    document.body.classList.remove("mt-resizing-row");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
}

function setupCenterColResizer() {
  const handle = document.querySelector(".mt-col-resizer[data-col-resizer='center']");
  if (!handle) return;
  const row = handle.closest(".mt-row");
  if (!row) return;

  const start = (event) => startCenterColResize(event, row);
  handle.addEventListener("mousedown", start);
  handle.addEventListener("touchstart", start, { passive: false });
}

function startCenterColResize(event, row) {
  if (event.cancelable) event.preventDefault();
  document.body.classList.add("mt-resizing-col");

  const onMove = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    const rect = row.getBoundingClientRect();
    if (!rect.width) return;
    const ratio = Math.min(0.75, Math.max(0.25, (clientX - rect.left) / rect.width));
    const leftWeight = Math.round(ratio * 100);
    const rightWeight = Math.max(20, 100 - leftWeight);
    row.style.setProperty("--center-col1", `${leftWeight}fr`);
    row.style.setProperty("--center-col2", `${rightWeight}fr`);
    saveCenterCols(`${leftWeight}fr,${rightWeight}fr`);
    window.dispatchEvent(new Event("resize"));
  };

  const onUp = () => {
    document.body.classList.remove("mt-resizing-col");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
}

// --------------------------------------------------------------
// Orchestration
=======
>>>>>>> theirs
// --------------------------------------------------------------

function setupRowResizers() {
  document.querySelectorAll(".mt-row-resizer").forEach((handle) => {
    handle.addEventListener("mousedown", (event) => startRowResize(event, handle));
    handle.addEventListener(
      "touchstart",
      (event) => startRowResize(event, handle),
      { passive: false }
    );
  });
}

function startRowResize(event, handle) {
  if (event.cancelable) event.preventDefault();
  const row = handle.previousElementSibling;
  if (!row) return;
  const varName = row.getAttribute("data-height-var");
  if (!varName) return;
  const startY = event.touches ? event.touches[0].clientY : event.clientY;
  const startHeight = row.getBoundingClientRect().height;
  document.body.classList.add("mt-resizing-row");

  const onMove = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
    const delta = clientY - startY;
    const newHeight = Math.max(ROW_MIN_HEIGHT, startHeight + delta);
    document.documentElement.style.setProperty(varName, `${newHeight}px`);
    saveRowHeight(varName, `${newHeight}px`);
    window.dispatchEvent(new Event("resize"));
  };

  const onUp = () => {
    document.body.classList.remove("mt-resizing-row");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
}

function setupColResizers() {
  document.querySelectorAll(".mt-col-resizer").forEach((handle) => {
    const row = handle.closest(".mt-row");
    if (!row) return;
    const key = row.getAttribute("data-col-key");
    const leftVar = row.getAttribute("data-col-left");
    const rightVar = row.getAttribute("data-col-right");
    if (!key || !leftVar || !rightVar) return;
    const start = (event) =>
      startColResize(event, row, { key, leftVar, rightVar });
    handle.addEventListener("mousedown", start);
    handle.addEventListener("touchstart", start, { passive: false });
  });
}

function startColResize(event, row, config) {
  if (event.cancelable) event.preventDefault();
  document.body.classList.add("mt-resizing-col");

  const onMove = (ev) => {
    if (ev.cancelable) ev.preventDefault();
    const rect = row.getBoundingClientRect();
    if (!rect.width) return;
    const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
    let ratio = (clientX - rect.left) / rect.width;
    ratio = Math.min(0.75, Math.max(0.25, ratio));
    const leftValue = Math.max(0.25, Math.round(ratio * 100) / 100);
    const rightValue = Math.max(0.25, Math.round((1 - ratio) * 100) / 100);
    row.style.setProperty(config.leftVar, `${leftValue}fr`);
    row.style.setProperty(config.rightVar, `${rightValue}fr`);
    saveColWidths(config.key, `${leftValue}fr,${rightValue}fr`);
    window.dispatchEvent(new Event("resize"));
  };

  const onUp = () => {
    document.body.classList.remove("mt-resizing-col");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("touchmove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("touchend", onUp);
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("touchmove", onMove, { passive: false });
  window.addEventListener("mouseup", onUp);
  window.addEventListener("touchend", onUp);
}

// --------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------

function refreshAllForSymbol(symbol) {
  const sym = symbol.toUpperCase();
  document.getElementById("chart-symbol").textContent = sym;
  document.getElementById("news-symbol").textContent = sym;
  document.getElementById("insights-symbol").textContent = sym;
  refreshNews(sym);
  refreshInsights(sym);
}

// --------------------------------------------------------------
// Init
// --------------------------------------------------------------

window.addEventListener("resize", () => {
  if (macroChart) {
    macroChart.resize();
  }
});

window.addEventListener("DOMContentLoaded", async () => {
  applySavedRowHeights();
<<<<<<< ours
  applySavedCenterCols();
=======
  applySavedColWidths();
>>>>>>> theirs
  setupMenu();
  setupThemeToggle();
  setupHeatmapModal();
  setupMacroTabs();
  setupRowResizers();
<<<<<<< ours
  setupCenterColResizer();
=======
  setupColResizers();
>>>>>>> theirs
  loadChart(currentSymbol);
  refreshAllForSymbol(currentSymbol);
  refreshCalendar();
  refreshMovers();
  refreshTickerBar();
  setInterval(refreshTickerBar, 20000);
  setInterval(refreshMovers, 90000);

  await initMacroChart();
});
