let currentSymbol = "AAPL";
let lastTheme = "dark";
let macroChart = null;

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
  macroChart = echarts.init(dom, null, {renderer: "canvas"});
  await loadMacroData("inflation");
}

async function loadMacroData(metric) {
  if (!macroChart) return;
  try {
    const data = await getJSON(`/api/macro?metric=${metric}`);
    const metricName = data.metric;
    const values = data.data || [];

    const seriesData = values.map((d) => ({
      name: d.code,
      value: d.value,
    }));

    const option = {
      tooltip: {
        trigger: "item",
        formatter: (p) =>
          `${p.name}<br/>${metricName.toUpperCase()}: ${p.value}%`,
      },
      visualMap: {
        min: 0,
        max: 10,
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
          map: "world",
          roam: true,
          emphasis: {label: {show: false}},
          data: seriesData,
        },
      ],
    };

    // load world geoJSON once
    if (!echarts.getMap("world")) {
      const res = await fetch(
        "https://fastly.jsdelivr.net/npm/echarts@5/examples/data/asset/geo/world.json"
      );
      const geoJson = await res.json();
      echarts.registerMap("world", geoJson);
    }
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

// --------------------------------------------------------------
// Orchestration
// --------------------------------------------------------------

function refreshAllForSymbol(symbol) {
  refreshNews(symbol);
  refreshInsights(symbol);
}

function setupHeatmapLink() {
  document
    .getElementById("heatmap-link")
    .addEventListener("click", () => (window.location.href = "/heatmap"));
}

// --------------------------------------------------------------
// Init
// --------------------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
  setupMenu();
  setupThemeToggle();
  setupHeatmapLink();
  setupMacroTabs();
  loadChart(currentSymbol);
  refreshAllForSymbol(currentSymbol);
  refreshCalendar();
  refreshMovers();
  refreshTickerBar();
  setInterval(refreshTickerBar, 60000);
  setInterval(refreshMovers, 90000);

  await initMacroChart();
});
