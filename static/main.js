let currentSymbol = "AAPL";
let tvWidget = null;

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* TradingView chart --------------------------------------------------- */

function initTradingViewChart(symbol) {
  currentSymbol = symbol;
  document.getElementById("chart-symbol-label").textContent = symbol;
  document.getElementById("news-symbol-label").textContent = symbol;
  document.getElementById("insights-symbol-label").textContent = symbol;

  const theme = document.body.classList.contains("theme-light")
    ? "light"
    : "dark";

  // clear old chart container
  const container = document.getElementById("tv_chart_container");
  container.innerHTML = "";
  tvWidget = new TradingView.widget({
    symbol: symbol,
    interval: "60",
    container_id: "tv_chart_container",
    autosize: true,
    timezone: "Etc/UTC",
    theme: theme,
    style: "1",
    locale: "en",
    enable_publishing: false,
    hide_side_toolbar: false,
    allow_symbol_change: true,
    studies: [],
    withdateranges: true,
    details: false,
    hotlist: false,
  });

  loadNews(symbol);
  loadInsights(symbol);
}

/* Ticker bar ---------------------------------------------------------- */

async function loadTickers() {
  const data = await fetchJSON("/api/tickers");
  if (!data || !data.tickers) return;

  const items = [...data.tickers, ...data.tickers]; // duplicate for smooth loop
  const inner = document.getElementById("ticker-inner");
  inner.innerHTML = "";

  items.forEach((t) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = t.symbol;

    const sym = document.createElement("span");
    sym.className = "ticker-symbol";
    sym.textContent = t.symbol;

    const price = document.createElement("span");
    price.className = "ticker-price";
    price.textContent = t.price.toFixed(2);

    const change = document.createElement("span");
    change.className = "ticker-change";
    change.textContent = (t.change > 0 ? "+" : "") + t.change.toFixed(2) + "%";
    if (t.change > 0) change.classList.add("positive");
    if (t.change < 0) change.classList.add("negative");

    item.appendChild(sym);
    item.appendChild(price);
    item.appendChild(change);

    item.addEventListener("click", () => {
      initTradingViewChart(t.symbol);
    });

    inner.appendChild(item);
  });
}

/* News --------------------------------------------------------------- */

async function loadNews(symbol) {
  const data = await fetchJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
  const list = document.getElementById("news-list");
  list.innerHTML = "";

  if (!data || !data.articles || !data.articles.length) {
    list.textContent = "No headlines.";
    return;
  }

  data.articles.forEach((a) => {
    const row = document.createElement("div");
    row.className = "news-item";

    const title = document.createElement("a");
    title.href = a.link;
    title.target = "_blank";
    title.rel = "noopener";
    title.textContent = a.title;
    title.className = "news-title news-link";

    const meta = document.createElement("div");
    meta.className = "news-meta";
    meta.textContent = `${a.source} · ${a.time}`;

    row.appendChild(title);
    row.appendChild(meta);
    list.appendChild(row);
  });
}

/* Insights ------------------------------------------------------------ */

async function loadInsights(symbol) {
  const data = await fetchJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
  if (!data) return;

  const snap = data.snapshot || {};
  const map = {
    "1W": "insight-1w",
    "1M": "insight-1m",
    "3M": "insight-3m",
    "6M": "insight-6m",
    "YTD": "insight-ytd",
    "1Y": "insight-1y",
  };

  Object.entries(map).forEach(([key, id]) => {
    const el = document.getElementById(id);
    el.classList.remove("positive", "negative");
    const v = snap[key];
    if (v === null || v === undefined) {
      el.textContent = "–";
      return;
    }
    el.textContent = (v > 0 ? "+" : "") + v.toFixed(2) + "%";
    if (v > 0) el.classList.add("positive");
    if (v < 0) el.classList.add("negative");
  });

  const prof = document.getElementById("insights-profile");
  prof.textContent = data.profile || "";
}

/* Movers -------------------------------------------------------------- */

async function loadMovers() {
  const data = await fetchJSON("/api/movers");
  if (!data) return;

  const gainersRoot = document.getElementById("gainers-list");
  const losersRoot = document.getElementById("losers-list");
  gainersRoot.innerHTML = "";
  losersRoot.innerHTML = "";

  (data.gainers || []).forEach((m) => {
    const row = document.createElement("div");
    row.className = "mover-row";

    const left = document.createElement("span");
    left.className = "mover-symbol";
    left.textContent = m.symbol;

    const right = document.createElement("span");
    right.className = "mover-change positive";
    right.textContent = "+" + m.change.toFixed(2) + "%";
    if (m.change < 0) {
      right.classList.remove("positive");
      right.classList.add("negative");
      right.textContent = m.change.toFixed(2) + "%";
    }

    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", () => initTradingViewChart(m.symbol));
    gainersRoot.appendChild(row);
  });

  (data.losers || []).forEach((m) => {
    const row = document.createElement("div");
    row.className = "mover-row";

    const left = document.createElement("span");
    left.className = "mover-symbol";
    left.textContent = m.symbol;

    const right = document.createElement("span");
    right.className = "mover-change negative";
    right.textContent = m.change.toFixed(2) + "%";
    if (m.change > 0) {
      right.classList.remove("negative");
      right.classList.add("positive");
      right.textContent = "+" + m.change.toFixed(2) + "%";
    }

    row.appendChild(left);
    row.appendChild(right);
    row.addEventListener("click", () => initTradingViewChart(m.symbol));
    losersRoot.appendChild(row);
  });
}

/* Theme & menu -------------------------------------------------------- */

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  btn.addEventListener("click", () => {
    const light = document.body.classList.toggle("theme-light");
    // rebuild chart with new theme
    initTradingViewChart(currentSymbol);
    // rebuild calendar theme by reloading page (simplest) – skipped to avoid flicker
  });
}

function setupMenu() {
  const btn = document.getElementById("menu-button");
  const dd = document.getElementById("menu-dropdown");
  btn.addEventListener("click", () => {
    dd.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!dd.contains(e.target) && !btn.contains(e.target)) {
      dd.classList.add("hidden");
    }
  });

  document.querySelectorAll(".menu-shortcut").forEach((el) => {
    el.addEventListener("click", () => {
      const sym = el.dataset.symbol;
      if (sym) initTradingViewChart(sym);
      dd.classList.add("hidden");
    });
  });
}

/* Init ---------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  setupThemeToggle();
  setupMenu();
  initTradingViewChart(currentSymbol);
  loadTickers();
  loadMovers();

  // refresh tickers & movers every 5 minutes to avoid hitting Yahoo too often
  setInterval(loadTickers, 5 * 60 * 1000);
  setInterval(loadMovers, 5 * 60 * 1000);
});
