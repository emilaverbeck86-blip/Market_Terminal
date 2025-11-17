// ------------------------------------------------------------
// Basic helpers
// ------------------------------------------------------------

const state = {
  currentSymbol: "AAPL",
  currentTvSymbol: "AAPL",
  tvWidget: null,
  theme: "dark",
  tickerData: [],
};

function qs(sel) {
  return document.querySelector(sel);
}

function qsa(sel) {
  return Array.from(document.querySelectorAll(sel));
}

// ------------------------------------------------------------
// Theme handling
// ------------------------------------------------------------

function applyTheme(theme) {
  const html = document.documentElement;
  html.setAttribute("data-theme", theme);
  state.theme = theme;

  // TradingView theme
  if (state.tvWidget) {
    const tvTheme = theme === "dark" ? "dark" : "light";
    state.tvWidget.remove();
    initTradingView(state.currentTvSymbol, state.currentSymbol, tvTheme);
  }
}

function initThemeToggle() {
  const toggle = qs("#theme-toggle");
  if (!toggle) return;

  toggle.checked = state.theme === "dark";

  toggle.addEventListener("change", () => {
    const newTheme = toggle.checked ? "dark" : "light";
    applyTheme(newTheme);
  });
}

// ------------------------------------------------------------
// Menu dropdown (including theme switch location)
// ------------------------------------------------------------

function initMenu() {
  const btn = qs("#menu-button");
  const dropdown = qs("#menu-dropdown");
  if (!btn || !dropdown) return;

  btn.addEventListener("click", () => {
    dropdown.classList.toggle("hidden");
  });

  document.addEventListener("click", (e) => {
    if (!btn.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });

  // Shortcuts (SPY / QQQ)
  qsa(".menu-shortcut").forEach((el) => {
    el.addEventListener("click", () => {
      const tvSymbol = el.dataset.symbol;
      const label = el.dataset.label;
      state.currentSymbol = label;
      setSymbol(tvSymbol, label);
      dropdown.classList.add("hidden");
    });
  });

  // Tile visibility
  qsa(".menu-checkbox input[type=checkbox]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const tileId = checkbox.dataset.tile;
      const tile = document.getElementById(tileId);
      if (!tile) return;
      tile.style.display = checkbox.checked ? "flex" : "none";
    });
  });

  // Heatmap link
  const heatmapLink = qs("#heatmap-link");
  if (heatmapLink) {
    heatmapLink.addEventListener("click", () => {
      window.open(
        "https://www.tradingview.com/heatmap/stock/?index=SPX&color=change&label=change",
        "_blank"
      );
    });
  }
}

// ------------------------------------------------------------
// TradingView chart
// ------------------------------------------------------------

function initTradingView(tvSymbol, label, theme = "dark") {
  state.currentTvSymbol = tvSymbol;
  const container = "tv-chart";

  new TradingView.widget({
    autosize: true,
    symbol: tvSymbol,
    interval: "60",
    timezone: "Etc/UTC",
    theme: theme,
    style: "1",
    locale: "en",
    toolbar_bg: "#000000",
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_side_toolbar: false,
    container_id: container,
  });

  qs("#chart-title").textContent = `Chart – ${label}`;
}

// simple wrapper to reset widget
function setSymbol(tvSymbol, shortLabel) {
  state.currentSymbol = shortLabel;
  qs("#news-title").textContent = `News – ${shortLabel}`;
  qs("#insights-title").textContent = `Market Insights: ${shortLabel}`;

  // Re-create widget (TradingView doesn't expose symbol change easily)
  const tvContainer = qs("#tv-chart");
  tvContainer.innerHTML = "";
  initTradingView(tvSymbol, shortLabel, state.theme === "dark" ? "dark" : "light");

  loadNews(shortLabel);
  loadInsights(shortLabel);
}

// ------------------------------------------------------------
// Ticker bar + movers
// ------------------------------------------------------------

async function loadTickers() {
  try {
    const res = await fetch("/api/tickers");
    const data = await res.json();
    state.tickerData = data.tickers || [];
    renderTickerBar();
  } catch (err) {
    console.error("tickers error", err);
  }
}

function renderTickerBar() {
  const el = qs("#ticker-marquee");
  if (!el) return;
  el.innerHTML = "";

  if (!state.tickerData.length) {
    el.textContent = "No ticker data";
    return;
  }

  state.tickerData.forEach((t) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = t.symbol;

    const sym = document.createElement("span");
    sym.className = "ticker-symbol";
    sym.textContent = t.symbol;

    const price = document.createElement("span");
    price.className = "ticker-price";
    price.textContent =
      typeof t.price === "number" ? t.price.toFixed(2) : "—";

    const change = document.createElement("span");
    const pct = t.changePercent;
    if (typeof pct === "number") {
      change.textContent = `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
      change.className =
        pct > 0 ? "ticker-change-positive" : "ticker-change-negative";
    } else {
      change.textContent = "—";
    }

    item.appendChild(sym);
    item.appendChild(price);
    item.appendChild(change);

    item.addEventListener("click", () => {
      // TradingView uses plain symbol for US stocks
      state.currentSymbol = t.symbol;
      setSymbol(t.symbol, t.symbol);
    });

    el.appendChild(item);
  });
}

async function loadMovers() {
  try {
    const res = await fetch("/api/movers");
    const data = await res.json();
    renderMovers(data.gainers || [], data.losers || []);
  } catch (err) {
    console.error("movers error", err);
  }
}

function renderMovers(gainers, losers) {
  const gList = qs("#gainers-list");
  const lList = qs("#losers-list");
  if (!gList || !lList) return;
  gList.innerHTML = "";
  lList.innerHTML = "";

  if (!gainers.length && !losers.length) {
    gList.innerHTML = '<li class="mover-item">No data</li>';
    lList.innerHTML = '<li class="mover-item">No data</li>';
    return;
  }

  gainers.forEach((m) => {
    const li = document.createElement("li");
    li.className = "mover-item";
    li.innerHTML = `<span>${m.symbol}</span><span class="ticker-change-positive">${m.changePercent.toFixed(
      2
    )}%</span>`;
    gList.appendChild(li);
  });

  losers.forEach((m) => {
    const li = document.createElement("li");
    li.className = "mover-item";
    li.innerHTML = `<span>${m.symbol}</span><span class="ticker-change-negative">${m.changePercent.toFixed(
      2
    )}%</span>`;
    lList.appendChild(li);
  });
}

// ------------------------------------------------------------
// News
// ------------------------------------------------------------

async function loadNews(symbol) {
  const list = qs("#news-list");
  if (!list) return;
  list.innerHTML = '<div class="placeholder">Loading news…</div>';

  try {
    const res = await fetch(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    const items = data.items || [];

    if (!items.length) {
      list.innerHTML =
        '<div class="placeholder">No headlines available.</div>';
      return;
    }

    list.innerHTML = "";
    items.forEach((item) => {
      const el = document.createElement("div");
      el.className = "news-item";
      el.style.marginBottom = "6px";
      el.innerHTML = `
        <a href="${item.link}" target="_blank" class="news-title">${item.title}</a>
        <div class="news-meta">${item.source || "Source"} • ${
        item.published || ""
      }</div>
      `;
      list.appendChild(el);
    });
  } catch (err) {
    console.error("news error", err);
    list.innerHTML =
      '<div class="placeholder">Failed to load news.</div>';
  }
}

// ------------------------------------------------------------
// Insights
// ------------------------------------------------------------

async function loadInsights(symbol) {
  const grid = qs("#insights-grid");
  const desc = qs("#insights-description");
  if (!grid || !desc) return;

  grid.innerHTML = "";
  desc.textContent = "Loading performance snapshot…";

  try {
    const res = await fetch(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
    const data = await res.json();
    const changes = data.changes || {};

    const horizons = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
    horizons.forEach((h) => {
      const val = changes[h];
      const box = document.createElement("div");
      box.className = "insight-box";

      const label = document.createElement("div");
      label.className = "insight-label";
      label.textContent = h;

      const value = document.createElement("div");
      value.className = "insight-value";
      if (typeof val === "number") {
        value.textContent = `${val > 0 ? "+" : ""}${val.toFixed(2)}%`;
        value.style.color = val >= 0 ? "#21c67a" : "#ff4c4c";
      } else {
        value.textContent = "—";
        value.style.color = "#a0a4ad";
      }

      box.appendChild(label);
      box.appendChild(value);
      grid.appendChild(box);
    });

    desc.textContent = data.description || "No performance snapshot.";
  } catch (err) {
    console.error("insights error", err);
    desc.textContent = "Failed to load snapshot.";
  }
}

// ------------------------------------------------------------
// Economic calendar
// ------------------------------------------------------------

async function loadCalendar() {
  const body = qs("#calendar-body");
  if (!body) return;
  body.innerHTML = '<div class="placeholder">Loading calendar…</div>';

  try {
    const res = await fetch("/api/calendar");
    const data = await res.json();
    const events = data.events || [];

    if (!events.length) {
      body.innerHTML =
        '<div class="placeholder">No events available.</div>';
      return;
    }

    const table = document.createElement("table");
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th>
          <th>Country</th>
          <th>Event</th>
          <th>Actual</th>
          <th>Forecast</th>
          <th>Previous</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector("tbody");

    events.forEach((ev) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${ev.time || ""}</td>
        <td>${ev.country || ""}</td>
        <td>${ev.event || ""}</td>
        <td>${ev.actual || ""}</td>
        <td>${ev.forecast || ""}</td>
        <td>${ev.previous || ""}</td>
      `;
      tbody.appendChild(tr);
    });

    body.innerHTML = "";
    body.appendChild(table);
  } catch (err) {
    console.error("calendar error", err);
    body.innerHTML =
      '<div class="placeholder">Failed to load calendar.</div>';
  }
}

// ------------------------------------------------------------
// Macro map (simple D3 choropleth with sample data)
// ------------------------------------------------------------

function initMacroMap() {
  const container = qs("#macro-map");
  if (!container || !window.d3) return;

  const width = container.clientWidth || 400;
  const height = container.clientHeight || 220;

  const svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const projection = d3
    .geoMercator()
    .scale(width / 6.3)
    .translate([width / 2, height / 1.4]);
  const path = d3.geoPath().projection(projection);

  // Sample inflation data (%)
  const inflation = {
    US: 3.4,
    CA: 2.8,
    GB: 4.1,
    DE: 2.3,
    FR: 2.6,
    IT: 2.1,
    ES: 3.0,
    BR: 5.3,
    IN: 4.5,
    CN: 1.1,
    JP: 2.0,
    AU: 3.8,
  };

  const color = d3
    .scaleThreshold()
    .domain([1, 2, 4, 6, 8])
    .range(["#14141a", "#214f7a", "#2a7ab9", "#f5b400", "#e86b3a", "#ff4c4c"]);

  const tooltip = d3
    .select(container)
    .append("div")
    .style("position", "absolute")
    .style("pointer-events", "none")
    .style("background", "rgba(0,0,0,0.85)")
    .style("color", "#fff")
    .style("padding", "4px 6px")
    .style("border-radius", "4px")
    .style("font-size", "10px")
    .style("opacity", 0);

  d3.json("https://unpkg.com/world-atlas@2/countries-110m.json").then(
    (world) => {
      const countries = topojson.feature(world, world.objects.countries)
        .features;

      svg
        .selectAll("path.country")
        .data(countries)
        .enter()
        .append("path")
        .attr("class", "country")
        .attr("d", path)
        .attr("fill", (d) => {
          const iso3 = d.id; // numeric; we don't have mapping -> keep neutral
          return "#14141a";
        })
        .attr("stroke", "#20202a")
        .attr("stroke-width", 0.4)
        .on("mousemove", (event, d) => {
          const name = d.properties.name || "Country";
          // we only have sample inflation for a few ISO2 codes; show "n/a" for others
          const value = "n/a";
          tooltip
            .style("opacity", 1)
            .html(`${name}<br/>Inflation: ${value}`)
            .style("left", event.offsetX + 10 + "px")
            .style("top", event.offsetY + 10 + "px");
        })
        .on("mouseout", () => {
          tooltip.style("opacity", 0);
        });

      // Simple legend text
      const legend = qs("#macro-legend");
      if (legend) {
        legend.textContent =
          "Example macro map (inflation %). Hover over countries for info (data is illustrative).";
      }
    }
  );
}

// ------------------------------------------------------------
// Init
// ------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  initMenu();
  initThemeToggle();

  // Default dark
  applyTheme("dark");

  // Chart: start with AAPL
  initTradingView("AAPL", "AAPL", "dark");

  // Data
  loadTickers();
  loadMovers();
  loadNews("AAPL");
  loadInsights("AAPL");
  loadCalendar();
  initMacroMap();

  // Refresh tickers + movers every 60s
  setInterval(() => {
    loadTickers();
    loadMovers();
  }, 60000);
});
