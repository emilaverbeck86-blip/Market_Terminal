let currentSymbol = "AAPL";
let lastTheme = "dark";
let macroChart = null;
let worldMapReady = false;
const HEATMAP_SCRIPT_URL = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
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
    AU: "Australia"
};

const MACRO_METRIC_LABELS = {
    inflation: "Inflation",
    rates: "Central Bank Rate",
    gdp: "GDP Growth",
    unemployment: "Unemployment"
};

const ROW_MIN_HEIGHT = 180;
const ROW_STORAGE_PREFIX = "mt-row-";
const COL_STORAGE_PREFIX = "mt-cols-";
let heatmapModalOpen = false;

// --------------------------------------------------------------
// Utilities
// --------------------------------------------------------------

async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
}

function formatPct(p) {
    if (p === null || p === undefined || isNaN(p)) return "";
    const v = Number(p);
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
}

function themeIsDark() {
    return lastTheme === "dark";
}

function saveRowsToStorage(rows) {
    localStorage.setItem(ROW_STORAGE_PREFIX, JSON.stringify(rows));
}

function getRowsFromStorage() {
    const raw = localStorage.getItem(ROW_STORAGE_PREFIX);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// --------------------------------------------------------------
// Ticker Bar
// --------------------------------------------------------------

async function renderTickerBar() {
    try {
        const data = await getJSON("/api/tickers");
        const tickers = data.tickers;
        let html = "";
        for (let t of tickers) {
            html += `<span class="ticker">
                <span class="ticker-symbol">${t.symbol}</span>
                <span class="ticker-price">${t.price}</span>
                <span class="ticker-pct ${t.change_pct < 0 ? "down" : t.change_pct > 0 ? "up" : ""}">
                    ${formatPct(t.change_pct)}
                </span>
            </span>`;
        }
        document.getElementById("ticker-bar").innerHTML = html;
    } catch (e) {
        document.getElementById("ticker-bar").innerText = "Quotes unavailable";
    }
}

// --------------------------------------------------------------
// Chart Embedding & Terminal Views
// --------------------------------------------------------------

function renderChart(symbol) {
    currentSymbol = symbol;
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
            theme: themeIsDark() ? "dark" : "light",
            style: "1",
            locale: "en",
            toolbar_bg: themeIsDark() ? "#0b0e13" : "#ffffff",
            enable_publishing: false,
            allow_symbol_change: true,
            container_id: "main-chart"
        });
    } else {
        document.getElementById("main-chart").innerHTML = "<div class='chart-fallback'>Chart unavailable</div>";
    }
}

function switchTheme(theme) {
    lastTheme = theme;
    document.body.className = `theme-${theme}`;
    renderChart(currentSymbol);
    // Redraws/updates other theme-sensitive UI if any
}

// --------------------------------------------------------------
// Macro World Map
// --------------------------------------------------------------

async function renderMacroWorldMap(metric = "inflation") {
    try {
        const data = await getJSON(`/api/macro?metric=${metric}`);
        const worldMapContainer = document.getElementById("macro-map");
        if (!window.echarts || !worldMapContainer) return;
        const mapChart = echarts.init(worldMapContainer);
        const seriesData = data.data.map(entry => ({
            name: COUNTRY_NAMES[entry.code] || entry.code,
            value: entry.value
        }));
        mapChart.setOption({
            backgroundColor: "transparent",
            tooltip: { trigger: "item" },
            visualMap: {
                min: Math.min(...seriesData.map(e => e.value)),
                max: Math.max(...seriesData.map(e => e.value)),
                text: ["High", "Low"],
                left: "right",
                inRange: { color: ["#f5b316", "#12b981", "#f97373"] }
            },
            series: [{
                name: MACRO_METRIC_LABELS[metric] || metric,
                type: "map",
                map: "world",
                roam: true,
                emphasis: { disabled: false },
                data: seriesData
            }]
        });
        worldMapReady = true;
    } catch (e) {
        if (document.getElementById("macro-map"))
            document.getElementById("macro-map").innerText = "Failed to load macro map.";
    }
}

// --------------------------------------------------------------
// Movers Board
// --------------------------------------------------------------

async function renderMoversBoard() {
    try {
        const data = await getJSON("/api/movers");
        const gainers = data.gainers;
        const losers = data.losers;

        function rowHtml(item) {
            return `<div class="mover-row">
                <div class="mover-symbol">${item.symbol}</div>
                <div class="mover-price">${item.price}</div>
                <div class="mover-pct ${item.change_pct < 0 ? "down" : "up"}">
                    ${formatPct(item.change_pct)}
                </div>
            </div>`;
        }

        document.getElementById("gainers-list").innerHTML = gainers.map(rowHtml).join("");
        document.getElementById("losers-list").innerHTML = losers.map(rowHtml).join("");
    } catch (e) {
        document.getElementById("gainers-list").innerText = "Unavailable";
        document.getElementById("losers-list").innerText = "Unavailable";
    }
}

// --------------------------------------------------------------
// News & Insights
// --------------------------------------------------------------

async function renderNewsPanel(symbol) {
    try {
        const data = await getJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
        const items = data.items;
        let html = "";
        for (let n of items) {
            html += `<div class="news-row">
                <a class="news-title" href="${n.url}" target="_blank">${n.title}</a>
                <span class="news-source">${n.source || ""}</span>
                <span class="news-date">${n.published_at || ""}</span>
            </div>`;
        }
        document.getElementById("news-panel").innerHTML = html || "Keine News gefunden";
    } catch {
        document.getElementById("news-panel").innerText = "Keine News gefunden";
    }
}

async function renderInsightsPanel(symbol) {
    try {
        const data = await getJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
        const { periods, profile } = data;
        let rows = "";
        for (const [period, pct] of Object.entries(periods)) {
            rows += `<tr><td>${period}</td><td>${formatPct(pct)}</td></tr>`;
        }
        document.getElementById("insights-panel").innerHTML =
            `<div class="insight-profile">${profile}</div>
             <table class="insight-table">
                <tr><th>Period</th><th>Change</th></tr>
                ${rows}
             </table>`;
    } catch {
        document.getElementById("insights-panel").innerText = "Keine Daten gefunden";
    }
}

window.addEventListener("DOMContentLoaded", async () => {
    await renderTickerBar();
    renderChart(currentSymbol);
    renderMoversBoard();
    renderNewsPanel(currentSymbol);
    renderInsightsPanel(currentSymbol);
    renderMacroWorldMap("inflation");

    // Theme toggle
    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
        themeToggle.addEventListener("change", () => {
            const theme = themeToggle.checked ? "light" : "dark";
            switchTheme(theme);
        });
    }

    // Symbol selector (simplified for this template)
    const symbolSelector = document.getElementById("symbol-select");
    if (symbolSelector) {
        symbolSelector.addEventListener("change", async (e) => {
            const symbol = e.target.value;
            renderChart(symbol);
            renderNewsPanel(symbol);
            renderInsightsPanel(symbol);
        });
    }
});
