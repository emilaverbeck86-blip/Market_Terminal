// global state
let currentSymbol = "AAPL";
let theme = "dark";
let tvWidget = null;
let isDraggingCol = false;
let isDraggingRow = false;
let dragContext = null;

// fallback tickers if backend returns empty
const FALLBACK_TICKERS = [
    { symbol: "AAPL", price: 272.5, changePercent: -0.2 },
    { symbol: "MSFT", price: 510.2, changePercent: 1.1 },
    { symbol: "NVDA", price: 190.1, changePercent: 1.8 },
    { symbol: "META", price: 320.4, changePercent: -0.4 },
    { symbol: "GOOGL", price: 276.4, changePercent: 0.6 },
    { symbol: "TSLA", price: 202.0, changePercent: -0.9 },
    { symbol: "AVGO", price: 342.7, changePercent: 0.7 },
    { symbol: "AMD", price: 156.3, changePercent: -0.5 },
    { symbol: "NFLX", price: 112.1, changePercent: -3.6 },
    { symbol: "ADBE", price: 333.4, changePercent: -0.8 },
    { symbol: "INTC", price: 35.8, changePercent: -1.3 },
    { symbol: "CSCO", price: 78.0, changePercent: 0.8 },
    { symbol: "QCOM", price: 173.9, changePercent: -0.3 },
    { symbol: "TXN", price: 159.3, changePercent: -1.9 },
    { symbol: "CRM", price: 255.4, changePercent: 0.4 },
    { symbol: "JPM", price: 303.6, changePercent: 1.3 },
    { symbol: "BAC", price: 52.4, changePercent: -0.5 },
    { symbol: "WFC", price: 85.0, changePercent: 0.3 },
    { symbol: "GS", price: 309.8, changePercent: 0.1 },
    { symbol: "V", price: 265.0, changePercent: 0.2 },
    { symbol: "MA", price: 405.1, changePercent: -0.1 },
    { symbol: "XOM", price: 112.5, changePercent: -0.6 },
    { symbol: "CVX", price: 148.2, changePercent: 0.3 },
    { symbol: "UNH", price: 510.7, changePercent: 0.5 },
    { symbol: "LLY", price: 785.3, changePercent: 0.9 },
    { symbol: "ABBV", price: 168.4, changePercent: -0.2 },
    { symbol: "SPY", price: 675.9, changePercent: -0.1 },
    { symbol: "QQQ", price: 525.4, changePercent: -0.2 }
];

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function setTheme(newTheme) {
    theme = newTheme;
    const body = document.body;
    body.classList.toggle("theme-dark", newTheme === "dark");
    body.classList.toggle("theme-light", newTheme === "light");
    localStorage.setItem("mt-theme", newTheme);
    renderChart(currentSymbol); // re-create TV widget with correct theme
}

function formatChange(pct) {
    const value = Number(pct) || 0;
    const sign = value > 0 ? "+" : "";
    return sign + value.toFixed(2) + "%";
}

// ---------------------------------------------------------------------
// tradingview chart
// ---------------------------------------------------------------------

function renderChart(symbol) {
    currentSymbol = symbol;
    const titleEl = document.getElementById("chart-title");
    if (titleEl) {
        titleEl.textContent = "Chart – " + symbol;
    }

    if (!window.TradingView || !window.TradingView.widget) {
        // wait until tv.js has loaded
        setTimeout(() => renderChart(symbol), 600);
        return;
    }

    if (tvWidget && tvWidget.remove) {
        tvWidget.remove();
    }

    tvWidget = new window.TradingView.widget({
        container_id: "tv_chart",
        symbol: symbol,
        interval: "60",
        timezone: "Etc/UTC",
        theme: theme === "dark" ? "dark" : "light",
        style: "1",
        locale: "en",
        toolbar_bg: "#1e222d",
        enable_publishing: false,
        hide_legend: false,
        hide_side_toolbar: false,
        allow_symbol_change: true,
        width: "100%",
        height: "100%"
    });
}

// ---------------------------------------------------------------------
// ticker bar
// ---------------------------------------------------------------------

async function loadTickers() {
    try {
        const resp = await fetch("/api/tickers");
        if (!resp.ok) throw new Error("failed");
        const data = await resp.json();
        return Array.isArray(data) && data.length ? data : FALLBACK_TICKERS;
    } catch (e) {
        return FALLBACK_TICKERS;
    }
}

function renderTickerBar(tickers) {
    const listEl = document.getElementById("ticker-list");
    if (!listEl) return;
    listEl.innerHTML = "";

    const doubled = [...tickers, ...tickers]; // for seamless loop

    doubled.forEach((t) => {
        const item = document.createElement("div");
        item.className = "ticker-item";
        item.dataset.symbol = t.symbol;

        const symbol = document.createElement("span");
        symbol.className = "ticker-symbol";
        symbol.textContent = t.symbol;

        const price = document.createElement("span");
        price.className = "ticker-price";
        price.textContent = Number(t.price).toFixed(2);

        const change = document.createElement("span");
        change.className =
            "ticker-change " + (t.changePercent >= 0 ? "pos" : "neg");
        change.textContent = formatChange(t.changePercent);

        item.appendChild(symbol);
        item.appendChild(price);
        item.appendChild(change);

        item.addEventListener("click", () => {
            changeSymbol(t.symbol);
        });

        listEl.appendChild(item);
    });
}

// ---------------------------------------------------------------------
// news
// ---------------------------------------------------------------------

async function loadNews(symbol) {
    const list = document.getElementById("news-list");
    const title = document.getElementById("news-title");
    if (!list) return;
    list.innerHTML = "<div class='news-item'>Loading news...</div>";
    if (title) title.textContent = "News – " + symbol;

    try {
        const resp = await fetch("/api/news?symbol=" + encodeURIComponent(symbol));
        if (!resp.ok) throw new Error("failed");
        const items = await resp.json();
        if (!Array.isArray(items) || !items.length) {
            list.innerHTML =
                "<div class='news-item'>No headlines available.</div>";
            return;
        }
        list.innerHTML = "";
        items.forEach((n) => {
            const div = document.createElement("div");
            div.className = "news-item";

            const titleEl = document.createElement("div");
            titleEl.className = "news-title";
            titleEl.textContent = n.title;

            const meta = document.createElement("div");
            meta.className = "news-meta";
            meta.textContent = (n.source || "") + (n.published ? " • " + n.published : "");

            div.appendChild(titleEl);
            div.appendChild(meta);

            div.addEventListener("click", () => {
                if (n.link) window.open(n.link, "_blank");
            });

            list.appendChild(div);
        });
    } catch (e) {
        list.innerHTML =
            "<div class='news-item'>Failed to load headlines.</div>";
    }
}

// ---------------------------------------------------------------------
// insights
// ---------------------------------------------------------------------

async function loadInsights(symbol) {
    const title = document.getElementById("insights-title");
    if (title) title.textContent = "Market Insights: " + symbol;

    try {
        const resp = await fetch("/api/insights?symbol=" + encodeURIComponent(symbol));
        if (!resp.ok) throw new Error("failed");
        const data = await resp.json();
        const perf = data.performance || {};
        const fields = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
        fields.forEach((k) => {
            const el = document.getElementById("perf-" + k);
            if (el) {
                const num = Number(perf[k]);
                el.textContent = isNaN(num) ? "–" : num.toFixed(2) + "%";
            }
        });

        const descEl = document.getElementById("insights-description");
        if (descEl) {
            descEl.textContent = data.description || "";
        }
    } catch (e) {
        const descEl = document.getElementById("insights-description");
        if (descEl) {
            descEl.textContent = "No performance snapshot available at this time.";
        }
    }
}

// ---------------------------------------------------------------------
// calendar
// ---------------------------------------------------------------------

async function loadCalendar() {
    const body = document.getElementById("calendar-body");
    if (!body) return;
    body.innerHTML = "<tr><td colspan='6'>Loading...</td></tr>";
    try {
        const resp = await fetch("/api/calendar");
        if (!resp.ok) throw new Error("failed");
        const events = await resp.json();
        if (!Array.isArray(events) || !events.length) {
            body.innerHTML = "<tr><td colspan='6'>No events available.</td></tr>";
            return;
        }
        body.innerHTML = "";
        events.forEach((ev) => {
            const tr = document.createElement("tr");
            tr.innerHTML =
                "<td>" + ev.time + "</td>" +
                "<td>" + ev.country + "</td>" +
                "<td>" + ev.event + "</td>" +
                "<td>" + ev.actual + "</td>" +
                "<td>" + ev.forecast + "</td>" +
                "<td>" + ev.previous + "</td>";
            body.appendChild(tr);
        });
    } catch (e) {
        body.innerHTML =
            "<tr><td colspan='6'>Failed to load calendar.</td></tr>";
    }
}

// ---------------------------------------------------------------------
// movers
// ---------------------------------------------------------------------

async function loadMovers() {
    const gainersEl = document.getElementById("gainers-list");
    const losersEl = document.getElementById("losers-list");
    if (!gainersEl || !losersEl) return;
    gainersEl.innerHTML = "<li>Loading...</li>";
    losersEl.innerHTML = "";

    try {
        const resp = await fetch("/api/movers");
        if (!resp.ok) throw new Error("failed");
        const data = await resp.json();
        const gainers = Array.isArray(data.gainers) ? data.gainers : [];
        const losers = Array.isArray(data.losers) ? data.losers : [];

        function renderList(list, dest) {
            dest.innerHTML = "";
            if (!list.length) {
                dest.innerHTML = "<li>No data</li>";
                return;
            }
            list.forEach((m) => {
                const li = document.createElement("li");
                li.className = "movers-item";
                const sym = document.createElement("span");
                sym.className = "movers-symbol";
                sym.textContent = m.symbol;
                const ch = document.createElement("span");
                ch.className =
                    "movers-change " +
                    (m.changePercent >= 0 ? "pos" : "neg");
                ch.textContent = formatChange(m.changePercent);
                li.appendChild(sym);
                li.appendChild(ch);
                dest.appendChild(li);
            });
        }

        renderList(gainers, gainersEl);
        renderList(losers, losersEl);
    } catch (e) {
        gainersEl.innerHTML = "<li>Failed to load data</li>";
        losersEl.innerHTML = "";
    }
}

// ---------------------------------------------------------------------
// macro map (simple regions with tooltips)
// ---------------------------------------------------------------------

const MACRO_DATA = {
    inflation: [
        { code: "US", name: "United States", value: 3.1, x: 18, y: 32 },
        { code: "CA", name: "Canada", value: 2.2, x: 18, y: 18 },
        { code: "BR", name: "Brazil", value: 5.8, x: 26, y: 52 },
        { code: "DE", name: "Germany", value: 2.0, x: 41, y: 28 },
        { code: "UK", name: "United Kingdom", value: 2.4, x: 37, y: 24 },
        { code: "ZA", name: "South Africa", value: 6.1, x: 43, y: 60 },
        { code: "IN", name: "India", value: 4.9, x: 55, y: 42 },
        { code: "CN", name: "China", value: 1.4, x: 63, y: 32 },
        { code: "JP", name: "Japan", value: 1.9, x: 69, y: 30 },
        { code: "AU", name: "Australia", value: 3.3, x: 70, y: 62 }
    ],
    rates: [
        { code: "US", name: "United States", value: 5.25, x: 18, y: 32 },
        { code: "EU", name: "Euro Area", value: 4.00, x: 41, y: 28 },
        { code: "UK", name: "United Kingdom", value: 5.00, x: 37, y: 24 },
        { code: "JP", name: "Japan", value: 0.10, x: 69, y: 30 },
        { code: "AU", name: "Australia", value: 4.10, x: 70, y: 62 }
    ],
    gdp: [
        { code: "US", name: "United States", value: 2.5, x: 18, y: 32 },
        { code: "CN", name: "China", value: 4.7, x: 63, y: 32 },
        { code: "IN", name: "India", value: 6.2, x: 55, y: 42 },
        { code: "DE", name: "Germany", value: 0.8, x: 41, y: 28 },
        { code: "BR", name: "Brazil", value: 2.1, x: 26, y: 52 }
    ],
    unemployment: [
        { code: "US", name: "United States", value: 3.8, x: 18, y: 32 },
        { code: "EU", name: "Euro Area", value: 6.5, x: 41, y: 28 },
        { code: "JP", name: "Japan", value: 2.6, x: 69, y: 30 },
        { code: "IN", name: "India", value: 7.1, x: 55, y: 42 },
        { code: "BR", name: "Brazil", value: 7.9, x: 26, y: 52 }
    ]
};

function colorForValue(v) {
    if (v < 2) return "band1";
    if (v < 4) return "band2";
    if (v < 6) return "band3";
    return "band4";
}

function renderMacroMap(metric) {
    const container = document.getElementById("macro-map");
    if (!container) return;
    container.innerHTML = "";
    const data = MACRO_DATA[metric] || [];

    const tooltip = document.createElement("div");
    tooltip.className = "macro-tooltip";
    tooltip.style.display = "none";
    container.appendChild(tooltip);

    data.forEach((d) => {
        const div = document.createElement("div");
        div.className = "region " + colorForValue(d.value);
        div.style.left = d.x + "%";
        div.style.top = d.y + "%";
        div.textContent = d.code;

        div.addEventListener("mouseenter", () => {
            tooltip.style.display = "block";
            tooltip.textContent = d.name + " – " + d.value.toFixed(1);
        });
        div.addEventListener("mousemove", (ev) => {
            const rect = container.getBoundingClientRect();
            tooltip.style.left = ev.clientX - rect.left + 10 + "px";
            tooltip.style.top = ev.clientY - rect.top + 10 + "px";
        });
        div.addEventListener("mouseleave", () => {
            tooltip.style.display = "none";
        });

        container.appendChild(div);
    });
}

function setupMacroControls() {
    const buttons = document.querySelectorAll(".macro-btn");
    buttons.forEach((btn) => {
        btn.addEventListener("click", () => {
            buttons.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const metric = btn.getAttribute("data-metric");
            renderMacroMap(metric);
        });
    });
    // initial
    renderMacroMap("inflation");
}

// ---------------------------------------------------------------------
// resize handlers
// ---------------------------------------------------------------------

function setupResizers() {
    // column between chart and news
    const colResizer = document.querySelector(".col-resizer");
    if (colResizer) {
        colResizer.addEventListener("mousedown", (e) => {
            isDraggingCol = true;
            const leftId = colResizer.getAttribute("data-left");
            const rightId = colResizer.getAttribute("data-right");
            const leftEl = document.getElementById(leftId);
            const rightEl = document.getElementById(rightId);
            if (!leftEl || !rightEl) return;
            const leftRect = leftEl.getBoundingClientRect();
            dragContext = {
                leftEl,
                rightEl,
                startX: e.clientX,
                leftWidth: leftRect.width
            };
            document.body.style.userSelect = "none";
        });
    }

    // rows
    document.querySelectorAll(".row-resizer").forEach((resizer) => {
        resizer.addEventListener("mousedown", (e) => {
            isDraggingRow = true;
            const topId = resizer.getAttribute("data-top");
            const bottomId = resizer.getAttribute("data-bottom");
            const topEl = document.getElementById(topId);
            const bottomEl = document.getElementById(bottomId);
            if (!topEl || !bottomEl) return;
            const topRect = topEl.getBoundingClientRect();
            dragContext = {
                topEl,
                bottomEl,
                startY: e.clientY,
                topHeight: topRect.height
            };
            document.body.style.userSelect = "none";
        });
    });

    document.addEventListener("mousemove", (e) => {
        if (isDraggingCol && dragContext && dragContext.leftEl && dragContext.rightEl) {
            const dx = e.clientX - dragContext.startX;
            const newLeft = Math.max(260, dragContext.leftWidth + dx);
            dragContext.leftEl.style.flex = "0 0 " + newLeft + "px";
        }
        if (isDraggingRow && dragContext && dragContext.topEl && dragContext.bottomEl) {
            const dy = e.clientY - dragContext.startY;
            const newTop = Math.max(220, dragContext.topHeight + dy);
            dragContext.topEl.style.flex = "0 0 " + newTop + "px";
        }
    });

    document.addEventListener("mouseup", () => {
        if (isDraggingCol || isDraggingRow) {
            isDraggingCol = false;
            isDraggingRow = false;
            dragContext = null;
            document.body.style.userSelect = "";
        }
    });
}

// ---------------------------------------------------------------------
// symbol change
// ---------------------------------------------------------------------

function changeSymbol(symbol) {
    currentSymbol = symbol;
    renderChart(symbol);
    loadNews(symbol);
    loadInsights(symbol);
}

// ---------------------------------------------------------------------
// menu / theme / navigation
// ---------------------------------------------------------------------

function setupMenuAndTheme() {
    const menuToggle = document.getElementById("menu-toggle");
    const dropdown = document.getElementById("menu-dropdown");
    const themeToggle = document.getElementById("theme-toggle");

    if (menuToggle && dropdown) {
        menuToggle.addEventListener("click", () => {
            dropdown.classList.toggle("hidden");
        });
        document.addEventListener("click", (e) => {
            if (!dropdown.contains(e.target) && e.target !== menuToggle) {
                dropdown.classList.add("hidden");
            }
        });
    }

    const stored = localStorage.getItem("mt-theme");
    const initialTheme = stored === "light" ? "light" : "dark";
    if (themeToggle) {
        themeToggle.checked = initialTheme === "dark";
        themeToggle.addEventListener("change", () => {
            setTheme(themeToggle.checked ? "dark" : "light");
        });
    }
    setTheme(initialTheme);

    // shortcuts
    document.querySelectorAll(".menu-shortcut").forEach((btn) => {
        btn.addEventListener("click", () => {
            const sym = btn.getAttribute("data-symbol");
            if (sym) changeSymbol(sym);
            if (dropdown) dropdown.classList.add("hidden");
        });
    });

    // tile visibility toggles
    document.querySelectorAll(".menu-check input[type='checkbox']").forEach((chk) => {
        chk.addEventListener("change", () => {
            const tileId = chk.getAttribute("data-tile");
            const tile = document.getElementById(tileId);
            if (!tile) return;
            tile.style.display = chk.checked ? "flex" : "none";
        });
    });

    const heatmapBtn = document.getElementById("heatmap-btn");
    if (heatmapBtn) {
        heatmapBtn.addEventListener("click", () => {
            window.location.href = "/heatmap";
        });
    }
}

// ---------------------------------------------------------------------
// init
// ---------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
    setupMenuAndTheme();
    setupResizers();
    setupMacroControls();

    // initial data
    const tickers = await loadTickers();
    renderTickerBar(tickers);

    changeSymbol(currentSymbol);
    loadCalendar();
    loadMovers();

    // refresh tickers / movers every 60 seconds (gentle)
    setInterval(async () => {
        const t = await loadTickers();
        renderTickerBar(t);
        loadMovers();
    }, 60000);
});
