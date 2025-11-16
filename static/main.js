// ---------- Endpoints ----------
const TICKER_ENDPOINT = "/api/tickers";
const MOVERS_ENDPOINT = "/api/movers";
const NEWS_ENDPOINT = "/api/news";
const INSIGHTS_ENDPOINT = "/api/insights";

// ---------- DOM ----------
const tickerScroll = document.getElementById("tickerScroll");
const chartTitleEl = document.getElementById("chartTitle");
const newsSymbolEl = document.getElementById("newsSymbol");
const insightsSymbolEl = document.getElementById("insightsSymbol");
const newsList = document.getElementById("newsList");
const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");
const companyProfileEl = document.getElementById("companyProfile");

const perfEls = {
  "1W": document.getElementById("perf1W"),
  "1M": document.getElementById("perf1M"),
  "3M": document.getElementById("perf3M"),
  "6M": document.getElementById("perf6M"),
  YTD: document.getElementById("perfYTD"),
  "1Y": document.getElementById("perf1Y"),
};

const fundamentalsBtn = document.getElementById("fundamentalsBtn");
const menuToggle = document.getElementById("menuToggle");
const menuPanel = document.getElementById("menuPanel");
const themeSwitch = document.getElementById("themeSwitch");
const heatmapShortcut = document.getElementById("heatmapShortcut");

const row1 = document.getElementById("row1");
const row2 = document.getElementById("row2");
const row3 = document.getElementById("row3");

const rowResizer1 = document.getElementById("rowResizer1");
const rowResizer2 = document.getElementById("rowResizer2");
const colResizerRow1 = document.getElementById("colResizerRow1");

const tileChart = document.getElementById("tile-chart");
const tileNews = document.getElementById("tile-news");

// ---------- State ----------
let currentSymbol = "AAPL";
let tickerNodes = new Map();
let tickerDataCache = [];
let theme = "dark";
let tvWidget = null;

// ---------- Utils ----------
const fmtPrice = (v) =>
  typeof v === "number" && isFinite(v) ? v.toFixed(2) : "—";

const fmtPct = (v) => {
  if (v == null || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
};

const applyPctClass = (el, v) => {
  el.classList.remove("pos", "neg", "neu");
  if (v == null || !isFinite(v)) {
    el.classList.add("neu");
  } else if (v > 0) {
    el.classList.add("pos");
  } else if (v < 0) {
    el.classList.add("neg");
  } else {
    el.classList.add("neu");
  }
};

const setTheme = (mode) => {
  theme = mode;
  const root = document.documentElement;
  const body = document.body;
  root.setAttribute("data-theme", mode);
  body.classList.remove("theme-dark", "theme-light");
  body.classList.add(mode === "dark" ? "theme-dark" : "theme-light");
  themeSwitch.checked = mode === "light";
  localStorage.setItem("mt_theme", mode);

  if (currentSymbol) {
    mountTradingView(currentSymbol);
  }
};

const initTheme = () => {
  const stored = localStorage.getItem("mt_theme");
  if (stored === "light" || stored === "dark") {
    setTheme(stored);
  } else {
    setTheme("dark");
  }
};

// ---------- TradingView Chart ----------
function mountTradingView(symbol) {
  chartTitleEl.textContent = symbol;
  currentSymbol = symbol;

  const container = document.getElementById("tv_container");
  container.innerHTML = "";
  if (typeof TradingView === "undefined") {
    const msg = document.createElement("div");
    msg.className = "muted";
    msg.textContent = "TradingView failed to load.";
    container.appendChild(msg);
    return;
  }

  const tvTheme = theme === "dark" ? "dark" : "light";

  tvWidget = new TradingView.widget({
    width: "100%",
    height: "100%",
    symbol: symbol,
    interval: "60",
    timezone: "Etc/UTC",
    theme: tvTheme,
    style: "1",
    locale: "en",
    toolbar_bg: "#000000",
    enable_publishing: false,
    allow_symbol_change: false,
    hide_top_toolbar: false,
    hide_legend: false,
    container_id: "tv_container",
  });
}

// ---------- Ticker bar ----------
function buildTickerRow(items) {
  tickerScroll.innerHTML = "";
  tickerNodes.clear();
  tickerDataCache = items.slice();

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
    applyPctClass(chg, tk.change_pct);
    chg.textContent = fmtPct(tk.change_pct);

    item.append(sym, price, chg);
    item.addEventListener("click", () => onSymbolSelect(tk.symbol));
    tickerScroll.appendChild(item);

    tickerNodes.set(tk.symbol, { item, price, chg, last: tk.price });
  });
}

function liveUpdateTickers(items) {
  tickerDataCache = items.slice();
  items.forEach((tk) => {
    const node = tickerNodes.get(tk.symbol);
    if (!node) return;
    const newPriceText = fmtPrice(tk.price);
    if (node.price.textContent !== newPriceText) {
      const up = (tk.price || 0) > (node.last || 0);
      node.item.classList.remove("flash-up", "flash-down");
      void node.item.offsetWidth;
      node.item.classList.add(up ? "flash-up" : "flash-down");
      setTimeout(
        () => node.item.classList.remove("flash-up", "flash-down"),
        500
      );
      node.price.textContent = newPriceText;
      node.last = tk.price;
    }
    applyPctClass(node.chg, tk.change_pct);
    node.chg.textContent = fmtPct(tk.change_pct);
  });
}

async function loadTickers() {
  try {
    const r = await fetch(TICKER_ENDPOINT);
    if (!r.ok) return;
    const data = await r.json();
    if (!tickerScroll.childElementCount) {
      buildTickerRow(data);
      if (data.length && !currentSymbol) {
        onSymbolSelect(data[0].symbol);
      }
    } else {
      liveUpdateTickers(data);
    }
  } catch (e) {
    // ignore
  }
}

// ---------- News ----------
function renderNewsList(symbol, articles) {
  newsSymbolEl.textContent = symbol;
  newsList.innerHTML = "";
  if (!Array.isArray(articles) || !articles.length) {
    newsList.innerHTML = '<div class="muted">No headlines.</div>';
    return;
  }
  articles.forEach((n) => {
    const item = document.createElement("div");
    item.className = "news-item";

    const title = document.createElement("a");
    title.href = n.url || "#";
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = n.title || "(untitled)";

    const meta = document.createElement("div");
    meta.className = "muted";
    const src = n.source || "Source";
    const ts = n.published_at || "";
    meta.textContent = `${src}${ts ? " · " + ts : ""}`;

    item.append(title, meta);
    newsList.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML = '<div class="muted">Loading news…</div>';
  try {
    const r = await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) throw new Error("news error");
    const data = await r.json();
    renderNewsList(symbol, data);
  } catch (e) {
    newsList.innerHTML =
      '<div class="muted">Failed to load news. Try again later.</div>';
  }
}

// ---------- Insights ----------
function renderInsights(symbol, data) {
  insightsSymbolEl.textContent = symbol;
  const perf = data.perf || {};
  ["1W", "1M", "3M", "6M", "YTD", "1Y"].forEach((key) => {
    const el = perfEls[key];
    const val = perf[key];
    if (!el) return;
    el.textContent = fmtPct(val);
    el.classList.remove("pos", "neg", "neu");
    if (val == null || !isFinite(val)) {
      el.classList.add("neu");
    } else if (val > 0) {
      el.classList.add("pos");
    } else if (val < 0) {
      el.classList.add("neg");
    } else {
      el.classList.add("neu");
    }
  });

  const profile = data.profile || "No performance snapshot.";
  companyProfileEl.textContent = profile;
}

async function loadInsights(symbol) {
  Object.values(perfEls).forEach((el) => (el.textContent = "—"));
  companyProfileEl.textContent = "Loading insights…";
  try {
    const r = await fetch(
      `${INSIGHTS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`
    );
    if (!r.ok) throw new Error("insights error");
    const data = await r.json();
    renderInsights(symbol, data);
  } catch (e) {
    companyProfileEl.textContent = "Insights unavailable.";
  }
}

// ---------- Movers ----------
function renderMovers(data) {
  const gainers = data.gainers || [];
  const losers = data.losers || [];

  gainersBody.innerHTML = "";
  losersBody.innerHTML = "";

  gainers.forEach((g) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="sym-cell">${g.symbol}</td>
      <td class="num">${fmtPrice(g.price)}</td>
      <td class="num ${g.change_pct > 0 ? "pos" : "neg"}">${fmtPct(
      g.change_pct
    )}</td>`;
    tr.addEventListener("click", () => onSymbolSelect(g.symbol));
    gainersBody.appendChild(tr);
  });

  losers.forEach((l) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="sym-cell">${l.symbol}</td>
      <td class="num">${fmtPrice(l.price)}</td>
      <td class="num ${l.change_pct > 0 ? "pos" : "neg"}">${fmtPct(
      l.change_pct
    )}</td>`;
    tr.addEventListener("click", () => onSymbolSelect(l.symbol));
    losersBody.appendChild(tr);
  });
}

async function loadMovers() {
  try {
    const r = await fetch(MOVERS_ENDPOINT);
    if (!r.ok) return;
    const data = await r.json();
    renderMovers(data);
  } catch (e) {
    // ignore
  }
}

// ---------- Selection ----------
async function onSymbolSelect(symbol) {
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([loadNews(symbol), loadInsights(symbol)]);
}

// ---------- Menu / theme / tiles ----------
function initMenu() {
  menuToggle.addEventListener("click", () => {
    menuPanel.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menuPanel.contains(e.target) && !menuToggle.contains(e.target)) {
      menuPanel.classList.remove("open");
    }
  });

  themeSwitch.addEventListener("change", () => {
    setTheme(themeSwitch.checked ? "light" : "dark");
  });

  document.querySelectorAll(".menu-shortcut[data-symbol]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.dataset.symbol;
      if (sym) onSymbolSelect(sym);
    });
  });

  if (heatmapShortcut) {
    heatmapShortcut.addEventListener("click", () => {
      window.location.href = "/heatmap";
    });
  }

  document.querySelectorAll("[data-tile-toggle]").forEach((check) => {
    check.addEventListener("change", () => {
      const id = check.getAttribute("data-tile-toggle");
      const tile = document.querySelector(`[data-tile-id="${id}"]`);
      if (!tile) return;
      tile.style.display = check.checked ? "" : "none";
    });
  });

  document.querySelectorAll("[data-close-tile]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-close-tile");
      const tile = document.querySelector(`[data-tile-id="${id}"]`);
      const check = document.querySelector(`input[data-tile-toggle="${id}"]`);
      if (tile) tile.style.display = "none";
      if (check) check.checked = false;
    });
  });

  fundamentalsBtn.addEventListener("click", () => {
    window.location.href = "/fundamentals";
  });
}

// ---------- Resizing ----------
function initRowResizing() {
  let currentResizer = null;
  let startY = 0;
  let startHeightTop = 0;
  let startHeightBottom = 0;

  const onMouseMove = (e) => {
    if (!currentResizer) return;
    const dy = e.clientY - startY;

    const topRow = currentResizer === rowResizer1 ? row1 : row2;
    const bottomRow = currentResizer === rowResizer1 ? row2 : row3;

    const newTop = Math.max(150, startHeightTop + dy);
    const newBottom = Math.max(150, startHeightBottom - dy);

    topRow.style.height = newTop + "px";
    bottomRow.style.height = newBottom + "px";
  };

  const onMouseUp = () => {
    currentResizer = null;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  [rowResizer1, rowResizer2].forEach((resizer) => {
    resizer.addEventListener("mousedown", (e) => {
      e.preventDefault();
      currentResizer = resizer;
      startY = e.clientY;
      const topRow = resizer === rowResizer1 ? row1 : row2;
      const bottomRow = resizer === rowResizer1 ? row2 : row3;
      startHeightTop = topRow.getBoundingClientRect().height;
      startHeightBottom = bottomRow.getBoundingClientRect().height;

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
  });
}

function initColResizingRow1() {
  let isResizing = false;
  let startX = 0;
  let startWidthLeft = 0;
  let startWidthRight = 0;

  const onMove = (e) => {
    if (!isResizing) return;
    const dx = e.clientX - startX;
    const total = startWidthLeft + startWidthRight;
    let newLeft = startWidthLeft + dx;
    newLeft = Math.max(200, Math.min(total - 200, newLeft));
    const leftPct = (newLeft / total) * 100;
    const rightPct = 100 - leftPct;

    tileChart.style.flexBasis = leftPct + "%";
    tileNews.style.flexBasis = rightPct + "%";
  };

  const onUp = () => {
    isResizing = false;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };

  colResizerRow1.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rectLeft = tileChart.getBoundingClientRect();
    const rectRight = tileNews.getBoundingClientRect();
    startX = e.clientX;
    startWidthLeft = rectLeft.width;
    startWidthRight = rectRight.width;
    isResizing = true;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- Ticker scroll pause ----------
function initTickerScrollPause() {
  const bar = document.querySelector(".ticker-bar");
  bar.addEventListener("mouseenter", () => {
    bar.classList.add("paused");
  });
  bar.addEventListener("mouseleave", () => {
    bar.classList.remove("paused");
  });
}

// ---------- Boot ----------
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initMenu();
  initRowResizing();
  initColResizingRow1();
  initTickerScrollPause();

  row1.style.height = "420px";
  row2.style.height = "260px";
  row3.style.height = "260px";

  mountTradingView(currentSymbol);
  loadNews(currentSymbol);
  loadInsights(currentSymbol);
  loadTickers();
  loadMovers();

  // Longer intervals to avoid hammering Yahoo
  setInterval(loadTickers, 60000); // 60s
  setInterval(loadMovers, 120000); // 2 min
});
