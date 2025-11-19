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

  if (abs === 0) return "0.00%";
  if (abs < 0.01) {
    return (v > 0 ? "+" : "-") + "0.01%";
  }

  const sign = v > 0 ? "+" : "";
  return sign + v.toFixed(2) + "%";
}

function formatNumber(n, decimals = 2) {
  if (n === null || n === undefined || isNaN(n)) return "–";
  const v = Number(n);
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatShortNumber(n) {
  if (n === null || n === undefined || isNaN(n)) return "–";
  const v = Number(n);
  const abs = Math.abs(v);

  if (abs >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(1) + "K";

  return v.toFixed(2);
}

function formatDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const optsTime = { hour: "2-digit", minute: "2-digit" };
  const optsDate = {
    month: "short",
    day: "numeric",
  };

  if (sameDay) {
    return date.toLocaleTimeString(undefined, optsTime);
  }
  return (
    date.toLocaleDateString(undefined, optsDate) +
    " " +
    date.toLocaleTimeString(undefined, optsTime)
  );
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// --------------------------------------------------------------
// Theme
// --------------------------------------------------------------

function applyTheme(theme) {
  const body = document.body;
  if (theme === "light") {
    body.classList.add("theme-light");
    lastTheme = "light";
  } else {
    body.classList.remove("theme-light");
    lastTheme = "dark";
  }
}

function initThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  toggle.addEventListener("click", () => {
    const newTheme = lastTheme === "dark" ? "light" : "dark";
    applyTheme(newTheme);
  });
}

// --------------------------------------------------------------
// Chart: TradingView + fallback
// --------------------------------------------------------------

function showChartFallback(symbol, data) {
  chartFallbackActive = true;
  const fallbackEl = document.getElementById("chart-fallback");
  const widgetEl = document.getElementById("chart-widget");
  if (!fallbackEl || !widgetEl) return;

  fallbackEl.classList.remove("hidden");
  widgetEl.style.opacity = "0";

  document.getElementById("chart-fallback-symbol").textContent = symbol;

  const container = document.getElementById("chart-fallback-body");
  container.innerHTML = "";

  const metrics = [
    { label: "Last Price", key: "last", format: (v) => formatNumber(v, 2) },
    { label: "Change", key: "changePct", format: (v) => formatPct(v) },
    { label: "Volume", key: "volume", format: (v) => formatShortNumber(v) },
    { label: "Market Cap", key: "marketCap", format: (v) => formatShortNumber(v) },
    { label: "Day High", key: "dayHigh", format: (v) => formatNumber(v, 2) },
    { label: "Day Low", key: "dayLow", format: (v) => formatNumber(v, 2) },
  ];

  metrics.forEach((m) => {
    const row = document.createElement("div");
    row.className = "mt-chart-fallback-metric";

    const label = document.createElement("div");
    label.className = "mt-chart-fallback-metric-label";
    label.textContent = m.label;

    const valueEl = document.createElement("div");
    valueEl.className = "mt-chart-fallback-metric-value";

    const val = data ? data[m.key] : null;
    valueEl.textContent = m.format(val);

    if (m.key === "changePct" && val !== null && val !== undefined) {
      const numVal = Number(val);
      if (!isNaN(numVal)) {
        if (numVal > 0) valueEl.classList.add("positive");
        if (numVal < 0) valueEl.classList.add("negative");
      }
    }

    row.appendChild(label);
    row.appendChild(valueEl);
    container.appendChild(row);
  });
}

function hideChartFallback() {
  chartFallbackActive = false;
  const fallbackEl = document.getElementById("chart-fallback");
  const widgetEl = document.getElementById("chart-widget");
  if (!fallbackEl || !widgetEl) return;
  fallbackEl.classList.add("hidden");
  widgetEl.style.opacity = "1";
}

function loadChart(symbol) {
  const widgetContainer = document.getElementById("chart-widget");
  if (!widgetContainer) return;

  if (chartRetryTimer) {
    clearTimeout(chartRetryTimer);
    chartRetryTimer = null;
  }

  hideChartFallback();

  widgetContainer.innerHTML = "";

  const script = document.createElement("script");
  script.type = "text/javascript";

  const widgetConfig = {
    symbol: symbol,
    interval: "D",
    timezone: "Etc/UTC",
    theme: lastTheme === "dark" ? "dark" : "light",
    style: "1",
    locale: "en",
    toolbar_bg: lastTheme === "dark" ? "#020617" : "#f9fafb",
    hide_top_toolbar: false,
    hide_legend: false,
    withdateranges: true,
    range: "6M",
    allow_symbol_change: false,
    container_id: "chart-widget",
  };

  script.innerHTML = `
    new TradingView.widget(${JSON.stringify(widgetConfig)});
  `;

  widgetContainer.appendChild(script);

  chartRetryTimer = setTimeout(async () => {
    try {
      const rect = widgetContainer.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) {
        const fallbackData = await getJSON(`/api/price_snapshot?symbol=${symbol}`);
        showChartFallback(symbol, fallbackData);
      }
    } catch (e) {
      const fallbackData = await getJSON(`/api/price_snapshot?symbol=${symbol}`);
      showChartFallback(symbol, fallbackData);
    }
  }, 6000);
}

// --------------------------------------------------------------
// Ticker bar
// --------------------------------------------------------------

async function refreshTickerBar() {
  const container = document.getElementById("ticker-items");
  if (!container) return;

  try {
    const data = await getJSON("/api/ticker");
    container.innerHTML = "";

    data.forEach((item) => {
      const el = document.createElement("div");
      el.className = "mt-ticker-item";

      const symbol = document.createElement("span");
      symbol.className = "mt-ticker-symbol";
      symbol.textContent = item.symbol || "";

      const price = document.createElement("span");
      price.className = "mt-ticker-price";
      price.textContent = item.price != null ? item.price.toFixed(2) : "–";

      const change = document.createElement("span");
      change.className = "mt-ticker-change";
      const pct = item.change_pct;
      change.textContent = formatPct(pct);
      if (pct > 0) change.classList.add("positive");
      if (pct < 0) change.classList.add("negative");

      el.appendChild(symbol);
      el.appendChild(price);
      el.appendChild(change);

      el.dataset.symbol = item.symbol || "";
      el.addEventListener("click", () => {
        if (!item.symbol) return;
        refreshAllForSymbol(item.symbol);
      });

      container.appendChild(el);
    });
  } catch (e) {
    console.error("ticker error", e);
  }
}

// --------------------------------------------------------------
// News
// --------------------------------------------------------------

async function refreshNews(symbol) {
  const container = document.getElementById("news-container");
  const label = document.getElementById("news-symbol-label");
  if (label) label.textContent = symbol;
  if (!container) return;

  container.innerHTML = `<div class="mt-placeholder">Loading news…</div>`;

  try {
    const data = await getJSON(`/api/news?symbol=${symbol}`);
    container.innerHTML = "";

    if (!data || !data.articles || !data.articles.length) {
      container.innerHTML = `<div class="mt-placeholder">No headlines available.</div>`;
      return;
    }

    data.articles.forEach((article) => {
      const item = document.createElement("div");
      item.className = "mt-news-item";

      const headline = document.createElement("div");
      headline.className = "mt-news-headline";
      headline.textContent = article.headline || article.title || "Untitled";

      const meta = document.createElement("div");
      meta.className = "mt-news-meta";
      const source = article.source || "Unknown";
      const ts = formatDateTime(article.datetime || article.published_at);
      meta.textContent = `${source} • ${ts}`;

      item.appendChild(headline);
      item.appendChild(meta);

      if (article.url) {
        item.addEventListener("click", () => {
          window.open(article.url, "_blank", "noopener");
        });
      }

      container.appendChild(item);
    });
  } catch (e) {
    console.error("news error", e);
    container.innerHTML = `<div class="mt-placeholder">Failed to load news.</div>`;
  }
}

// --------------------------------------------------------------
// Insights
// --------------------------------------------------------------

async function refreshInsights(symbol) {
  const container = document.getElementById("insights-container");
  const label = document.getElementById("insights-symbol-label");
  if (label) label.textContent = symbol;
  if (!container) return;

  container.innerHTML = `<div class="mt-placeholder">Loading insights…</div>`;

  try {
    const data = await getJSON(`/api/insights?symbol=${symbol}`);
    container.innerHTML = "";

    if (!data || !data.insights || !data.insights.length) {
      container.innerHTML = `<div class="mt-placeholder">No insights available.</div>`;
      return;
    }

    data.insights.forEach((insight) => {
      const item = document.createElement("div");
      item.className = "mt-insight-item";

      const header = document.createElement("div");
      header.className = "mt-insight-header";

      const title = document.createElement("div");
      title.className = "mt-insight-title";
      title.textContent = insight.title || "Insight";

      const change = document.createElement("div");
      change.className = "mt-insight-change";
      const pct = insight.change_pct;
      change.textContent = formatPct(pct);
      if (pct > 0) change.classList.add("positive");
      if (pct < 0) change.classList.add("negative");

      const body = document.createElement("div");
      body.className = "mt-insight-body";
      body.textContent = insight.text || "";

      header.appendChild(title);
      header.appendChild(change);

      item.appendChild(header);
      item.appendChild(body);

      item.addEventListener("click", () => {
        refreshAllForSymbol(insight.symbol || symbol);
      });

      container.appendChild(item);
    });
  } catch (e) {
    console.error("insights error", e);
    container.innerHTML = `<div class="mt-placeholder">Failed to load insights.</div>`;
  }
}

// --------------------------------------------------------------
// Calendar
// --------------------------------------------------------------

async function refreshCalendar() {
  const container = document.getElementById("calendar-container");
  if (!container) return;

  container.innerHTML = `<div class="mt-placeholder">Loading events…</div>`;

  try {
    const data = await getJSON("/api/calendar");
    container.innerHTML = "";

    if (!data || !data.events || !data.events.length) {
      container.innerHTML = `<div class="mt-placeholder">No upcoming events.</div>`;
      return;
    }

    data.events.forEach((event) => {
      const item = document.createElement("div");
      item.className = "mt-calendar-item";

      const header = document.createElement("div");
      header.className = "mt-calendar-header";

      const left = document.createElement("span");
      left.textContent = event.country || event.symbol || "Event";

      const right = document.createElement("span");
      right.textContent = formatDateTime(event.datetime);

      header.appendChild(left);
      header.appendChild(right);

      const title = document.createElement("div");
      title.className = "mt-calendar-title";
      title.textContent = event.title || event.event || "Event";

      item.appendChild(header);
      item.appendChild(title);

      container.appendChild(item);
    });
  } catch (e) {
    console.error("calendar error", e);
    container.innerHTML = `<div class="mt-placeholder">Failed to load events.</div>`;
  }
}

// --------------------------------------------------------------
// Fundamentals
// --------------------------------------------------------------

async function refreshFundamentals(symbol) {
  const container = document.getElementById("fundamentals-container");
  const label = document.getElementById("fundamentals-symbol-label");
  if (label) label.textContent = symbol;
  if (!container) return;

  container.innerHTML = `<div class="mt-placeholder">Loading fundamentals…</div>`;

  try {
    const data = await getJSON(`/api/fundamentals?symbol=${symbol}`);
    container.innerHTML = "";

    if (!data) {
      container.innerHTML = `<div class="mt-placeholder">No fundamentals available.</div>`;
      return;
    }

    const grid = document.createElement("div");
    grid.className = "mt-fundamentals-grid";

    const rows = [
      { label: "Market Cap", value: formatShortNumber(data.market_cap) },
      { label: "P/E Ratio", value: data.pe_ratio ? data.pe_ratio.toFixed(2) : "–" },
      { label: "Dividend Yield", value: formatPct(data.dividend_yield) },
      { label: "EPS (TTM)", value: data.eps_ttm ? data.eps_ttm.toFixed(2) : "–" },
      { label: "52W High", value: data.high_52w ? data.high_52w.toFixed(2) : "–" },
      { label: "52W Low", value: data.low_52w ? data.low_52w.toFixed(2) : "–" },
      { label: "Beta", value: data.beta ? data.beta.toFixed(2) : "–" },
      { label: "Sector", value: data.sector || "–" },
    ];

    rows.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = "mt-fundamental-row";

      const labelEl = document.createElement("div");
      labelEl.className = "mt-fundamental-label";
      labelEl.textContent = row.label;

      const valueEl = document.createElement("div");
      valueEl.className = "mt-fundamental-value";
      valueEl.textContent = row.value;

      rowEl.appendChild(labelEl);
      rowEl.appendChild(valueEl);
      grid.appendChild(rowEl);
    });

    container.appendChild(grid);
  } catch (e) {
    console.error("fundamentals error", e);
    container.innerHTML = `<div class="mt-placeholder">Failed to load fundamentals.</div>`;
  }
}

// --------------------------------------------------------------
// Macro world map (ECharts)
// --------------------------------------------------------------

async function ensureWorldMap() {
  if (worldMapReady || echarts.getMap("terminal-world")) {
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
  console.error("world map error: no sources available");
}

async function loadMacroData(metric) {
  if (!macroChart) return;
  try {
    await ensureWorldMap();
    const data = await getJSON(`/api/macro?metric=${metric}`);
    const metricName = data.metric || metric;
    const values = data.data || [];

    const seriesData = values.map((d) => {
      const hasValue =
        d.value !== null &&
        d.value !== undefined &&
        !isNaN(Number(d.value));
      return {
        name: COUNTRY_NAMES[d.code] || d.code,
        value: hasValue ? Number(d.value) : null,
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
    if (minVal === maxVal) {
      maxVal = minVal + 1;
    }

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
          color: ["#fef9c3", "#fbbf24", "#ea580c", "#b91c1c"],
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
// Movers
// --------------------------------------------------------------

async function refreshMovers() {
  try {
    const data = await getJSON("/api/movers");
    const gainersContainer = document.getElementById("movers-gainers");
    const losersContainer = document.getElementById("movers-losers");
    if (!gainersContainer || !losersContainer) return;

    gainersContainer.innerHTML = "";
    losersContainer.innerHTML = "";

    const gainers = (data.gainers || []).slice(0, 10);
    const losers = (data.losers || []).slice(0, 10);

    if (!gainers.length) {
      gainersContainer.innerHTML = `<li class="mt-placeholder">No gainers.</li>`;
    } else {
      gainers.forEach((item) => {
        const li = document.createElement("li");
        li.className = "mt-movers-item";

        const left = document.createElement("span");
        left.className = "mt-movers-symbol";
        left.textContent = item.symbol;

        const right = document.createElement("span");
        right.className = "mt-movers-change positive";
        right.textContent = formatPct(item.change_pct);

        li.appendChild(left);
        li.appendChild(right);

        li.addEventListener("click", () => {
          refreshAllForSymbol(item.symbol);
        });

        gainersContainer.appendChild(li);
      });
    }

    if (!losers.length) {
      losersContainer.innerHTML = `<li class="mt-placeholder">No losers.</li>`;
    } else {
      losers.forEach((item) => {
        const li = document.createElement("li");
        li.className = "mt-movers-item";

        const left = document.createElement("span");
        left.className = "mt-movers-symbol";
        left.textContent = item.symbol;

        const right = document.createElement("span");
        right.className = "mt-movers-change negative";
        right.textContent = formatPct(item.change_pct);

        li.appendChild(left);
        li.appendChild(right);

        li.addEventListener("click", () => {
          refreshAllForSymbol(item.symbol);
        });

        losersContainer.appendChild(li);
      });
    }
  } catch (e) {
    console.error("movers error", e);
  }
}

// --------------------------------------------------------------
// Heatmap Modal (TradingView widget)
// --------------------------------------------------------------

let heatmapScriptLoaded = false;
let heatmapWidgetInitialized = false;

function openHeatmapModal() {
  const modal = document.getElementById("heatmap-modal");
  if (!modal) return;
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");

  if (!heatmapScriptLoaded) {
    const script = document.createElement("script");
    script.src = HEATMAP_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      heatmapScriptLoaded = true;
      initHeatmapWidget();
    };
    script.onerror = () => {
      console.error("Failed to load TradingView heatmap script");
    };
    document.body.appendChild(script);
  } else if (!heatmapWidgetInitialized) {
    initHeatmapWidget();
  }
}

function closeHeatmapModal() {
  const modal = document.getElementById("heatmap-modal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function initHeatmapWidget() {
  const container = document.getElementById("heatmap-widget");
  if (!container) return;
  if (heatmapWidgetInitialized) return;

  const script = document.createElement("script");
  script.type = "text/javascript";
  script.innerHTML = `
    new TradingView.widget({
      "container_id": "heatmap-widget",
      "widgetType": "heatmap",
      "dataSource": "SPX500",
      "exchange": "US",
      "showToolbar": true,
      "width": "100%",
      "height": "100%",
      "colorTheme": "${lastTheme === "dark" ? "dark" : "light"}",
      "locale": "en"
    });
  `;
  container.innerHTML = "";
  container.appendChild(script);
  heatmapWidgetInitialized = true;
}

function setupHeatmapModal() {
  const openBtn = document.getElementById("heatmap-open");
  const modal = document.getElementById("heatmap-modal");
  const closeBtn = modal ? modal.querySelector(".mt-modal-close") : null;

  if (!openBtn || !modal) return;

  openBtn.addEventListener("click", () => {
    openHeatmapModal();
  });

  closeBtn?.addEventListener("click", () => {
    closeHeatmapModal();
  });

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

// --------------------------------------------------------------
// Row & column resizers
// --------------------------------------------------------------

function setupRowResizers() {
  const resizers = document.querySelectorAll(".mt-row-resizer");
  const layout = document.querySelector(".mt-main-panel, .mt-side-panel");

  resizers.forEach((resizer) => {
    let startY;
    let startHeightTop;
    let startHeightBottom;

    const rowIndex = parseInt(resizer.getAttribute("data-row"), 10);

    const onMouseMove = (e) => {
      const deltaY = e.clientY - startY;

      const rowBlocks = document.querySelectorAll(".mt-row-block");
      const rows = document.querySelectorAll(".mt-row");

      if (!rows[rowIndex] || !rows[rowIndex + 1]) return;

      const topRow = rows[rowIndex];
      const bottomRow = rows[rowIndex + 1];

      const newTopHeight = clamp(
        startHeightTop + deltaY,
        ROW_MIN_HEIGHT,
        ROW_MAX_HEIGHT
      );
      const newBottomHeight = clamp(
        startHeightBottom - deltaY,
        ROW_MIN_HEIGHT,
        ROW_MAX_HEIGHT
      );

      topRow.style.height = newTopHeight + "px";
      bottomRow.style.height = newBottomHeight + "px";
    };

    const onMouseUp = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const rows = document.querySelectorAll(".mt-row");
      if (!rows[rowIndex] || !rows[rowIndex + 1]) return;

      const topRow = rows[rowIndex];
      const bottomRow = rows[rowIndex + 1];

      startY = e.clientY;
      startHeightTop = topRow.getBoundingClientRect().height;
      startHeightBottom = bottomRow.getBoundingClientRect().height;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

function setupColResizers() {
  const resizers = document.querySelectorAll(".mt-col-resizer");

  resizers.forEach((resizer) => {
    let startX;
    let startLeftWidth;
    let startRightWidth;

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const row = resizer.closest(".mt-row");
      if (!row) return;

      const left = row.children[0];
      const right = row.children[2];
      if (!left || !right) return;

      startX = e.clientX;
      startLeftWidth = left.getBoundingClientRect().width;
      startRightWidth = right.getBoundingClientRect().width;

      const onMouseMove = (ev) => {
        const deltaX = ev.clientX - startX;

        const newLeftWidth = clamp(
          startLeftWidth + deltaX,
          COL_MIN_WIDTH,
          COL_MAX_WIDTH
        );
        const newRightWidth = clamp(
          startRightWidth - deltaX,
          COL_MIN_WIDTH,
          COL_MAX_WIDTH
        );

        left.style.flexBasis = newLeftWidth + "px";
        right.style.flexBasis = newRightWidth + "px";
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

// --------------------------------------------------------------
// Watchlist, symbol handling
// --------------------------------------------------------------

function setupWatchlist() {
  const list = document.getElementById("watchlist");
  if (!list) return;

  list.querySelectorAll("li").forEach((item) => {
    item.addEventListener("click", () => {
      const symbol = item.getAttribute("data-symbol");
      if (!symbol) return;
      list.querySelectorAll("li").forEach((li) => li.classList.remove("active"));
      item.classList.add("active");
      refreshAllForSymbol(symbol);
    });
  });
}

function setupSymbolInput() {
  const input = document.getElementById("symbol-input");
  const button = document.getElementById("symbol-submit");

  if (!input || !button) return;

  const handleSubmit = () => {
    const val = (input.value || "").trim().toUpperCase();
    if (!val) return;
    refreshAllForSymbol(val);
  };

  button.addEventListener("click", handleSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      handleSubmit();
    }
  });
}

// --------------------------------------------------------------
// Master refresh
// --------------------------------------------------------------

function refreshAllForSymbol(symbol) {
  const sym = symbol.toUpperCase();
  currentSymbol = sym;
  document.getElementById("chart-symbol-label").textContent = sym;
  const watchLabelNews = document.getElementById("news-symbol-label");
  if (watchLabelNews) watchLabelNews.textContent = sym;
  const watchLabelInsights = document.getElementById("insights-symbol-label");
  if (watchLabelInsights) watchLabelInsights.textContent = sym;
  const watchLabelFund = document.getElementById("fundamentals-symbol-label");
  if (watchLabelFund) watchLabelFund.textContent = sym;

  loadChart(sym);
  refreshNews(sym);
  refreshInsights(sym);
  refreshFundamentals(sym);
}

// --------------------------------------------------------------
// Init
// --------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  applyTheme("dark");
  initThemeToggle();
  setupRowResizers();
  setupColResizers();
  setupWatchlist();
  setupSymbolInput();
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
