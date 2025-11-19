let currentSymbol = "AAPL";
let lastTheme = "dark";
let tvWidget = null;
let macroChart = null;
const HEATMAP_SCRIPT_URL = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";

const ROW_STORAGE_PREFIX = "mt-row-";
const COL_STORAGE_PREFIX = "mt-cols-";

const COUNTRY_NAMES = {
  US: "United States", CA: "Canada", BR: "Brazil", DE: "Germany", UK: "United Kingdom",
  FR: "France", ZA: "South Africa", IN: "India", CN: "China", JP: "Japan", AU: "Australia"
};

const MACRO_METRIC_LABELS = {
  inflation: "Inflation", rates: "Central Bank Rate", gdp: "GDP Growth", unemployment: "Unemployment"
};

// Utilities
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return res.json();
}

function formatPct(p) {
  if (p === null || p === undefined || isNaN(p)) return "–";
  const v = Number(p);
  return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
}

function safeStorageSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

function safeStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function saveRowHeight(varName, value) {
  safeStorageSet(`${ROW_STORAGE_PREFIX}${varName}`, value);
}

function applySavedRowHeights() {
  document.querySelectorAll(".mt-row[data-height-var]").forEach((row) => {
    const varName = row.getAttribute("data-height-var");
    const stored = varName ? safeStorageGet(`${ROW_STORAGE_PREFIX}${varName}`) : null;
    if (varName && stored) {
      document.documentElement.style.setProperty(varName, stored);
    }
  });
}

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
}

// TradingView chart
function renderChartPlaceholder(message) {
  const container = document.getElementById("tv-chart");
  if (!container) return;
  container.innerHTML = `<div class="chart-fallback">${message}</div>`;
}

function renderChart(symbol) {
  currentSymbol = symbol;
  document.getElementById("current-symbol").textContent = symbol;
  if (tvWidget) {
    try { tvWidget.remove(); } catch {}
    tvWidget = null;
  }
  if (window.TradingView && TradingView.widget) {
    tvWidget = new TradingView.widget({
      autosize: true,
      symbol: symbol,
      interval: "30",
      timezone: "Etc/UTC",
      theme: lastTheme,
      style: "1",
      locale: "en",
      toolbar_bg: lastTheme === "dark" ? "#0b0e13" : "#ffffff",
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: "tv-chart"
    });
  } else {
    renderChartPlaceholder("Chart cannot be loaded.");
  }
}

// Ticker bar
async function renderTickerBar() {
  const tickerBar = document.getElementById("ticker-bar");
  try {
    const data = await getJSON("/api/tickers");
    tickerBar.innerHTML = data.tickers.map(t => {
      return `<span class="ticker-symbol">${t.symbol}</span> 
              <span class="ticker-price">${t.price.toFixed(2)}</span> 
              <span class="ticker-change ${t.change_pct >= 0 ? "up" : "down"}">${formatPct(t.change_pct)}</span>`;
    }).join(" | ");
  } catch {
    tickerBar.textContent = "Ticker data unavailable";
  }
}

// News panel
async function renderNewsPanel(symbol) {
  const panel = document.getElementById("news-panel");
  document.getElementById("news-symbol").textContent = symbol;
  try {
    const result = await getJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    if (!result.items || !result.items.length) throw new Error("No news");
    panel.innerHTML = result.items.map(n => `
      <div class="news-item">
        <a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>
        <div class="news-meta">${n.source} - ${n.published_at || ""}</div>
      </div>
    `).join("");
  } catch {
    panel.innerHTML = "No headlines available.";
  }
}

// Market insights
async function renderInsightsPanel(symbol) {
  const panel = document.getElementById("insights-panel");
  document.getElementById("insights-symbol").textContent = symbol;
  try {
    const data = await getJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
    const periods = data.periods || {};
    let html = `<table class="insights-table"><thead><tr><th>Period</th><th>Change</th></tr></thead><tbody>`;
    for (const [period, change] of Object.entries(periods)) {
      html += `<tr><td>${period}</td><td>${formatPct(change)}</td></tr>`;
    }
    html += `</tbody></table>`;
    html += `<div class="insights-profile">${data.profile || ""}</div>`;
    panel.innerHTML = html;
  } catch {
    panel.innerHTML = "No performance snapshot available at this time.";
  }
}

// Economic calendar (dummy static data)
function renderCalendar() {
  const calendarBody = document.getElementById("calendar-body");
  const events = [
    { time: "08:30", country: "US", event: "Nonfarm Payrolls", actual: "210K", forecast: "185K", previous: "165K" },
    { time: "10:00", country: "US", event: "ISM Services PMI", actual: "52.4", forecast: "51.8", previous: "50.9" },
    { time: "14:00", country: "EU", event: "ECB Rate Decision", actual: "4.00%", forecast: "4.00%", previous: "4.00%" }
  ];
  calendarBody.innerHTML = events.map(e =>
    `<tr>
      <td>${e.time}</td><td>${e.country}</td><td>${e.event}</td><td>${e.actual}</td><td>${e.forecast}</td><td>${e.previous}</td>
    </tr>`).join("");
}

// Macro map with ECharts
async function renderMacroMap(metric = "inflation") {
  try {
    const data = await getJSON(`/api/macro?metric=${metric}`);
    if (!data || !data.data) throw new Error("Invalid data");
    const mapData = data.data.map(d => ({
      name: COUNTRY_NAMES[d.code] || d.code,
      value: d.value,
    }));
    const chartDom = document.getElementById("macro-map");
    if (!chartDom) return;
    if (macroChart) macroChart.dispose();
    macroChart = echarts.init(chartDom);
    macroChart.setOption({
      tooltip: { trigger: "item" },
      visualMap: {
        min: Math.min(...mapData.map(m => m.value)),
        max: Math.max(...mapData.map(m => m.value)),
        inRange: { color: ['#50a3ba', '#eac736', '#d94e5d'] },
        text: ['High', 'Low'],
        calculable: true,
      },
      series: [
        {
          name: metric,
          type: 'map',
          map: 'world',
          roam: true,
          emphasis: { label: { show: true }},
          data: mapData
        }
      ]
    });
  } catch {
    const macroContainer = document.getElementById("macro-map");
    if (macroContainer) macroContainer.innerText = "Macro map load failed";
  }
}

// Top movers panel
async function renderTopMovers() {
  try {
    const data = await getJSON("/api/movers");
    const gainersList = document.getElementById("gainers-list");
    const losersList = document.getElementById("losers-list");
    gainersList.innerHTML = data.gainers.map(item =>
      `<div class="mover-row">${item.symbol}: ${item.price.toFixed(2)} (${formatPct(item.change_pct)})</div>`
    ).join("");
    losersList.innerHTML = data.losers.map(item =>
      `<div class="mover-row">${item.symbol}: ${item.price.toFixed(2)} (${formatPct(item.change_pct)})</div>`
    ).join("");
  } catch {
    document.getElementById("gainers-list").innerText = "Unavailable";
    document.getElementById("losers-list").innerText = "Unavailable";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  applySavedRowHeights();
  applySavedColWidths();

  renderTickerBar();
  renderChart(currentSymbol);
  renderNewsPanel(currentSymbol);
  renderInsightsPanel(currentSymbol);
  renderCalendar();
  renderMacroMap();
  renderTopMovers();
document.getElementById("heatmap-link").addEventListener("click", () => {
  window.location.href = "/heatmap";

  // Future: Add event listeners for theme toggling, symbol change, heatmap, menu, etc.
});
