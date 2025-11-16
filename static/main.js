// ---------- API ENDPOINTS ----------
const ENDPOINTS = {
  tickers: "/api/tickers",
  news: "/api/news",
  insights: "/api/insights",
  movers: "/api/movers",
  calendar: "/api/calendar",
  dom: "/api/dom"
};

// ---------- STATE ----------
let currentSymbol = "AAPL";
let currentCompanyName = "Apple Inc.";
let tickerNodes = new Map();

const layoutState = {
  colResize: null,
  rowResize: null
};

// ---------- DOM ----------
const tickerScroll = document.getElementById("tickerScroll");

const chartTitle = document.getElementById("chartTitle");
const tvContainer = document.getElementById("tv_container");

const newsList = document.getElementById("newsList");
const newsHeader = document.getElementById("newsHeader");

const insightsSymbol = document.getElementById("insightsSymbol");
const descEl = document.getElementById("companyDescription");
const insightEls = {
  "1w": document.getElementById("insight-1w"),
  "1m": document.getElementById("insight-1m"),
  "3m": document.getElementById("insight-3m"),
  "6m": document.getElementById("insight-6m"),
  ytd: document.getElementById("insight-ytd"),
  "1y": document.getElementById("insight-1y")
};

const domBody = document.getElementById("domBody");
const calendarBody = document.getElementById("calendarBody");
const gainersBody = document.getElementById("gainersBody");
const losersBody = document.getElementById("losersBody");

// tiles
const tiles = {
  chart: document.getElementById("tile-chart"),
  news: document.getElementById("tile-news"),
  insights: document.getElementById("tile-insights"),
  dom: document.getElementById("tile-dom"),
  calendar: document.getElementById("tile-calendar"),
  movers: document.getElementById("tile-movers")
};

// menu
const menuButton = document.getElementById("menuButton");
const menuDropdown = document.getElementById("menuDropdown");
const themeToggle = document.getElementById("themeToggle");

// ---------- UTIL ----------

function fmtPct(v) {
  if (v == null || !isFinite(v)) return "—";
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function classForChange(v) {
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}

// ---------- THEME ----------

function setTheme(theme) {
  const body = document.body;
  body.classList.remove("theme-dark", "theme-light");
  body.classList.add(theme === "light" ? "theme-light" : "theme-dark");
  localStorage.setItem("mt-theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem("mt-theme") || "dark";
  setTheme(saved);

  themeToggle.addEventListener("click", () => {
    const current = document.body.classList.contains("theme-light")
      ? "light"
      : "dark";
    setTheme(current === "light" ? "dark" : "light");
  });
}

// ---------- MENU / TILE TOGGLE ----------

function initMenu() {
  menuButton.addEventListener("click", (e) => {
    e.stopPropagation();
    menuDropdown.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menuDropdown.contains(e.target) && e.target !== menuButton) {
      menuDropdown.classList.remove("open");
    }
  });

  // shortcuts
  menuDropdown
    .querySelectorAll(".menu-shortcut")
    .forEach((btn) =>
      btn.addEventListener("click", () => {
        const symbol = btn.dataset.symbol;
        if (symbol) selectSymbol(symbol);
        menuDropdown.classList.remove("open");
      })
    );

  // tile checkboxes
  menuDropdown
    .querySelectorAll("input[data-tile-toggle]")
    .forEach((cb) => {
      const id = cb.dataset.tileToggle;
      cb.addEventListener("change", () => {
        const tile = tiles[id];
        if (!tile) return;
        tile.classList.toggle("hidden", !cb.checked);
        refreshRowLayouts();
      });
    });

  // tile close buttons
  document.querySelectorAll(".tile-close").forEach((btn) => {
    const id = btn.dataset.close;
    btn.addEventListener("click", () => {
      const tile = tiles[id];
      if (!tile) return;
      tile.classList.add("hidden");
      const menuCb = menuDropdown.querySelector(
        `input[data-tile-toggle="${id}"]`
      );
      if (menuCb) menuCb.checked = false;
      refreshRowLayouts();
    });
  });
}

// ---------- ROW / COL LAYOUT ----------

function refreshRowLayouts() {
  ["row1", "row2", "row3"].forEach((rowId) => {
    const row = document.getElementById(rowId);
    if (!row) return;
    const [leftTile, colResizer, rightTile] = row.children;
    const leftHidden = leftTile.classList.contains("hidden");
    const rightHidden = rightTile.classList.contains("hidden");

    if (leftHidden && rightHidden) {
      row.style.display = "none";
      if (colResizer) colResizer.style.display = "none";
      return;
    }

    row.style.display = "flex";

    if (leftHidden || rightHidden) {
      if (leftHidden) {
        rightTile.style.flex = "1 1 auto";
        leftTile.style.flex = "0 0 auto";
      } else {
        leftTile.style.flex = "1 1 auto";
        rightTile.style.flex = "0 0 auto";
      }
      if (colResizer) colResizer.style.display = "none";
    } else {
      leftTile.style.flex = "";
      rightTile.style.flex = "";
      if (colResizer) colResizer.style.display = "";
    }
  });
}

// ---------- RESIZE (COLUMNS) ----------

function startColResize(e, rowIndex) {
  const row = document.getElementById(`row${rowIndex}`);
  const [leftTile, resizer, rightTile] = row.children;
  if (leftTile.classList.contains("hidden") || rightTile.classList.contains("hidden")) {
    return;
  }

  const rect = row.getBoundingClientRect();
  layoutState.colResize = {
    rowIndex,
    startX: e.clientX,
    rowWidth: rect.width,
    leftWidth: leftTile.getBoundingClientRect().width,
    rightWidth: rightTile.getBoundingClientRect().width
  };
  resizer.classList.add("active");
  document.body.classList.add("resizing");
}

function moveColResize(e) {
  const state = layoutState.colResize;
  if (!state) return;

  const row = document.getElementById(`row${state.rowIndex}`);
  const [leftTile, resizer, rightTile] = row.children;

  const dx = e.clientX - state.startX;
  const min = 180;
  let newLeft = state.leftWidth + dx;
  let newRight = state.rightWidth - dx;
  if (newLeft < min) {
    newLeft = min;
    newRight = state.rowWidth - min - resizer.offsetWidth;
  }
  if (newRight < min) {
    newRight = min;
    newLeft = state.rowWidth - min - resizer.offsetWidth;
  }

  leftTile.style.flex = `0 0 ${newLeft}px`;
  rightTile.style.flex = `0 0 ${newRight}px`;
}

function stopColResize() {
  const state = layoutState.colResize;
  if (!state) return;
  const row = document.getElementById(`row${state.rowIndex}`);
  const [, resizer] = row.children;
  resizer.classList.remove("active");
  layoutState.colResize = null;
  document.body.classList.remove("resizing");
}

// ---------- RESIZE (ROWS) ----------

function getRowHeights() {
  return ["row1", "row2", "row3"].map((id) => {
    const row = document.getElementById(id);
    return row ? row.getBoundingClientRect().height : 0;
  });
}

function startRowResize(e, rowIndex) {
  const layout = document.getElementById("layout");
  const rect = layout.getBoundingClientRect();
  layoutState.rowResize = {
    startY: e.clientY,
    rowIndex,
    totalHeight: rect.height,
    heights: getRowHeights()
  };
  const bar = document.querySelector(`.row-resizer[data-row="${rowIndex}"]`);
  if (bar) bar.classList.add("active");
  document.body.classList.add("resizing");
}

function moveRowResize(e) {
  const state = layoutState.rowResize;
  if (!state) return;

  const dy = e.clientY - state.startY;
  const min = 100;

  const h1 = state.heights[0];
  const h2 = state.heights[1];
  const h3 = state.heights[2];

  let newHeights = [h1, h2, h3];

  if (state.rowIndex === 1) {
    let new1 = h1 + dy;
    let new2 = h2 - dy;
    new1 = Math.max(min, new1);
    new2 = Math.max(min, new2);
    newHeights = [new1, new2, h3];
  } else if (state.rowIndex === 2) {
    let new2 = h2 + dy;
    let new3 = h3 - dy;
    new2 = Math.max(min, new2);
    new3 = Math.max(min, new3);
    newHeights = [h1, new2, new3];
  }

  ["row1", "row2", "row3"].forEach((id, idx) => {
    const row = document.getElementById(id);
    if (row) row.style.height = `${newHeights[idx]}px`;
  });
}

function stopRowResize() {
  const state = layoutState.rowResize;
  if (!state) return;
  const bar = document.querySelector(`.row-resizer[data-row="${state.rowIndex}"]`);
  if (bar) bar.classList.remove("active");
  layoutState.rowResize = null;
  document.body.classList.remove("resizing");
}

// ---------- TICKERS ----------

function buildTickerRow(items) {
  tickerScroll.innerHTML = "";
  tickerNodes.clear();
  const dup = [...items, ...items];
  dup.forEach((tk) => {
    const item = document.createElement("div");
    item.className = "ticker-item";
    item.dataset.symbol = tk.symbol;

    const sym = document.createElement("span");
    sym.className = "sym";
    sym.textContent = tk.symbol;

    const chg = document.createElement("span");
    chg.className = `chg ${classForChange(tk.change_pct)}`;
    chg.textContent = fmtPct(tk.change_pct);

    item.appendChild(sym);
    item.appendChild(chg);
    item.addEventListener("click", () => selectSymbol(tk.symbol));
    tickerScroll.appendChild(item);
    tickerNodes.set(tk.symbol, { node: item, chg });
  });

  // pause on hover
  tickerScroll.addEventListener("mouseenter", () =>
    tickerScroll.classList.add("paused")
  );
  tickerScroll.addEventListener("mouseleave", () =>
    tickerScroll.classList.remove("paused")
  );
}

function updateTickerRow(items) {
  items.forEach((tk) => {
    const entry = tickerNodes.get(tk.symbol);
    if (!entry) return;
    entry.chg.className = `chg ${classForChange(tk.change_pct)}`;
    entry.chg.textContent = fmtPct(tk.change_pct);
  });
}

async function loadTickers() {
  try {
    const res = await fetch(ENDPOINTS.tickers);
    if (!res.ok) throw new Error("tickers");
    const data = await res.json();
    if (!tickerScroll.childElementCount) {
      buildTickerRow(data);
    } else {
      updateTickerRow(data);
    }
  } catch (e) {
    // silent
  }
}

// ---------- TRADINGVIEW CHART ----------

function mountTradingView(symbol) {
  chartTitle.textContent = symbol;
  tvContainer.innerHTML = "";

  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const d = document.createElement("div");
    d.className = "muted";
    d.textContent = "TradingView widget failed to load.";
    tvContainer.appendChild(d);
    return;
  }

  new TradingView.widget({
    symbol,
    interval: "60",
    theme: document.body.classList.contains("theme-light") ? "light" : "dark",
    container_id: "tv_container",
    style: "1",
    locale: "en",
    hide_top_toolbar: false,
    autosize: true
  });
}

// ---------- NEWS ----------

function renderNews(list) {
  newsList.innerHTML = "";
  if (!Array.isArray(list) || !list.length) {
    newsList.innerHTML = '<div class="muted">No headlines.</div>';
    return;
  }
  list.forEach((n) => {
    const item = document.createElement("div");
    item.className = "news-item";
    const a = document.createElement("a");
    a.href = n.url || "#";
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = n.title || "(untitled)";
    const meta = document.createElement("div");
    meta.className = "news-meta";
    meta.textContent = `${n.source || "Source"} · ${n.time || ""}`;
    item.appendChild(a);
    item.appendChild(meta);
    newsList.appendChild(item);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML = '<div class="muted">Loading news…</div>';
  newsHeader.textContent = `News – ${symbol}`;
  try {
    const res = await fetch(
      `${ENDPOINTS.news}?symbol=${encodeURIComponent(symbol)}`
    );
    const data = await res.json();
    renderNews(data);
  } catch (e) {
    newsList.innerHTML =
      '<div class="muted">Could not load news. Using fallback…</div>';
  }
}

// ---------- INSIGHTS ----------

function setInsight(id, val) {
  const el = insightEls[id];
  if (!el) return;
  if (val == null || !isFinite(val)) {
    el.textContent = "—";
    el.className = "insight-value";
    return;
  }
  el.textContent = fmtPct(val);
  el.className = `insight-value ${classForChange(val)}`;
}

async function loadInsights(symbol) {
  insightsSymbol.textContent = symbol;
  descEl.textContent = "Loading profile…";
  Object.keys(insightEls).forEach((k) => setInsight(k, null));

  try {
    const res = await fetch(
      `${ENDPOINTS.insights}?symbol=${encodeURIComponent(symbol)}`
    );
    if (!res.ok) throw new Error("insights");
    const data = await res.json();

    setInsight("1w", data.pct_1w);
    setInsight("1m", data.pct_1m);
    setInsight("3m", data.pct_3m);
    setInsight("6m", data.pct_6m);
    setInsight("ytd", data.pct_ytd);
    setInsight("1y", data.pct_1y);

    descEl.textContent = data.profile || "No profile available.";
  } catch (e) {
    descEl.textContent = "No profile available.";
  }
}

// ---------- DOM (simulated) ----------

async function loadDom(symbol) {
  domBody.innerHTML = "";
  try {
    const res = await fetch(
      `${ENDPOINTS.dom}?symbol=${encodeURIComponent(symbol)}`
    );
    const data = await res.json();
    const rows = data.levels || [];
    if (!rows.length) {
      domBody.innerHTML =
        '<tr><td colspan="4" class="muted">No depth data.</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${r.bid_size}</td><td>${r.bid}</td><td>${r.ask}</td><td>${r.ask_size}</td>`;
      domBody.appendChild(tr);
    });
  } catch (e) {
    domBody.innerHTML =
      '<tr><td colspan="4" class="muted">Depth data unavailable.</td></tr>';
  }
}

// ---------- MOVERS ----------

async function loadMovers() {
  gainersBody.innerHTML = "";
  losersBody.innerHTML = "";
  try {
    const res = await fetch(ENDPOINTS.movers);
    const data = await res.json();
    const gainers = data.gainers || [];
    const losers = data.losers || [];

    if (!gainers.length) {
      gainersBody.innerHTML =
        '<tr><td colspan="2" class="muted">No data</td></tr>';
    } else {
      gainers.forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${row.symbol}</td><td class="change ${classForChange(
          row.change_pct
        )}">${fmtPct(row.change_pct)}</td>`;
        tr.addEventListener("click", () => selectSymbol(row.symbol));
        gainersBody.appendChild(tr);
      });
    }

    if (!losers.length) {
      losersBody.innerHTML =
        '<tr><td colspan="2" class="muted">No data</td></tr>';
    } else {
      losers.forEach((row) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${row.symbol}</td><td class="change ${classForChange(
          row.change_pct
        )}">${fmtPct(row.change_pct)}</td>`;
        tr.addEventListener("click", () => selectSymbol(row.symbol));
        losersBody.appendChild(tr);
      });
    }
  } catch (e) {
    gainersBody.innerHTML =
      '<tr><td colspan="2" class="muted">Failed</td></tr>';
    losersBody.innerHTML =
      '<tr><td colspan="2" class="muted">Failed</td></tr>';
  }
}

// ---------- CALENDAR ----------

function renderCalendar(rows) {
  calendarBody.innerHTML = "";
  const header = document.createElement("div");
  header.className = "calendar-row header";
  header.innerHTML =
    "<div>Time</div><div>Country</div><div>Event</div><div>Actual</div><div>Forecast</div><div>Previous</div>";
  calendarBody.appendChild(header);

  if (!Array.isArray(rows) || !rows.length) {
    const d = document.createElement("div");
    d.className = "muted";
    d.style.marginTop = "6px";
    d.textContent = "No events.";
    calendarBody.appendChild(d);
    return;
  }

  rows.forEach((ev) => {
    const row = document.createElement("div");
    row.className = "calendar-row";
    row.innerHTML = `
      <div>${ev.time || ""}</div>
      <div>${ev.country || ""}</div>
      <div>${ev.event || ""}</div>
      <div>${ev.actual ?? ""}</div>
      <div>${ev.forecast ?? ""}</div>
      <div>${ev.previous ?? ""}</div>
    `;
    calendarBody.appendChild(row);
  });
}

async function loadCalendar() {
  calendarBody.innerHTML = '<div class="muted">Loading calendar…</div>';
  try {
    const res = await fetch(ENDPOINTS.calendar);
    const data = await res.json();
    renderCalendar(data);
  } catch (e) {
    calendarBody.innerHTML =
      '<div class="muted">Calendar data unavailable.</div>';
  }
}

// ---------- SELECT SYMBOL ----------

async function selectSymbol(symbol) {
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([
    loadNews(symbol),
    loadInsights(symbol),
    loadDom(symbol)
  ]);
}

// ---------- INIT RESIZERS ----------

function initResizers() {
  document
    .querySelectorAll(".col-resizer")
    .forEach((res) =>
      res.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const rowIndex = Number(res.dataset.row);
        startColResize(e, rowIndex);
      })
    );

  document
    .querySelectorAll(".row-resizer")
    .forEach((res) =>
      res.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const rowIndex = Number(res.dataset.row);
        startRowResize(e, rowIndex);
      })
    );

  window.addEventListener("mousemove", (e) => {
    if (layoutState.colResize) moveColResize(e);
    if (layoutState.rowResize) moveRowResize(e);
  });

  window.addEventListener("mouseup", () => {
    if (layoutState.colResize) stopColResize();
    if (layoutState.rowResize) stopRowResize();
  });
}

// ---------- BOOT ----------

async function boot() {
  initTheme();
  initMenu();
  initResizers();
  refreshRowLayouts();

  // initial symbol
  selectSymbol(currentSymbol);
  loadTickers();
  loadMovers();
  loadCalendar();

  setInterval(loadTickers, 15000);
  setInterval(loadMovers, 60000);
  setInterval(loadCalendar, 60 * 60 * 1000);
}

document.addEventListener("DOMContentLoaded", boot);
