let currentSymbol = "AAPL";
let theme = "dark";

// ------------------- Helpers -------------------

function $(sel) {
  return document.querySelector(sel);
}

function createEl(tag, className) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

// ------------------- Theme -------------------

function applyTheme(nextTheme) {
  theme = nextTheme;
  const body = document.body;
  const html = document.documentElement;

  if (theme === "light") {
    body.classList.remove("theme-dark");
    body.classList.add("theme-light");
    html.setAttribute("data-theme", "light");
  } else {
    body.classList.remove("theme-light");
    body.classList.add("theme-dark");
    html.setAttribute("data-theme", "dark");
  }

  renderChart(currentSymbol);
}

function initThemeToggle() {
  const toggle = $("#themeToggle");
  toggle.checked = theme === "dark";

  toggle.addEventListener("change", () => {
    applyTheme(toggle.checked ? "dark" : "light");
  });
}

// ------------------- Menu -------------------

function initMenu() {
  const btn = $("#menuButton");
  const dropdown = $("#menuDropdown");

  btn.addEventListener("click", () => {
    dropdown.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target) && !btn.contains(e.target)) {
      dropdown.classList.remove("open");
    }
  });

  document.querySelectorAll(".shortcut").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.getAttribute("data-symbol");
      setSymbol(sym);
      dropdown.classList.remove("open");
    });
  });

  const heatmapLink = $("#heatmapLink");
  heatmapLink.addEventListener("click", () => {
    window.location.href = "/heatmap";
  });
}

// ------------------- TradingView Chart -------------------

let tvWidget = null;

function renderChart(symbol) {
  const containerId = "tv-chart-container";
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = "";

  const themeName = theme === "light" ? "light" : "dark";

  tvWidget = new TradingView.widget({
    symbol: symbol,
    interval: "60",
    container_id: containerId,
    autosize: true,
    height: "100%",
    width: "100%",
    timezone: "Etc/UTC",
    theme: themeName,
    style: "1",
    hide_side_toolbar: false,
    hide_top_toolbar: false,
    locale: "en",
    enable_publishing: false,
    allow_symbol_change: false,
  });

  $("#chart-title").textContent = `Chart – ${symbol}`;
}

// ------------------- API calls -------------------

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function loadTickers() {
  const data = await fetchJSON("/api/tickers");
  if (!data || !Array.isArray(data.tickers)) return;
  renderTickerBar(data.tickers);
}

async function loadNews() {
  const data = await fetchJSON(`/api/news?symbol=${encodeURIComponent(currentSymbol)}`);
  const list = $("#news-list");
  list.innerHTML = "";

  if (!data || !Array.isArray(data.items) || data.items.length === 0) {
    list.textContent = "No headlines available.";
    return;
  }

  data.items.forEach((item) => {
    const wrapper = createEl("div", "news-item");
    const link = createEl("a", "news-item-title");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = item.title;
    const meta = createEl("div", "news-item-meta");
    meta.textContent = `${item.source} – ${item.published}`;
    wrapper.appendChild(link);
    wrapper.appendChild(meta);
    list.appendChild(wrapper);
  });

  $("#news-title").textContent = `News – ${currentSymbol}`;
}

async function loadInsights() {
  const data = await fetchJSON(`/api/insights?symbol=${encodeURIComponent(currentSymbol)}`);
  const grid = $("#insights-grid");
  const desc = $("#insights-description");
  grid.innerHTML = "";
  desc.textContent = "";

  if (!data || !Array.isArray(data.periods) || data.periods.length === 0) {
    desc.textContent = "No performance snapshot available at this time.";
    return;
  }

  data.periods.forEach((p) => {
    const box = createEl("div", "insight-box");
    const label = createEl("div", "insight-label");
    label.textContent = p.label;
    const val = createEl("div", "insight-value");
    if (p.value > 0) {
      val.classList.add("positive");
    } else if (p.value < 0) {
      val.classList.add("negative");
    }
    val.textContent = `${p.value.toFixed(2)}%`;
    box.appendChild(val);
    box.appendChild(label);
    grid.appendChild(box);
  });

  desc.textContent =
    "Performance snapshot based on Yahoo Finance historical daily data.";
  $("#insights-title").textContent = `Market Insights: ${currentSymbol}`;
}

async function loadMovers() {
  const data = await fetchJSON("/api/movers");
  const gainersEl = $("#gainers-list");
  const losersEl = $("#losers-list");
  gainersEl.innerHTML = "";
  losersEl.innerHTML = "";

  if (!data) {
    gainersEl.innerHTML = "<li>No data</li>";
    losersEl.innerHTML = "<li>No data</li>";
    return;
  }

  (data.gainers || []).forEach((item) => {
    const li = createEl("li", "mover-item");
    li.innerHTML = `<span>${item.symbol}</span><span class="ticker-change positive">${item.change_pct.toFixed(
      2
    )}%</span>`;
    gainersEl.appendChild(li);
  });

  (data.losers || []).forEach((item) => {
    const li = createEl("li", "mover-item");
    li.innerHTML = `<span>${item.symbol}</span><span class="ticker-change negative">${item.change_pct.toFixed(
      2
    )}%</span>`;
    losersEl.appendChild(li);
  });
}

// ------------------- Ticker bar -------------------

function renderTickerBar(tickers) {
  const track = $("#ticker-track");
  if (!track) return;
  track.innerHTML = "";

  const items = [...tickers, ...tickers]; // duplicate for smooth loop

  items.forEach((t) => {
    const item = createEl("div", "ticker-item");
    const symbol = createEl("span", "ticker-symbol");
    symbol.textContent = t.symbol;
    const price = createEl("span", "ticker-price");
    price.textContent = t.price.toFixed(2);
    const change = createEl("span", "ticker-change");
    change.textContent = `${t.change_pct.toFixed(2)}%`;
    if (t.change_pct > 0) change.classList.add("positive");
    if (t.change_pct < 0) change.classList.add("negative");

    item.appendChild(symbol);
    item.appendChild(price);
    item.appendChild(change);

    item.addEventListener("click", () => setSymbol(t.symbol));

    track.appendChild(item);
  });

  // pause on hover
  const bar = $("#ticker-bar");
  bar.addEventListener("mouseenter", () => {
    track.style.animationPlayState = "paused";
  });
  bar.addEventListener("mouseleave", () => {
    track.style.animationPlayState = "running";
  });
}

// ------------------- Macro map -------------------

function initMacroMap() {
  const tooltip = $("#macro-tooltip");
  const svg = $("#macro-map-svg");
  if (!svg) return;

  const data = {
    us: { name: "United States", inflation: "3.2%", gdp: "2.4%", rate: "5.50%" },
    eu: { name: "Euro Area", inflation: "2.7%", gdp: "0.6%", rate: "4.00%" },
    me: { name: "Middle East", inflation: "4.8%", gdp: "3.1%", rate: "4.25%" },
    asia: { name: "Asia-Pacific", inflation: "2.1%", gdp: "4.5%", rate: "3.00%" },
    latam: { name: "Latin America", inflation: "6.2%", gdp: "1.9%", rate: "7.50%" },
    aus: { name: "Australia & NZ", inflation: "3.5%", gdp: "2.1%", rate: "4.35%" },
  };

  svg.querySelectorAll(".country").forEach((el) => {
    const classes = Array.from(el.classList);
    const key = classes.find((c) => data[c]);
    if (!key) return;
    const info = data[key];

    el.addEventListener("mousemove", (e) => {
      const bbox = svg.getBoundingClientRect();
      tooltip.style.left = `${e.clientX - bbox.left}px`;
      tooltip.style.top = `${e.clientY - bbox.top}px`;
      tooltip.innerHTML = `<strong>${info.name}</strong><br/>Inflation: ${
        info.inflation
      }<br/>GDP: ${info.gdp}<br/>Policy rate: ${info.rate}`;
      tooltip.style.opacity = "1";
    });

    el.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
    });
  });
}

// ------------------- Economic calendar (static sample) -------------------

function loadCalendar() {
  const container = $("#calendar-container");
  container.innerHTML = "";

  const table = createEl("table", "calendar-table");
  const thead = createEl("thead");
  thead.innerHTML =
    "<tr><th>Time</th><th>Country</th><th>Event</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr>";
  table.appendChild(thead);

  const tbody = createEl("tbody");

  const sample = [
    {
      time: "08:30",
      country: "US",
      event: "Nonfarm Payrolls",
      actual: "210K",
      forecast: "185K",
      previous: "165K",
    },
    {
      time: "10:00",
      country: "US",
      event: "ISM Services PMI",
      actual: "52.4",
      forecast: "51.8",
      previous: "50.9",
    },
    {
      time: "14:00",
      country: "EU",
      event: "ECB Rate Decision",
      actual: "4.00%",
      forecast: "4.00%",
      previous: "4.00%",
    },
  ];

  sample.forEach((row) => {
    const tr = createEl("tr");
    tr.innerHTML = `<td>${row.time}</td><td>${row.country}</td><td>${row.event}</td><td>${row.actual}</td><td>${row.forecast}</td><td>${row.previous}</td>`;
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
}

// ------------------- Symbol switching -------------------

function setSymbol(symbol) {
  currentSymbol = symbol;
  renderChart(symbol);
  loadNews();
  loadInsights();
}

// ------------------- Init -------------------

async function init() {
  initThemeToggle();
  initMenu();
  initMacroMap();
  loadCalendar();

  renderChart(currentSymbol);
  loadNews();
  loadInsights();
  loadMovers();
  loadTickers();

  // refresh data every 60 seconds
  setInterval(loadTickers, 60000);
  setInterval(loadMovers, 60000);
  setInterval(loadNews, 120000);
  setInterval(loadInsights, 300000);
}

document.addEventListener("DOMContentLoaded", init);
