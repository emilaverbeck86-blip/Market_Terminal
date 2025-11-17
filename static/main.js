(() => {
  const API_BASE = "";

  let currentSymbol = "AAPL";
  let currentTheme = "dark";
  let tvWidget = null;

  document.addEventListener("DOMContentLoaded", () => {
    const body = document.body;

    // ----- theme -----
    const savedTheme = localStorage.getItem("mt-theme");
    if (savedTheme === "light") {
      body.classList.remove("theme-dark");
      body.classList.add("theme-light");
      currentTheme = "light";
    }

    const themeToggle = document.getElementById("theme-toggle");
    if (themeToggle) {
      themeToggle.checked = currentTheme === "light";
      themeToggle.addEventListener("change", () => {
        if (themeToggle.checked) {
          body.classList.remove("theme-dark");
          body.classList.add("theme-light");
          currentTheme = "light";
        } else {
          body.classList.remove("theme-light");
          body.classList.add("theme-dark");
          currentTheme = "dark";
        }
        localStorage.setItem("mt-theme", currentTheme);
        renderChart(currentSymbol); // re-create chart with theme
      });
    }

    // ----- menu -----
    const menuToggle = document.getElementById("menu-toggle");
    const menuPanel = document.getElementById("menu-panel");

    if (menuToggle && menuPanel) {
      menuToggle.addEventListener("click", () => {
        menuPanel.classList.toggle("open");
      });

      document.addEventListener("click", (e) => {
        if (!menuPanel.contains(e.target) && !menuToggle.contains(e.target)) {
          menuPanel.classList.remove("open");
        }
      });
    }

    // tile show / hide via menu
    document.querySelectorAll(".tile-checkbox").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-tile");
        const tile = document.getElementById(`tile-${id}`);
        if (!tile) return;
        tile.style.display = cb.checked ? "flex" : "none";
      });
    });

    // close button on tile
    document.querySelectorAll(".tile-close").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tileKey = btn.getAttribute("data-tile");
        const tile = document.getElementById(`tile-${tileKey}`);
        const cb = document.querySelector(
          `.tile-checkbox[data-tile="${tileKey}"]`
        );
        if (tile) tile.style.display = "none";
        if (cb) cb.checked = false;
      });
    });

    // shortcuts (S&P / NASDAQ)
    document.querySelectorAll(".shortcut-btn[data-symbol]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sym = btn.getAttribute("data-symbol");
        if (sym) {
          setSymbol(sym);
          if (menuPanel) menuPanel.classList.remove("open");
        }
      });
    });

    // heatmap link
    const heatmapLink = document.getElementById("heatmap-link");
    if (heatmapLink) {
      heatmapLink.addEventListener("click", () => {
        window.location.href = "/heatmap";
      });
    }

    // ticker bar hover pause
    const tickerBar = document.getElementById("ticker-bar");
    if (tickerBar) {
      tickerBar.addEventListener("mouseenter", () => {
        tickerBar.classList.add("paused");
      });
      tickerBar.addEventListener("mouseleave", () => {
        tickerBar.classList.remove("paused");
      });
    }

    // row & column resizers
    initRowResizers();
    initColResizers();

    // initial loads
    renderChart(currentSymbol);
    loadTickers();
    loadNews(currentSymbol);
    loadInsights(currentSymbol);
    loadMovers();

    // refresh tickers/movers every 2 minutes (gentle)
    setInterval(() => {
      loadTickers();
      loadMovers();
    }, 120000);
  });

  // ---------- Utility ----------

  async function fetchJSON(path) {
    const res = await fetch(API_BASE + path);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function formatPrice(val) {
    if (val == null) return "—";
    return Number(val).toFixed(2);
  }

  function formatChangePct(val) {
    if (val == null) return "—";
    const num = Number(val);
    const sign = num > 0 ? "+" : "";
    return `${sign}${num.toFixed(2)}%`;
  }

  function setSymbol(symbol) {
    currentSymbol = symbol;
    const base = symbol.split(":").pop() || symbol;
    const chartTitle = document.getElementById("chart-title");
    if (chartTitle) chartTitle.textContent = `Chart – ${base}`;
    const newsSym = document.getElementById("news-symbol");
    if (newsSym) newsSym.textContent = base;
    const insSym = document.getElementById("insights-symbol");
    if (insSym) insSym.textContent = base;

    renderChart(symbol);
    loadNews(symbol);
    loadInsights(symbol);
  }

  // ---------- TradingView chart ----------

  function renderChart(symbol) {
    const container = document.getElementById("tv-chart");
    if (!container || typeof TradingView === "undefined") return;

    container.innerHTML = ""; // clear previous instance

    const theme = currentTheme === "light" ? "light" : "dark";

    tvWidget = new TradingView.widget({
      autosize: true,
      symbol: symbol,
      interval: "60",
      timezone: "Etc/UTC",
      theme: theme,
      style: "1",
      locale: "en",
      toolbar_bg: "rgba(0, 0, 0, 0)",
      enable_publishing: false,
      allow_symbol_change: true,
      container_id: "tv-chart",
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      studies: [],
    });
  }

  // ---------- Tickers + ticker bar ----------

  async function loadTickers() {
    try {
      const data = await fetchJSON("/api/tickers");
      const items = data.tickers || [];
      const track = document.getElementById("ticker-track");
      if (!track) return;

      track.innerHTML = "";

      const all = [...items, ...items]; // duplicate for smooth scroll

      all.forEach((item) => {
        const sym = item.symbol;
        const price = formatPrice(item.price);
        const changePct = item.change_pct;
        const changeStr = formatChangePct(changePct);

        const el = document.createElement("div");
        el.className = "ticker-item";
        el.dataset.symbol = sym;

        const symSpan = document.createElement("span");
        symSpan.className = "ticker-symbol";
        symSpan.textContent = sym;

        const priceSpan = document.createElement("span");
        priceSpan.className = "ticker-price";
        priceSpan.textContent = price;

        const changeSpan = document.createElement("span");
        changeSpan.className = "ticker-change";
        if (changePct != null) {
          if (changePct > 0) changeSpan.classList.add("positive");
          if (changePct < 0) changeSpan.classList.add("negative");
        }
        changeSpan.textContent = changeStr;

        el.appendChild(symSpan);
        el.appendChild(priceSpan);
        el.appendChild(changeSpan);

        el.addEventListener("click", () => setSymbol(sym));

        track.appendChild(el);
      });
    } catch (err) {
      console.error("tickers error", err);
    }
  }

  // ---------- News ----------

  async function loadNews(symbol) {
    try {
      const data = await fetchJSON(`/api/news?symbol=${encodeURIComponent(symbol)}`);
      const list = document.getElementById("news-list");
      if (!list) return;

      const items = data.news || [];
      list.innerHTML = "";

      if (!items.length) {
        const div = document.createElement("div");
        div.className = "placeholder";
        div.textContent = "No headlines.";
        list.appendChild(div);
        return;
      }

      items.forEach((n) => {
        const item = document.createElement("div");
        item.className = "news-item";

        const title = document.createElement("div");
        title.className = "news-item-title";

        const link = document.createElement("a");
        link.href = n.link;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = n.title || "Untitled";

        title.appendChild(link);

        const meta = document.createElement("div");
        meta.className = "news-item-meta";
        meta.textContent = n.source || "";

        item.appendChild(title);
        item.appendChild(meta);
        list.appendChild(item);
      });
    } catch (err) {
      console.error("news error", err);
      const list = document.getElementById("news-list");
      if (list) {
        list.innerHTML = "";
        const div = document.createElement("div");
        div.className = "placeholder";
        div.textContent = "Failed to load news.";
        list.appendChild(div);
      }
    }
  }

  // ---------- Insights ----------

  async function loadInsights(symbol) {
    try {
      const data = await fetchJSON(`/api/insights?symbol=${encodeURIComponent(symbol)}`);
      const perf = data.performance || {};
      const ranges = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
      let any = false;

      ranges.forEach((r) => {
        const el = document.getElementById(`insight-${r}`);
        if (!el) return;
        const val = perf[r];
        if (val == null) {
          el.textContent = "—";
          el.classList.remove("positive", "negative");
        } else {
          any = true;
          el.textContent = `${val > 0 ? "+" : ""}${val.toFixed(2)}%`;
          el.classList.remove("positive", "negative");
          if (val > 0) el.classList.add("positive");
          if (val < 0) el.classList.add("negative");
        }
      });

      const note = document.getElementById("insights-note");
      if (note) {
        note.textContent = any
          ? "Performance snapshot based on Yahoo Finance historical data."
          : "No performance snapshot.";
      }
    } catch (err) {
      console.error("insights error", err);
    }
  }

  // ---------- Movers ----------

  async function loadMovers() {
    try {
      const data = await fetchJSON("/api/movers");
      const gainers = data.gainers || [];
      const losers = data.losers || [];

      const gList = document.getElementById("gainers-list");
      const lList = document.getElementById("losers-list");
      if (!gList || !lList) return;

      gList.innerHTML = "";
      lList.innerHTML = "";

      if (!gainers.length && !losers.length) {
        const li = document.createElement("li");
        li.className = "placeholder";
        li.textContent = "No data.";
        gList.appendChild(li.cloneNode(true));
        lList.appendChild(li);
        return;
      }

      gainers.forEach((g) => {
        const li = document.createElement("li");
        li.className = "movers-item";
        const s = document.createElement("span");
        s.className = "movers-symbol";
        s.textContent = g.symbol;
        const c = document.createElement("span");
        c.className = "movers-change positive";
        c.textContent = formatChangePct(g.change_pct);
        li.appendChild(s);
        li.appendChild(c);
        gList.appendChild(li);
      });

      losers.forEach((g) => {
        const li = document.createElement("li");
        li.className = "movers-item";
        const s = document.createElement("span");
        s.className = "movers-symbol";
        s.textContent = g.symbol;
        const c = document.createElement("span");
        c.className = "movers-change negative";
        c.textContent = formatChangePct(g.change_pct);
        li.appendChild(s);
        li.appendChild(c);
        lList.appendChild(li);
      });
    } catch (err) {
      console.error("movers error", err);
    }
  }

  // ---------- Resizers ----------

  function initRowResizers() {
    const resizers = document.querySelectorAll(".row-resizer");
    resizers.forEach((rz) => {
      let dragging = false;
      let startY = 0;
      let prevRow, nextRow, prevH, nextH;

      rz.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const rowIndex = parseInt(rz.getAttribute("data-row"), 10);
        const rows = document.querySelectorAll(".row");
        prevRow = rows[rowIndex - 1];
        nextRow = rows[rowIndex];
        if (!prevRow || !nextRow) return;
        dragging = true;
        startY = e.clientY;
        prevH = prevRow.offsetHeight;
        nextH = nextRow.offsetHeight;
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dy = e.clientY - startY;
        const newPrev = Math.max(120, prevH + dy);
        const newNext = Math.max(140, nextH - dy);
        prevRow.style.height = `${newPrev}px`;
        nextRow.style.height = `${newNext}px`;
      });

      window.addEventListener("mouseup", () => {
        dragging = false;
        document.body.style.userSelect = "";
      });
    });
  }

  function initColResizers() {
    const resizers = document.querySelectorAll(".col-resizer");
    resizers.forEach((rz) => {
      let dragging = false;
      let startX = 0;
      let leftTile, rightTile, totalWidth, leftStart;

      rz.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const row = rz.closest(".row");
        if (!row) return;
        const tiles = row.querySelectorAll(".tile");
        if (tiles.length !== 2) return;
        leftTile = tiles[0];
        rightTile = tiles[1];
        totalWidth = row.clientWidth - rz.offsetWidth;
        leftStart = leftTile.clientWidth;
        dragging = true;
        startX = e.clientX;
        document.body.style.userSelect = "none";
      });

      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        let newLeft = leftStart + dx;
        const min = 220;
        const max = totalWidth - min;
        newLeft = Math.max(min, Math.min(max, newLeft));
        const leftPct = (newLeft / totalWidth) * 100;
        const rightPct = 100 - leftPct;
        leftTile.style.flex = `0 0 ${leftPct}%`;
        rightTile.style.flex = `0 0 ${rightPct}%`;
      });

      window.addEventListener("mouseup", () => {
        dragging = false;
        document.body.style.userSelect = "";
      });
    });
  }
})();
