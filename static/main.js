// -------------------------------------------------------------
// Endpoints
// -------------------------------------------------------------
const TICKER_ENDPOINT = "/api/tickers";
const QUOTE_ENDPOINT = "/api/quote";
const INSIGHTS_ENDPOINT = "/api/insights";
const MOVERS_ENDPOINT = "/api/movers";
const NEWS_ENDPOINT = "/api/news";

// DOM references
const tickerScroll = document.getElementById("tickerScroll");
const tvContainer = document.getElementById("tv_container");
const chartTitleEl = document.getElementById("chartTitle");
const newsList = document.getElementById("newsList");
const insightsSymbolEl = document.getElementById("insightsSymbol");
const perfIds = {
  "1W": document.getElementById("perf1W"),
  "1M": document.getElementById("perf1M"),
  "3M": document.getElementById("perf3M"),
  "6M": document.getElementById("perf6M"),
  "YTD": document.getElementById("perfYTD"),
  "1Y": document.getElementById("perf1Y"),
};
const profileText = document.getElementById("profileText");
const domBody = document.getElementById("domBody");
const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");

const fundamentalsPanel = document.getElementById("fundamentalsPanel");
const fundamentalsBtn = document.getElementById("fundamentalsBtn");
const fundamentalsClose = document.getElementById("fundamentalsClose");
const fundamentalsSymbol = document.getElementById("fundamentalsSymbol");

// state
let currentSymbol = window.DEFAULT_SYMBOL || "AAPL";
let tvWidget = null;
let tickerNodes = new Map(); // symbol -> { item, priceEl, chgEl, last }

// -------------------------------------------------------------
// Helper functions
// -------------------------------------------------------------
function fmtPrice(v) {
  if (v == null || !isFinite(v)) return "—";
  return v.toFixed(2);
}
function fmtChange(v) {
  if (v == null || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}
function setChangeClass(el, v) {
  el.classList.remove("pos", "neg");
  if (v > 0) el.classList.add("pos");
  else if (v < 0) el.classList.add("neg");
}

function toTVSymbol(symbol) {
  if (symbol.startsWith("OANDA:") || symbol.includes(":")) return symbol;
  return symbol;
}

// -------------------------------------------------------------
// TradingView
// -------------------------------------------------------------
function mountMainChart(symbol) {
  chartTitleEl.textContent = symbol;
  tvContainer.innerHTML = "";

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = "TradingView widget failed to load.";
    tvContainer.appendChild(note);
    return;
  }

  tvWidget = new TradingView.widget({
    container_id: "tv_container",
    symbol: toTVSymbol(symbol),
    interval: "60",
    timezone: "Etc/UTC",
    theme: document.body.classList.contains("theme-dark") ? "dark" : "light",
    style: "1",
    locale: "en",
    toolbar_bg: "#000000",
    enable_publishing: false,
    hide_legend: false,
    allow_symbol_change: false,
    autosize: true,
  });
}

function mountCalendarWidget() {
  const container = document.getElementById("tv_calendar_container");
  if (!container) return;
  if (container.dataset.initialized === "1") return;

  const script = document.createElement("script");
  script.src =
    "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
  script.async = true;
  script.innerHTML = JSON.stringify({
    colorTheme: document.body.classList.contains("theme-dark") ? "dark" : "light",
    isTransparent: true,
    width: "100%",
    height: "100%",
    locale: "en",
    importanceFilter: "-1,0,1",
    countryFilter: "us",
  });
  container.appendChild(script);
  container.dataset.initialized = "1";
}

// -------------------------------------------------------------
// Ticker bar
// -------------------------------------------------------------
function buildTickerRow(items) {
  tickerScroll.innerHTML = "";
  tickerNodes.clear();

  const repeated = [...items, ...items];
  repeated.forEach((tk) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.sym = tk.symbol;

    const sym = document.createElement("span");
    sym.className = "sym";
    sym.textContent = tk.symbol;

    const price = document.createElement("span");
    price.className = "price";
    price.textContent = fmtPrice(tk.price);

    const chg = document.createElement("span");
    chg.className = "chg";
    setChangeClass(chg, tk.change_pct);
    chg.textContent = fmtChange(tk.change_pct);

    item.append(sym, price, chg);
    item.addEventListener("click", () => onSymbolSelect(tk.symbol));
    tickerScroll.appendChild(item);

    tickerNodes.set(tk.symbol, { item, priceEl: price, chgEl: chg, last: tk.price });
  });
}

function updateTickerRow(items) {
  items.forEach((tk) => {
    const node = tickerNodes.get(tk.symbol);
    if (!node) return;
    const { priceEl, chgEl } = node;
    if (tk.price != null) {
      priceEl.textContent = fmtPrice(tk.price);
      node.last = tk.price;
    }
    setChangeClass(chgEl, tk.change_pct);
    chgEl.textContent = fmtChange(tk.change_pct);
  });
}

async function loadTickers() {
  try {
    const res = await fetch(TICKER_ENDPOINT);
    const data = await res.json();
    if (!tickerScroll.childElementCount) {
      buildTickerRow(data);
    } else {
      updateTickerRow(data);
    }
  } catch (e) {
    // keep previous values
  }
}

// -------------------------------------------------------------
// Insights / DOM / Movers / News
// -------------------------------------------------------------
function applyPerf(perf) {
  Object.keys(perfIds).forEach((key) => {
    const el = perfIds[key];
    const val = perf[key];
    if (!el) return;
    if (val == null || !isFinite(val)) {
      el.textContent = "—";
      el.classList.remove("pos", "neg");
    } else {
      el.textContent = fmtChange(val);
      el.classList.remove("pos", "neg");
      if (val > 0) el.classList.add("pos");
      else if (val < 0) el.classList.add("neg");
    }
  });
}

async function loadInsights(symbol) {
  insightsSymbolEl.textContent = symbol;
  fundamentalsSymbol.textContent = symbol;
  profileText.textContent = "Loading profile…";
  try {
    const res = await fetch(`${INSIGHTS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    applyPerf(data.performance || {});
    profileText.textContent =
      data.profile ||
      "No profile available for this instrument. This placeholder keeps the layout consistent.";
  } catch (e) {
    profileText.textContent = "Could not load insights.";
  }
}

function buildDOMFromQuote(quote) {
  const price = quote && isFinite(quote.price) ? quote.price : null;
  if (price == null) {
    domBody.innerHTML =
      '<tr><td colspan="4" class="muted">Waiting for quote data…</td></tr>';
    return;
  }
  const rows = [];
  const levels = 7;
  const step = price * 0.0015 || 0.5;
  for (let i = levels; i >= 1; i--) {
    const ask = price + step * i;
    const bid = price - step * i;
    const bidSize = (Math.random() * 5 + 1).toFixed(2);
    const askSize = (Math.random() * 5 + 1).toFixed(2);
    rows.push({ bidSize, bid, ask, askSize });
  }
  let html = "";
  rows.forEach((r) => {
    html += `<tr>
      <td>${r.bidSize}</td>
      <td>${fmtPrice(r.bid)}</td>
      <td>${fmtPrice(r.ask)}</td>
      <td>${r.askSize}</td>
    </tr>`;
  });
  domBody.innerHTML = html;
}

async function loadQuoteForDOM(symbol) {
  try {
    const res = await fetch(`${QUOTE_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    buildDOMFromQuote(data);
  } catch (e) {
    domBody.innerHTML =
      '<tr><td colspan="4" class="muted">Unable to load depth data.</td></tr>';
  }
}

function renderNewsList(articles) {
  newsList.innerHTML = "";
  if (!articles || !articles.length) {
    newsList.innerHTML = '<div class="muted">No headlines.</div>';
    return;
  }
  articles.forEach((n) => {
    const item = document.createElement("div");
    item.className = "news-item";
    const title = document.createElement("div");
    title.className = "news-item-title";
    const a = document.createElement("a");
    a.href = n.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = n.title || "(untitled)";
    title.appendChild(a);

    const meta = document.createElement("div");
    meta.className = "news-item-meta";
    const src = n.source || "Source";
    const time = n.published_at || "";
    meta.textContent = time ? `${src} · ${time}` : src;

    item.append(title, meta);
    newsList.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML = '<div class="muted">Loading news…</div>';
  try {
    const res = await fetch(
      `${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    const data = await res.json();
    renderNewsList(data);
  } catch (e) {
    newsList.innerHTML = '<div class="muted">Failed to load news.</div>';
  }
}

function renderMovers(tableBody, items) {
  tableBody.innerHTML = "";
  if (!items || !items.length) {
    tableBody.innerHTML = '<tr><td class="muted">No data.</td></tr>';
    return;
  }
  items.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.symbol}</td><td>${fmtPrice(
      row.price
    )}</td><td class="${
      row.change_pct > 0 ? "pos" : row.change_pct < 0 ? "neg" : ""
    }">${fmtChange(row.change_pct)}</td>`;
    tr.addEventListener("click", () => onSymbolSelect(row.symbol));
    tableBody.appendChild(tr);
  });
}

async function loadMovers() {
  try {
    const res = await fetch(MOVERS_ENDPOINT);
    const data = await res.json();
    renderMovers(gainersBody, data.gainers);
    renderMovers(losersBody, data.losers);
  } catch (e) {
    // ignore
  }
}

// -------------------------------------------------------------
// Layout: column + row resizers
// -------------------------------------------------------------
function initColResizers() {
  const rows = document.querySelectorAll(".row");
  rows.forEach((row) => {
    const resizer = row.querySelector(".col-resizer");
    if (!resizer) return;

    const left = resizer.previousElementSibling;
    const right = resizer.nextElementSibling;

    let startX = 0;
    let startLeftWidth = 0;
    let startRightWidth = 0;

    function onMouseMove(e) {
      const dx = e.clientX - startX;
      const rowWidth = row.getBoundingClientRect().width;
      const minPixels = 220;

      let newLeft = startLeftWidth + dx;
      let newRight = startRightWidth - dx;

      if (newLeft < minPixels) {
        newLeft = minPixels;
        newRight = rowWidth - minPixels;
      } else if (newRight < minPixels) {
        newRight = minPixels;
        newLeft = rowWidth - minPixels;
      }

      const leftFlex = newLeft / rowWidth;
      const rightFlex = newRight / rowWidth;
      left.style.flex = leftFlex.toString();
      right.style.flex = rightFlex.toString();
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      resizer.classList.remove("active");
    }

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      startX = e.clientX;
      startLeftWidth = leftRect.width;
      startRightWidth = rightRect.width;
      resizer.classList.add("active");

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

function initRowResizers() {
  const grid = document.getElementById("gridRoot");
  const resizers = document.querySelectorAll(".row-resizer");
  const rows = Array.from(document.querySelectorAll(".row"));

  resizers.forEach((resizer) => {
    let startY = 0;
    let topRow = null;
    let bottomRow = null;
    let topHeight = 0;
    let bottomHeight = 0;

    function onMouseMove(e) {
      const dy = e.clientY - startY;
      const totalHeight = grid.getBoundingClientRect().height;
      const minPixels = 120;

      let newTop = topHeight + dy;
      let newBottom = bottomHeight - dy;

      if (newTop < minPixels) {
        newTop = minPixels;
        newBottom = topHeight + bottomHeight - minPixels;
      } else if (newBottom < minPixels) {
        newBottom = minPixels;
        newTop = topHeight + bottomHeight - minPixels;
      }

      const topFlex = newTop / totalHeight;
      const bottomFlex = newBottom / totalHeight;
      topRow.style.flex = topFlex.toString();
      bottomRow.style.flex = bottomFlex.toString();
    }

    function onMouseUp() {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      resizer.classList.remove("active");
    }

    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const between = resizer.dataset.between; // e.g. "1-2"
      if (!between) return;
      const [topIdx, botIdx] = between.split("-").map((x) => parseInt(x, 10));
      topRow = rows.find((r) => parseInt(r.dataset.row, 10) === topIdx);
      bottomRow = rows.find((r) => parseInt(r.dataset.row, 10) === botIdx);
      if (!topRow || !bottomRow) return;

      const topRect = topRow.getBoundingClientRect();
      const bottomRect = bottomRow.getBoundingClientRect();
      startY = e.clientY;
      topHeight = topRect.height;
      bottomHeight = bottomRect.height;
      resizer.classList.add("active");

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

// -------------------------------------------------------------
// Symbol selection + shortcuts
// -------------------------------------------------------------
async function onSymbolSelect(symbol) {
  currentSymbol = symbol;
  mountMainChart(symbol);
  await Promise.all([
    loadInsights(symbol),
    loadNews(symbol),
    loadQuoteForDOM(symbol),
  ]);
}

function initShortcuts() {
  document.querySelectorAll('[data-role="shortcut"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const tvSym = btn.dataset.symbol;
      mountMainChart(tvSym);

      const base = tvSym.split(":").pop();
      let logical = base;
      if (base === "US500USD") logical = "SPY";
      if (base === "NAS100USD") logical = "QQQ";

      currentSymbol = logical;
      onSymbolSelect(logical);
    });
  });
}

function initTickerHover() {
  if (!tickerScroll) return;
  tickerScroll.addEventListener("mouseenter", () => {
    tickerScroll.classList.add("paused");
  });
  tickerScroll.addEventListener("mouseleave", () => {
    tickerScroll.classList.remove("paused");
  });
}

// -------------------------------------------------------------
// Menu, theme, fundamentals panel
// -------------------------------------------------------------
function initMenuAndTheme() {
  const toggle = document.getElementById("menuToggle");
  const dropdown = document.getElementById("menuDropdown");
  const themeToggle = document.getElementById("themeToggle");
  const themeIcon = document.getElementById("themeIcon");

  toggle.addEventListener("click", () => {
    dropdown.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && !toggle.contains(e.target)) {
      dropdown.classList.remove("open");
    }
  });

  const stored = localStorage.getItem("mt-theme");
  if (stored === "light") {
    document.body.classList.remove("theme-dark");
    document.body.classList.add("theme-light");
    themeToggle.checked = true;
    themeIcon.textContent = "☀️";
  }

  themeToggle.addEventListener("change", () => {
    const isLight = themeToggle.checked;
    document.body.classList.toggle("theme-light", isLight);
    document.body.classList.toggle("theme-dark", !isLight);
    localStorage.setItem("mt-theme", isLight ? "light" : "dark");
    themeIcon.textContent = isLight ? "☀️" : "🌙";
    mountMainChart(currentSymbol);
    mountCalendarWidget();
  });

  fundamentalsBtn.addEventListener("click", () => {
    fundamentalsPanel.classList.toggle("open");
  });
  fundamentalsClose.addEventListener("click", () => {
    fundamentalsPanel.classList.remove("open");
  });
}

// -------------------------------------------------------------
// Init
// -------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  initMenuAndTheme();
  initColResizers();
  initRowResizers();
  initShortcuts();
  initTickerHover();
  mountCalendarWidget();

  await loadTickers();
  setInterval(loadTickers, 5 * 60 * 1000);

  await loadMovers();
  setInterval(loadMovers, 5 * 60 * 1000);

  await onSymbolSelect(currentSymbol);

  setInterval(() => {
    loadInsights(currentSymbol);
    loadNews(currentSymbol);
    loadQuoteForDOM(currentSymbol);
    loadMovers();
  }, 10 * 60 * 1000);
});
