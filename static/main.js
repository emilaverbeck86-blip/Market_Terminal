let currentSymbol = "AAPL";
let lastTheme = "dark";
let macroChart = null;
let macroCurrentMetric = "inflation";
let worldMapReady = false;

const HEATMAP_SCRIPT_URL =
  "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";

let tvWidget = null;
let chartFallbackActive = false;
let chartRetryTimer = null;
let heatmapWidgetInitialized = false;

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

/* ------------------------------------------------------------
 * Utils
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 * Theme handling
 * ---------------------------------------------------------- */

function applyTheme(theme) {
  const body = document.body;

  if (theme === "light") {
    body.classList.remove("theme-dark");
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
    body.classList.add("theme-dark");
    theme = "dark";
  }

  lastTheme = theme;

  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.checked = theme === "light";

  try {
    loadChart(currentSymbol);
  } catch (e) {
    console.error("chart theme reload failed", e);
  }

  if (macroChart) {
    loadMacroData(macroCurrentMetric);
  }

  // force re-render heatmap next time
  heatmapWidgetInitialized = false;
}

function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  toggle.checked = lastTheme === "light";

  toggle.addEventListener("change", () => {
    const next = toggle.checked ? "light" : "dark";
    applyTheme(next);
  });
}

/* ------------------------------------------------------------
 * Layout resizers
 * ---------------------------------------------------------- */

function setRowHeight(rowId, value) {
  const clamped = clamp(value, ROW_MIN_HEIGHT, ROW_MAX_HEIGHT);
  document.documentElement.style.setProperty(`--${rowId}-height`, clamped + "px");
}

function setupRowResizers() {
  document.querySelectorAll("[data-row-resizer]").forEach((resizer) => {
    const rowId = resizer.getAttribute("data-row-resizer");
    const rowIndex = rowId ? rowId.replace("row", "") : null;
    const rowEl = rowIndex
      ? document.querySelector(`.mt-row[data-row="${rowIndex}"]`)
      : null;
    if (!rowEl) return;

    let startY = 0;
    let startHeight = 0;

    const onDown = (event) => {
      event.preventDefault();
      const clientY = event.touches ? event.touches[0].clientY : event.clientY;
      startY = clientY;

      const style = getComputedStyle(document.documentElement);
      const raw = style.getPropertyValue(`--${rowId}-height`) || "";
      const parsed = parseFloat(raw);
      startHeight =
        !isNaN(parsed) && parsed > 0
          ? parsed
          : rowEl.getBoundingClientRect().height;

      document.body.classList.add("mt-resizing-row");

      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    };

    const onMove = (event) => {
      const clientY = event.touches ? event.touches[0].clientY : event.clientY;
      const delta = clientY - startY;
      setRowHeight(rowId, startHeight + delta);
      if (macroChart) macroChart.resize();
    };

    const onUp = () => {
      document.body.classList.remove("mt-resizing-row");
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
    if (!row || !id) return;

    const leftVar = `--${id}-col1`;
    const rightVar = `--${id}-col2`;

    let startX = 0;
    let startLeftWidth = 0;
    let startRightWidth = 0;
    let rowWidth = 0;

    const onDown = (event) => {
      event.preventDefault();
      const clientX = event.touches ? event.touches[0].clientX : event.clientX;
      startX = clientX;

      const children = row.children;
      const left = children[0];
      const right = children[2];
      if (!left || !right) return;

      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      startLeftWidth = leftRect.width;
      startRightWidth = rightRect.width;
      rowWidth = row.getBoundingClientRect().width;

      document.body.classList.add("mt-resizing-col");

      window.addEventListener("mousemove", onMove);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("mouseup", onUp);
      window.addEventListener("touchend", onUp);
    };

    const onMove = (event) => {
      const clientX = event.touches ? event.touches[0].clientX : event.clientX;
      const delta = clientX - startX;

      let newLeft = clamp(
        startLeftWidth + delta,
        COL_MIN_WIDTH,
        rowWidth - COL_MIN_WIDTH - 8
      );
      let newRight = clamp(
        startRightWidth - delta,
        COL_MIN_WIDTH,
        rowWidth - COL_MIN_WIDTH - 8
      );

      if (newLeft + newRight + 8 > rowWidth) {
        newRight = rowWidth - newLeft - 8;
      }

      document.documentElement.style.setProperty(leftVar, newLeft + "px");
      document.documentElement.style.setProperty(rightVar, newRight + "px");

      if (macroChart) macroChart.resize();
    };

    const onUp = () => {
      document.body.classList.remove("mt-resizing-col");
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchend", onUp);
    };

    resizer.addEventListener("mousedown", onDown);
    resizer.addEventListener("touchstart", onDown, { passive: false });
  });
}

/* ------------------------------------------------------------
 * TradingView main chart
 * ---------------------------------------------------------- */

function renderChartPlaceholder(message) {
  const container = document.getElementById("tv-chart");
  if (!container) return;
  container.innerHTML = `<div class="mt-chart-placeholder">${message}</div>`;
  chartFallbackActive = true;
}

function loadChart(symbol) {
  currentSymbol = symbol.toUpperCase();
  const label = document.getElementById("chart-symbol");
  if (label) label.textContent = currentSymbol;

  const containerId = "tv-chart";
  const theme = lastTheme === "light" ? "light" : "dark";

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

/* ------------------------------------------------------------
 * Ticker bar
 * ---------------------------------------------------------- */

async function refreshTickerBar() {
  try {
    const data = await getJSON("/api/tickers");
    const bar = document.getElementById("ticker-bar");
    if (!bar) return;
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
          `<span class="mt-ticker-change ${changeClass}">${formatPct(
            change
          )}</span>`;
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

/* ------------------------------------------------------------
 * News
 * ---------------------------------------------------------- */

async function refreshNews(symbol) {
  const newsBox = document.getElementById("news-list");
  const label = document.getElementById("news-symbol");
  if (label) label.textContent = symbol.toUpperCase();
  if (!newsBox) return;

  newsBox.innerHTML = `<div class="mt-news-empty">Loading news…</div>`;

  try {
    const data = await getJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const items = data.items || [];
    newsBox.innerHTML = "";

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

/* ------------------------------------------------------------
 * Insights
 * ---------------------------------------------------------- */

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
      const cell = root.querySelector(
        `.mt-insight-value[data-period="${period}"]`
      );
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

/* ------------------------------------------------------------
 * Calendar
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 * Movers
 * ---------------------------------------------------------- */

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

/* ------------------------------------------------------------
 * Macro world map (ECharts)
 * ---------------------------------------------------------- */

async function ensureWorldMap() {
  if (worldMapReady) return;
  if (typeof echarts === "undefined") {
    throw new Error("ECharts not loaded");
  }

  if (echarts.getMap("terminal-world")) {
    worldMapReady = true;
    return;
  }

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

  throw new Error("Failed to load world map data");
}

async function loadMacroData(metric) {
  if (!macroChart) return;
  macroCurrentMetric = metric;

  try {
    await ensureWorldMap();
  } catch (err) {
    console.error("macro map error:", err);
    return;
  }

  try {
    const data = await getJSON(`/api/macro?metric=${metric}`);
    const metricName = data.metric || metric;
    const values = data.data || [];

    const seriesData = values.map((d) => {
      const rawValue =
        d.value === null || d.value === undefined ? null : Number(d.value);
      const numericValue =
        rawValue !== null && !isNaN(rawValue) ? rawValue : null;
      return {
        name: COUNTRY_NAMES[d.code] || d.code,
        value: numericValue,
        code: d.code,
      };
    });

    const numericValues = seriesData
      .map((d) =>
        typeof d.value === "number" && !isNaN(d.value) ? d.value : null
      )
      .filter((v) => v !== null);
    let minVal = numericValues.length ? Math.min(...numericValues) : 0;
    let maxVal = numericValues.length ? Math.max(...numericValues) : 10;
    if (minVal === maxVal) maxVal = minVal + 1;

    const label = MACRO_METRIC_LABELS[metricName] || metricName.toUpperCase();

    const option = {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const code = params.data?.code ? ` (${params.data.code})` : "";
          const value =
            params.value === undefined || params.value === null
              ? "N/A"
              : `${params.value}%`;
          return `${
            params.name || params.data?.code || ""
          }${code}<br/>${label}: ${value}`;
        },
      },
      visualMap: {
        type: "piecewise",
        orient: "horizontal",
        left: "center",
        bottom: 8,
        textStyle: {
          color:
            getComputedStyle(document.body).getPropertyValue(
              "--text-secondary-dark"
            ) || "#9ca3af",
        },
        pieces: [
          { max: 2, label: "< 2%" },
          { min: 2, max: 4, label: "2–4%" },
          { min: 4, max: 6, label: "4–6%" },
          { min: 6, label: "> 6%" },
        ],
        inRange: {
          color: ["#22c55e", "#eab308", "#f97316", "#b91c1c"],
        },
      },
      series: [
        {
          name: label,
          type: "map",
          map: "terminal-world",
          roam: true,
          emphasis: {
            label: { show: false },
          },
          itemStyle: {
            borderColor: "#4b5563",
            borderWidth: 0.5,
          },
          data: seriesData,
        },
      ],
    };

    macroChart.setOption(option, true);
  } catch (e) {
    console.error("macro data error", e);
  }
}

async function initMacroChart() {
  const dom = document.getElementById("macro-map");
  if (!dom || typeof echarts === "undefined") return;
  macroChart = echarts.init(dom, null, { renderer: "canvas" });
  await ensureWorldMap();
  await loadMacroData(macroCurrentMetric);
}

function setupMacroTabs() {
  document.querySelectorAll(".mt-macro-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".mt-macro-tab")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const metric = btn.getAttribute("data-metric") || "inflation";
      loadMacroData(metric);
    });
  });
}

/* ------------------------------------------------------------
 * Heatmap Modal (real TradingView S&P500 heatmap)
 * ---------------------------------------------------------- */

function initHeatmapWidget() {
  const container = document.getElementById("heatmap-widget-container");
  if (!container) return;

  container.innerHTML =
    '<div class="tradingview-widget-container__widget"></div>';

  const theme = lastTheme === "light" ? "light" : "dark";

  const config = {
    colorTheme: theme,
    dateRange: "1D",
    mapType: "s&p500",
    showSymbolTooltip: true,
    showFloatingTooltip: true,
    locale: "en",
    width: "100%",
    height: "100%",
    largeChartUrl: "",
  };

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src = HEATMAP_SCRIPT_URL;
  script.async = true;
  script.innerHTML = JSON.stringify(config);

  container.appendChild(script);
  heatmapWidgetInitialized = true;
}

function openHeatmapModal() {
  const modal = document.getElementById("heatmap-modal");
  if (!modal) return;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("mt-modal-open");

  // build / rebuild actual S&P500 heatmap
  heatmapWidgetInitialized = false;
  initHeatmapWidget();
}

function closeHeatmapModal() {
  const modal = document.getElementById("heatmap-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("mt-modal-open");
}

function setupHeatmapModal() {
  const openBtn = document.getElementById("heatmap-link");
  const modal = document.getElementById("heatmap-modal");
  if (!modal || !openBtn) return;
  const closeBtn = modal.querySelector(".mt-modal-close");

  openBtn.addEventListener("click", () => {
    openHeatmapModal();
  });

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      closeHeatmapModal();
    });
  }

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeHeatmapModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) {
      closeHeatmapModal();
    }
  });
}

/* ------------------------------------------------------------
 * Menu
 * ---------------------------------------------------------- */

function setupMenu() {
  const menuToggle = document.getElementById("menu-toggle");
  const dropdown = document.getElementById("menu-dropdown");
  if (!menuToggle || !dropdown) return;

  const toggleDropdown = () => {
    const isOpen = dropdown.classList.contains("open");
    if (isOpen) dropdown.classList.remove("open");
    else dropdown.classList.add("open");
  };

  menuToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleDropdown();
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.classList.contains("open")) return;
    if (!dropdown.contains(e.target) && e.target !== menuToggle) {
      dropdown.classList.remove("open");
    }
  });

  dropdown
    .querySelectorAll(".mt-menu-item[data-shortcut-symbol]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-shortcut-symbol");
        if (!sym) return;
        dropdown.classList.remove("open");
        openSymbol(sym);
      });
    });
}

/* ------------------------------------------------------------
 * Orchestration
 * ---------------------------------------------------------- */

function refreshAllForSymbol(symbol) {
  const sym = symbol.toUpperCase();
  currentSymbol = sym;
  const chartLabel = document.getElementById("chart-symbol");
  if (chartLabel) chartLabel.textContent = sym;
  const newsLabel = document.getElementById("news-symbol");
  if (newsLabel) newsLabel.textContent = sym;
  const insightsLabel = document.getElementById("insights-symbol");
  if (insightsLabel) insightsLabel.textContent = sym;

  refreshNews(sym);
  refreshInsights(sym);
}

/* ------------------------------------------------------------
 * Init
 * ---------------------------------------------------------- */

window.addEventListener("DOMContentLoaded", async () => {
  applyTheme("dark");
  initThemeToggle();
  setupRowResizers();
  setupColResizers();
  setupMenu();
  setupHeatmapModal();

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
