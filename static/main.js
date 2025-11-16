// ========================
// Config
// ========================
const ENDPOINTS = {
    tickers: "/api/tickers",
    news: "/api/news",
    insights: "/api/insights",
    calendar: "/api/calendar",
    movers: "/api/movers"
};

const DEFAULT_SYMBOL = "AAPL";

let currentSymbol = DEFAULT_SYMBOL;
let currentTheme = "dark";
let tvReady = false;

// ========================
// Theme + menu
// ========================
function initTheme() {
    const stored = localStorage.getItem("mt_theme");
    currentTheme = stored === "light" ? "light" : "dark";
    document.body.classList.toggle("light-theme", currentTheme === "light");

    const toggle = document.getElementById("themeToggle");
    if (toggle) {
        toggle.checked = currentTheme === "light";
        toggle.addEventListener("change", () => {
            currentTheme = toggle.checked ? "light" : "dark";
            document.body.classList.toggle("light-theme", currentTheme === "light");
            localStorage.setItem("mt_theme", currentTheme);
            // re-mount chart if on dashboard
            if (document.body.classList.contains("dashboard")) {
                mountChart(currentSymbol);
            }
        });
    }
}

function initMenu() {
    const btn = document.getElementById("menuToggle");
    const dd = document.getElementById("menuDropdown");
    if (!btn || !dd) return;

    btn.addEventListener("click", () => {
        dd.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
        if (!dd.contains(e.target) && e.target !== btn) {
            dd.classList.remove("open");
        }
    });

    // Tile toggles (only relevant on dashboard)
    const tileCheckboxes = dd.querySelectorAll("input[type='checkbox'][data-tile]");
    tileCheckboxes.forEach((cb) => {
        const selector = cb.getAttribute("data-tile");
        const tile = document.querySelector(selector);
        if (!tile) return;
        cb.checked = !tile.classList.contains("hidden");
        cb.addEventListener("change", () => {
            tile.classList.toggle("hidden", !cb.checked);
        });
    });

    // Shortcuts
    const shortcuts = dd.querySelectorAll(".shortcut-btn");
    shortcuts.forEach((btnShortcut) => {
        btnShortcut.addEventListener("click", () => {
            const symbol = btnShortcut.getAttribute("data-symbol");
            if (!symbol) return;
            if (document.body.classList.contains("dashboard")) {
                onSymbolChange(symbol);
            } else {
                // on fundamentals we just jump back to dashboard with symbol in hash
                window.location.href = "/#symbol=" + encodeURIComponent(symbol);
            }
            dd.classList.remove("open");
        });
    });
}

// ========================
// TradingView
// ========================
function ensureTV() {
    if (tvReady || typeof TradingView === "undefined") return;
    tvReady = !!TradingView;
}

function mountChart(symbol) {
    const container = document.getElementById("tv_chart");
    ensureTV();
    if (!container || !tvReady) return;

    currentSymbol = symbol;
    container.innerHTML = "";

    // Use TradingView widget
    new TradingView.widget({
        symbol: symbol,
        container_id: "tv_chart",
        autosize: true,
        interval: "60",
        timezone: "Etc/UTC",
        theme: currentTheme === "light" ? "light" : "dark",
        style: "1",
        locale: "en",
        hide_top_toolbar: false,
        hide_legend: false,
        allow_symbol_change: false
    });

    const title = document.getElementById("chartTitle");
    if (title) {
        title.textContent = "Chart – " + symbol;
    }
    const newsTitle = document.getElementById("newsTitle");
    if (newsTitle) {
        newsTitle.textContent = "News – " + symbol;
    }
    const insightsTitle = document.getElementById("insightsTitle");
    if (insightsTitle) {
        insightsTitle.textContent = "Market Insights: " + symbol;
    }

    // Fetch per-symbol data
    loadNews(symbol);
    loadInsights(symbol);
}

// ========================
// Ticker strip
// ========================
async function loadTickers() {
    const strip = document.getElementById("tickerInner");
    if (!strip) return;

    try {
        const res = await fetch(ENDPOINTS.tickers);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) return;

        // Duplicate for seamless scroll
        const doubled = [...data, ...data];

        strip.innerHTML = "";
        doubled.forEach((t) => {
            const item = document.createElement("div");
            item.className = "ticker-item";
            item.dataset.symbol = t.symbol;
            item.innerHTML = `
                <span class="ticker-symbol">${t.symbol}</span>
                <span class="ticker-price">${t.price ?? "--"}</span>
                <span class="ticker-chg ${t.change_pct > 0 ? "pos" : t.change_pct < 0 ? "neg" : ""}">
                    ${formatChange(t.change_pct)}
                </span>
            `;
            item.addEventListener("click", () => {
                if (document.body.classList.contains("dashboard")) {
                    onSymbolChange(t.symbol);
                } else {
                    window.location.href = "/#symbol=" + encodeURIComponent(t.symbol);
                }
            });
            strip.appendChild(item);
        });
    } catch (e) {
        // fail silently
        console.error("tickers error", e);
    }
}

function formatChange(v) {
    if (v == null || !isFinite(v)) return "0.00%";
    const s = v > 0 ? "+" : v < 0 ? "−" : "";
    return `${s}${Math.abs(v).toFixed(2)}%`;
}

// ========================
// News
// ========================
async function loadNews(symbol) {
    const list = document.getElementById("newsList");
    if (!list) return;
    list.innerHTML = '<div class="placeholder">Loading news…</div>';

    try {
        const res = await fetch(`${ENDPOINTS.news}?symbol=${encodeURIComponent(symbol)}`);
        const news = await res.json();
        list.innerHTML = "";

        if (!Array.isArray(news) || news.length === 0) {
            list.innerHTML = '<div class="placeholder">No headlines.</div>';
            return;
        }

        news.slice(0, 40).forEach((n) => {
            const div = document.createElement("div");
            div.className = "news-item";
            const a = document.createElement("a");
            a.href = n.url || "#";
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = n.title || "(untitled)";
            const meta = document.createElement("div");
            meta.className = "news-meta";
            const src = n.source || "Source";
            const time = n.time || "";
            meta.textContent = `${src}${time ? " · " + time : ""}`;
            div.appendChild(a);
            div.appendChild(meta);
            list.appendChild(div);
        });
    } catch (e) {
        console.error("news error", e);
        list.innerHTML = '<div class="placeholder">Failed to load news.</div>';
    }
}

// ========================
// Insights
// ========================
async function loadInsights(symbol) {
    const grid = document.getElementById("insightsGrid");
    const desc = document.getElementById("insightsDescription");
    if (!grid || !desc) return;

    grid.innerHTML = "";
    desc.textContent = "Loading profile…";

    try {
        const res = await fetch(`${ENDPOINTS.insights}?symbol=${encodeURIComponent(symbol)}`);
        const data = await res.json();

        const periods = data.periods || [];
        if (periods.length === 0) {
            grid.innerHTML = '<div class="placeholder">No performance snapshot.</div>';
        } else {
            periods.forEach((p) => {
                const cell = document.createElement("div");
                cell.className = "insight-cell";
                const label = document.createElement("div");
                label.className = "insight-label";
                label.textContent = p.label;
                const val = document.createElement("div");
                val.className =
                    "insight-value " +
                    (p.change > 0 ? "pos" : p.change < 0 ? "neg" : "");
                val.textContent = formatChange(p.change);
                cell.appendChild(label);
                cell.appendChild(val);
                grid.appendChild(cell);
            });
        }

        const profile = data.profile;
        if (profile) {
            desc.textContent = profile;
        } else {
            desc.textContent =
                "No company profile available at this time.";
        }
    } catch (e) {
        console.error("insights error", e);
        grid.innerHTML = '<div class="placeholder">Failed to load snapshot.</div>';
        desc.textContent = "Profile unavailable.";
    }
}

// ========================
// Calendar
// ========================
async function loadCalendar() {
    const body = document.getElementById("calendarBody");
    if (!body) return;

    body.innerHTML = `<tr><td colspan="6" class="placeholder">Loading events…</td></tr>`;

    try {
        const res = await fetch(ENDPOINTS.calendar);
        const events = await res.json();

        if (!Array.isArray(events) || events.length === 0) {
            body.innerHTML = `<tr><td colspan="6" class="placeholder">No events.</td></tr>`;
            return;
        }

        body.innerHTML = "";
        events.forEach((ev) => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${ev.time || ""}</td>
                <td>${ev.country || ""}</td>
                <td>${ev.event || ""}</td>
                <td>${ev.actual ?? ""}</td>
                <td>${ev.forecast ?? ""}</td>
                <td>${ev.previous ?? ""}</td>
            `;
            body.appendChild(tr);
        });
    } catch (e) {
        console.error("calendar error", e);
        body.innerHTML = `<tr><td colspan="6" class="placeholder">Failed to load events.</td></tr>`;
    }
}

// ========================
// Movers
// ========================
async function loadMovers() {
    const gBody = document.getElementById("gainersBody");
    const lBody = document.getElementById("losersBody");
    if (!gBody || !lBody) return;

    gBody.innerHTML = `<tr><td class="placeholder">Loading…</td></tr>`;
    lBody.innerHTML = `<tr><td class="placeholder">Loading…</td></tr>`;

    try {
        const res = await fetch(ENDPOINTS.movers);
        const data = await res.json();
        const gainers = data.gainers || [];
        const losers = data.losers || [];

        const fill = (tbody, rows) => {
            tbody.innerHTML = "";
            if (rows.length === 0) {
                tbody.innerHTML =
                    `<tr><td class="placeholder">No data.</td></tr>`;
                return;
            }
            rows.forEach((r) => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${r.symbol}</td>
                    <td style="text-align:right;">${r.price ?? "--"}</td>
                    <td style="text-align:right; color:${
                        r.change_pct > 0
                            ? "var(--success)"
                            : r.change_pct < 0
                            ? "var(--danger)"
                            : "var(--text-muted)"
                    }">${formatChange(r.change_pct)}</td>
                `;
                tr.addEventListener("click", () => onSymbolChange(r.symbol));
                tbody.appendChild(tr);
            });
        };

        fill(gBody, gainers);
        fill(lBody, losers);
    } catch (e) {
        console.error("movers error", e);
        gBody.innerHTML = `<tr><td class="placeholder">Failed.</td></tr>`;
        lBody.innerHTML = `<tr><td class="placeholder">Failed.</td></tr>`;
    }
}

// ========================
// Symbol selection
// ========================
function onSymbolChange(symbol) {
    currentSymbol = symbol;
    mountChart(symbol);
}

// ========================
// Fundamentals TV charts
// ========================
function initFundamentalsCharts() {
    if (typeof TradingView === "undefined") return;
    const spxContainer = document.getElementById("fundChartSPX");
    const ndxContainer = document.getElementById("fundChartNDX");

    if (spxContainer) {
        new TradingView.widget({
            symbol: "OANDA:US500USD",
            container_id: "fundChartSPX",
            autosize: true,
            interval: "D",
            timezone: "Etc/UTC",
            theme: document.body.classList.contains("light-theme")
                ? "light"
                : "dark",
            style: "1",
            locale: "en",
            hide_top_toolbar: true,
            hide_legend: true,
            allow_symbol_change: false
        });
    }

    if (ndxContainer) {
        new TradingView.widget({
            symbol: "OANDA:NAS100USD",
            container_id: "fundChartNDX",
            autosize: true,
            interval: "D",
            timezone: "Etc/UTC",
            theme: document.body.classList.contains("light-theme")
                ? "light"
                : "dark",
            style: "1",
            locale: "en",
            hide_top_toolbar: true,
            hide_legend: true,
            allow_symbol_change: false
        });
    }

    // simple dummy text for metrics (you can wire real analytics later)
    const spxTrend = document.getElementById("spxTrend");
    const spxVol = document.getElementById("spxVol");
    const ndxTrend = document.getElementById("ndxTrend");
    const ndxVol = document.getElementById("ndxVol");
    if (spxTrend) spxTrend.textContent = "Uptrend (last 3 months)";
    if (spxVol) spxVol.textContent = "Moderate";
    if (ndxTrend) ndxTrend.textContent = "Range-bound";
    if (ndxVol) ndxVol.textContent = "Elevated";
}

// ========================
// Boot
// ========================
document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initMenu();
    loadTickers();

    if (document.body.classList.contains("dashboard")) {
        // handle symbol passed in hash from fundamentals shortcuts
        const hash = window.location.hash || "";
        const m = hash.match(/symbol=([^&]+)/i);
        if (m) {
            currentSymbol = decodeURIComponent(m[1]);
        } else {
            currentSymbol = DEFAULT_SYMBOL;
        }

        // Wait a bit for TradingView to be ready
        const tryMount = () => {
            ensureTV();
            if (tvReady) {
                mountChart(currentSymbol);
                loadCalendar();
                loadMovers();
            } else {
                setTimeout(tryMount, 200);
            }
        };
        tryMount();
    } else if (document.body.classList.contains("fundamentals-page")) {
        const tryFundCharts = () => {
            if (typeof TradingView === "undefined") {
                setTimeout(tryFundCharts, 200);
                return;
            }
            initFundamentalsCharts();
        };
        tryFundCharts();
    }
});
