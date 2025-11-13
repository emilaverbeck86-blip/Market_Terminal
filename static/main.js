// ---------------- API endpoints ----------------
const API = {
  tickers: '/api/tickers',
  movers: '/api/movers',
  metrics: '/api/metrics',
  news: '/api/news',
  mktnews: '/api/market-news',
};

const $ = id => document.getElementById(id);

// DOM
const tickerWrap = $('tickerWrap');
const tickerTrack = $('tickerTrack');
const tvContainer = $('tv_container');
const chartTitle = $('chartTitle');
const perfGrid = $('perfGrid');
const coDesc = $('coDesc');
const insightsTitle = $('insightsTitle');
const newsList = $('newsList');
const marketNewsList = $('marketNewsList');
const gainersBody = $('gainersBody');
const losersBody = $('losersBody');
const board = $('board');
const themeToggle = $('themeToggle');
const settingsBtn = $('settingsBtn');
const settingsMenu = $('settingsMenu');
const spxBtn = $('btnSPX');
const ndxBtn = $('btnNasdaq');

let currentSymbol = null;
let tvOverride = null;

// ---------------- helpers ----------------
function fetchJSON(url, { params, timeout = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  const full = params ? `${url}?${new URLSearchParams(params)}` : url;
  return fetch(full, { signal: controller.signal })
    .then(r => {
      if (!r.ok) throw new Error(r.status);
      return r.json();
    })
    .finally(() => clearTimeout(t));
}
const fmt = v => (v == null || !isFinite(v) ? '—' : v.toFixed(2));
const fmtPct = v =>
  v == null || !isFinite(v)
    ? '—'
    : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;
const clsFor = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu');

// ---------------- settings / theme / tile toggles ----------------
(() => {
  let open = false;
  const close = () => {
    settingsMenu.classList.remove('open');
    open = false;
  };
  settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    open = !open;
    settingsMenu.classList.toggle('open', open);
  });
  document.addEventListener('click', e => {
    if (open && !settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      close();
    }
  });

  // theme
  const saved = localStorage.getItem('mt_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  themeToggle.checked = saved === 'light';
  themeToggle.addEventListener('change', () => {
    const t = themeToggle.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mt_theme', t);
    if (currentSymbol) mountTV(currentSymbol, tvOverride);
  });

  // tile visibility
  const vis = JSON.parse(localStorage.getItem('mt_tiles') || '{}');
  document.querySelectorAll('.tile-toggle').forEach(chk => {
    if (vis.hasOwnProperty(chk.dataset.target)) chk.checked = !!vis[chk.dataset.target];
    const el = $(chk.dataset.target);
    if (el) el.style.display = chk.checked ? '' : 'none';

    chk.addEventListener('change', () => {
      const conf = {};
      document.querySelectorAll('.tile-toggle').forEach(c => {
        conf[c.dataset.target] = c.checked;
      });
      localStorage.setItem('mt_tiles', JSON.stringify(conf));
      const el2 = $(chk.dataset.target);
      if (el2) el2.style.display = chk.checked ? '' : 'none';
      reflowBoard();
      saveLayout();
    });
  });

  // dash button in each card header
  document.querySelectorAll('.min-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.hide;
      const card = $(id);
      if (card) card.style.display = 'none';
      const chk = document.querySelector(`.tile-toggle[data-target="${id}"]`);
      if (chk) chk.checked = false;
      const conf = {};
      document.querySelectorAll('.tile-toggle').forEach(c => {
        conf[c.dataset.target] = c.checked;
      });
      localStorage.setItem('mt_tiles', JSON.stringify(conf));
      reflowBoard();
      saveLayout();
    });
  });
})();

// ---------------- quick shortcuts ----------------
spxBtn.addEventListener('click', () => onSelect('SPY', 'CAPITALCOM:US500'));
ndxBtn.addEventListener('click', () => onSelect('QQQ', 'OANDA:NAS100USD'));

// ---------------- layout: two lanes, left flexible, right locked ----------------
const LAYOUT_KEY = 'mt_layout_v2';
let lanePct = 60; // % width of left lane

function setLaneWidths(pct) {
  lanePct = Math.max(30, Math.min(85, pct || 60));
  const leftW = `${lanePct}%`;
  const rightW = `${100 - lanePct - 2}%`;
  document.querySelectorAll('.lane-left').forEach(n => (n.style.width = leftW));
  document.querySelectorAll('.lane-right').forEach(n => (n.style.width = rightW));
}

function reflowBoard() {
  setLaneWidths(lanePct);
}

function saveLayout() {
  const lanes = [...board.children]
    .filter(n => n.classList && n.classList.contains('movable'))
    .map(n => ({
      id: n.id,
      lane: n.classList.contains('lane-right') ? 'right' : 'left',
      h: n.style.height || '',
    }));
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ pct: lanePct, lanes }));
}

function restoreLayout() {
  try {
    const st = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    if (st.lanes && Array.isArray(st.lanes)) {
      st.lanes.forEach(cfg => {
        const el = $(cfg.id);
        if (!el) return;
        el.classList.toggle('lane-right', cfg.lane === 'right');
        el.classList.toggle('lane-left', cfg.lane !== 'right');
        if (cfg.h) el.style.height = cfg.h;
        board.appendChild(el);
      });
    }
    if (typeof st.pct === 'number') lanePct = st.pct;
  } catch (e) {
    // ignore
  }
  setLaneWidths(lanePct);
}

// drag to move cards
(() => {
  let dragging = null;
  let placeholder = null;

  board.addEventListener('dragstart', e => {
    const hd = e.target.closest('.card-hd');
    if (!hd) {
      e.preventDefault();
      return;
    }
    dragging = hd.parentElement;
    dragging.classList.add('dragging');

    placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    const r = getComputedStyle(dragging);
    placeholder.style.height = r.height;
    dragging.after(placeholder);
  });

  board.addEventListener('dragover', e => {
    if (!dragging) return;
    e.preventDefault();
    const rect = board.getBoundingClientRect();
    const mid = (rect.left + rect.right) / 2;
    const lane = e.clientX > mid ? 'lane-right' : 'lane-left';

    dragging.classList.toggle('lane-right', lane === 'lane-right');
    dragging.classList.toggle('lane-left', lane !== 'lane-right');

    const siblings = [...board.querySelectorAll(`.${lane}.movable:not(.dragging)`)];
    let target = null;
    let best = 1e9;
    siblings.forEach(n => {
      const r = n.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.bottom) / 2);
      if (d < best) {
        best = d;
        target = n;
      }
    });
    if (target) target.after(placeholder);
    else board.appendChild(placeholder);
  });

  function endDrag() {
    if (!dragging) return;
    placeholder.replaceWith(dragging);
    dragging.classList.remove('dragging');
    dragging = null;
    placeholder = null;
    reflowBoard();
    saveLayout();
  }

  board.addEventListener('drop', endDrag);
  board.addEventListener('dragend', endDrag);
})();

// resize cards: left lane controls lane width, right lane only height
(() => {
  const MIN_W = 300;
  const MIN_H = 220;

  board.querySelectorAll('.card.resizable .resize-handle').forEach(handle => {
    const card = handle.closest('.card');
    let startW = 0,
      startH = 0,
      sx = 0,
      sy = 0;

    const move = e => {
      const br = board.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const lane = card.classList.contains('lane-right') ? 'right' : 'left';

      let nw = startW + (e.clientX - sx);
      let nh = startH + (e.clientY - sy);

      const maxW = br.width - 16;
      const maxH = window.innerHeight - cr.top - 24;

      nh = Math.max(MIN_H, Math.min(maxH, nh));

      if (lane === 'left') {
        nw = Math.max(MIN_W, Math.min(maxW, nw));
        const pct = (nw / br.width) * 100;
        setLaneWidths(pct);
      } else {
        nw = startW; // right lane width locked
      }

      card.style.height = nh + 'px';

      const laneClass = lane === 'right' ? 'lane-right' : 'lane-left';
      const nbrs = [...board.querySelectorAll(`.${laneClass}.movable`)].filter(
        n => n !== card,
      );
      const cardTop = cr.top;
      let best = null;
      let delta = 12;
      nbrs.forEach(n => {
        const r = n.getBoundingClientRect();
        const diff = Math.abs(cardTop + nh - r.bottom);
        if (diff < delta) {
          delta = diff;
          best = r;
        }
      });
      if (best) {
        nh = best.bottom - cardTop;
        card.style.height = nh + 'px';
      }

      reflowBoard();
      saveLayout();
    };

    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      startW = r.width;
      startH = r.height;
      sx = e.clientX;
      sy = e.clientY;
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', up, { passive: false });
    });
  });
})();

restoreLayout();
reflowBoard();

// ---------------- TradingView ----------------
const TV_X = {
  AAPL: 'NASDAQ',
  MSFT: 'NASDAQ',
  NVDA: 'NASDAQ',
  AMZN: 'NASDAQ',
  META: 'NASDAQ',
  GOOGL: 'NASDAQ',
  TSLA: 'NASDAQ',
  AVGO: 'NASDAQ',
  AMD: 'NASDAQ',
  NFLX: 'NASDAQ',
  ADBE: 'NASDAQ',
  INTC: 'NASDAQ',
  CSCO: 'NASDAQ',
  QCOM: 'NASDAQ',
  TXN: 'NASDAQ',
  CRM: 'NYSE',
  ORCL: 'NYSE',
  IBM: 'NYSE',
  NOW: 'NYSE',
  SNOW: 'NYSE',
  ABNB: 'NASDAQ',
  SHOP: 'NYSE',
  PYPL: 'NASDAQ',
  JPM: 'NYSE',
  BAC: 'NYSE',
  WFC: 'NYSE',
  GS: 'NYSE',
  MS: 'NYSE',
  V: 'NYSE',
  MA: 'NYSE',
  AXP: 'NYSE',
  'BRK-B': 'NYSE',
  SCHW: 'NYSE',
  KO: 'NYSE',
  PEP: 'NASDAQ',
  PG: 'NYSE',
  MCD: 'NYSE',
  COST: 'NASDAQ',
  HD: 'NYSE',
  LOW: 'NYSE',
  DIS: 'NYSE',
  NKE: 'NYSE',
  SBUX: 'NASDAQ',
  TGT: 'NYSE',
  WMT: 'NYSE',
  T: 'NYSE',
  VZ: 'NYSE',
  CMCSA: 'NASDAQ',
  XOM: 'NYSE',
  CVX: 'NYSE',
  COP: 'NYSE',
  CAT: 'NYSE',
  BA: 'NYSE',
  GE: 'NYSE',
  UPS: 'NYSE',
  FDX: 'NYSE',
  DE: 'NYSE',
  UNH: 'NYSE',
  LLY: 'NYSE',
  MRK: 'NYSE',
  ABBV: 'NYSE',
  JNJ: 'NYSE',
  PFE: 'NYSE',
  UBER: 'NYSE',
  BKNG: 'NASDAQ',
  SPY: 'AMEX',
  QQQ: 'NASDAQ',
  DIA: 'AMEX',
  IWM: 'AMEX',
};
const toTV = s => `${TV_X[s] || 'NASDAQ'}:${s}`;

function mountTV(symbol, override = null) {
  chartTitle.textContent = `Chart – ${symbol}`;
  tvContainer.innerHTML = '';
  if (typeof TradingView === 'undefined' || !TradingView.widget) {
    tvContainer.innerHTML =
      '<div class="muted">TradingView failed to load (check network/adblock).</div>';
    return;
  }
  const theme =
    document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

  new TradingView.widget({
    symbol: override || toTV(symbol),
    interval: '60',
    timezone: 'Etc/UTC',
    theme,
    style: '1',
    toolbar_bg: 'transparent',
    locale: 'en',
    enable_publishing: false,
    allow_symbol_change: false,
    container_id: 'tv_container',
    autosize: true,
  });
}

// ---------------- ticker bar (all items clickable, smooth marquee) ----------------
const tickerNodes = new Map(); // sym -> {priceEls:[], chgEls:[], last:number}
let marqueeId = 0;
let offsetX = 0;
let halfWidth = 0;

function buildTicker(items) {
  tickerTrack.innerHTML = '';
  tickerNodes.clear();

  const doubled = [...items, ...items]; // continuous scroll
  doubled.forEach(tk => {
    const item = document.createElement('div');
    item.className = 'ticker-item';
    item.dataset.sym = tk.symbol;

    const s = document.createElement('span');
    s.className = 'sym';
    s.textContent = tk.symbol;

    const p = document.createElement('span');
    p.className = 'price';
    p.textContent = fmt(tk.price);

    const c = document.createElement('span');
    c.className = 'chg ' + clsFor(tk.change_pct);
    c.textContent = fmtPct(tk.change_pct);

    item.append(s, p, c);
    item.addEventListener('click', () => onSelect(tk.symbol));
    tickerTrack.appendChild(item);

    let node = tickerNodes.get(tk.symbol);
    if (!node) {
      node = { priceEls: [], chgEls: [], last: tk.price };
      tickerNodes.set(tk.symbol, node);
    }
    node.priceEls.push(p);
    node.chgEls.push(c);
  });

  halfWidth = tickerTrack.scrollWidth / 2;
  offsetX = 0;
  startMarquee();
}

function updateTicker(items) {
  items.forEach(tk => {
    const node = tickerNodes.get(tk.symbol);
    if (!node) return;

    const newPrice = fmt(tk.price);
    const up = (tk.price || 0) > (node.last || 0);

    node.priceEls.forEach(el => {
      if (el.textContent !== newPrice) {
        node.last = tk.price;
        el.textContent = newPrice;
        const parent = el.parentElement;
        parent.classList.remove('flash-up', 'flash-down');
        void parent.offsetWidth;
        parent.classList.add(up ? 'flash-up' : 'flash-down');
        setTimeout(() => parent.classList.remove('flash-up', 'flash-down'), 600);
      }
    });

    node.chgEls.forEach(el => {
      el.className = 'chg ' + clsFor(tk.change_pct);
      el.textContent = fmtPct(tk.change_pct);
    });
  });
}

function startMarquee() {
  cancelAnimationFrame(marqueeId);
  const speed = 60; // px/s
  let last = performance.now();

  const step = t => {
    const dt = (t - last) / 1000;
    last = t;
    offsetX -= speed * dt;
    if (offsetX <= -halfWidth) offsetX += halfWidth;
    tickerTrack.style.transform = `translateX(${offsetX}px)`;
    marqueeId = requestAnimationFrame(step);
  };
  marqueeId = requestAnimationFrame(step);
}

tickerWrap.addEventListener('mouseenter', () => cancelAnimationFrame(marqueeId));
tickerWrap.addEventListener('mouseleave', () => startMarquee());

async function loadTickers() {
  try {
    const data = await fetchJSON(API.tickers);
    if (!tickerNodes.size) buildTicker(data);
    else updateTicker(data);
  } catch (e) {
    console.error(e);
    if (!tickerNodes.size) {
      tickerTrack.innerHTML =
        '<div class="muted" style="padding:6px 10px;">tickers unavailable</div>';
    }
  }
}

// ---------------- movers ----------------
function drawMovers(tb, arr) {
  tb.innerHTML = '';
  if (!arr || !arr.length) {
    tb.innerHTML = '<tr><td class="muted">No data</td></tr>';
    return;
  }
  arr.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.symbol}</td><td>${fmt(r.price)}</td><td class="${clsFor(
      r.change_pct,
    )}">${fmtPct(r.change_pct)}</td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => onSelect(r.symbol));
    tb.appendChild(tr);
  });
}

async function loadMovers() {
  try {
    const m = await fetchJSON(API.movers);
    drawMovers(gainersBody, m.gainers);
    drawMovers(losersBody, m.losers);
  } catch (e) {
    console.error(e);
  }
}

// ---------------- insights ----------------
function renderPerf(perf) {
  const keys = ['1W', '1M', '3M', '6M', 'YTD', '1Y'];
  perfGrid.innerHTML = '';
  keys.forEach(k => {
    const v = perf ? perf[k] : null;
    const d = document.createElement('div');
    d.className = `perf-box ${clsFor(v)}`;
    d.innerHTML = `<div class="p-val">${
      v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'
    }</div><div class="p-lbl">${k}</div>`;
    perfGrid.appendChild(d);
  });
}

async function loadInsights(symbol) {
  insightsTitle.textContent = `Market Insights: ${symbol}`;
  renderPerf(null);
  coDesc.textContent = '';
  try {
    const m = await fetchJSON(API.metrics, { params: { symbol } });
    renderPerf(m.performance);
    coDesc.textContent = (m.profile && m.profile.description) || '';
  } catch (e) {
    console.error(e);
  }
}

// ---------------- news ----------------
function renderNews(container, rows) {
  container.innerHTML = '';
  if (!rows || !rows.length) {
    container.innerHTML = '<div class="muted">No headlines.</div>';
    return;
  }
  rows.forEach(n => {
    const el = document.createElement('div');
    el.className = 'news-item';
    const a = document.createElement('a');
    a.href = n.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = n.title || '(untitled)';
    const m = document.createElement('div');
    m.className = 'muted';
    m.textContent = n.source || '';
    el.append(a, m);
    container.appendChild(el);
  });
}

async function loadNews(symbol) {
  newsList.innerHTML = '<div class="fallback-note">Loading news…</div>';
  try {
    const rows = await fetchJSON(API.news, { params: { symbol } });
    renderNews(newsList, rows);
  } catch (e) {
    console.error(e);
    newsList.innerHTML = '<div class="muted">Failed to load news.</div>';
  }
}

async function loadMarketNews() {
  marketNewsList.innerHTML =
    '<div class="fallback-note">Loading market headlines…</div>';
  try {
    const rows = await fetchJSON(API.mktnews);
    renderNews(marketNewsList, rows);
  } catch (e) {
    console.error(e);
    marketNewsList.innerHTML =
      '<div class="muted">Failed to load market headlines.</div>';
  }
}

// ---------------- selection ----------------
async function onSelect(symbol, override = null) {
  currentSymbol = symbol;
  tvOverride = override || null;
  mountTV(symbol, tvOverride);
  await Promise.allSettled([loadInsights(symbol), loadNews(symbol)]);
}

// ---------------- boot ----------------
document.addEventListener('DOMContentLoaded', () => {
  loadTickers();
  setInterval(loadTickers, 25000);

  loadMovers();
  setInterval(loadMovers, 30000);

  loadMarketNews();
  setInterval(loadMarketNews, 180000);

  // default symbol
  setTimeout(() => {
    if (!currentSymbol) onSelect('AAPL');
  }, 300);
});
