// ---------- API endpoints ----------
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

// ---------- helper ----------
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

// ---------- settings / theme / tile toggles ----------
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
    if (vis.hasOwnProperty(chk.dataset.target))
      chk.checked = !!vis[chk.dataset.target];

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
      saveLayout();
    });
  });

  // little "-" close button on each card
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
      saveLayout();
    });
  });
})();

// ---------- quick shortcuts ----------
spxBtn.addEventListener('click', () =>
  onSelect('SPY', 'CAPITALCOM:US500'),
);
ndxBtn.addEventListener('click', () =>
  onSelect('QQQ', 'CAPITALCOM:US100'),
);

// ---------- grid layout (two lanes that always fill width) ----------
const LAYOUT_KEY = 'mt_layout_v4';
let lanePct = 0.6; // left lane fraction (0..1)

function applyLaneWidths() {
  const pctL = Math.round(lanePct * 100);
  const pctR = Math.max(5, 100 - pctL - 2);
  document.documentElement.style.setProperty(
    '--lane-left-pct',
    pctL + '%',
  );
  document.documentElement.style.setProperty(
    '--lane-right-pct',
    pctR + '%',
  );
}

function saveLayout() {
  const lanes = [...board.children]
    .filter(n => n.classList && n.classList.contains('movable'))
    .map(n => ({
      id: n.id,
      lane: n.classList.contains('lane-right') ? 'right' : 'left',
      h: n.style.height || '',
      hidden: getComputedStyle(n).display === 'none',
    }));
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ pct: lanePct, lanes }));
}

function restoreLayout() {
  try {
    const st = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
    if (Array.isArray(st.lanes)) {
      st.lanes.forEach(cfg => {
        const el = $(cfg.id);
        if (!el) return;
        el.classList.toggle('lane-right', cfg.lane === 'right');
        el.classList.toggle('lane-left', cfg.lane !== 'right');
        if (cfg.h) el.style.height = cfg.h;
        if (cfg.hidden) el.style.display = 'none';
        board.appendChild(el);
      });
    }
    if (typeof st.pct === 'number') lanePct = st.pct;
  } catch (e) {}
  applyLaneWidths();
}

// drag to move cards between lanes
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
    placeholder.className = 'placeholder movable';
    placeholder.style.height = getComputedStyle(dragging).height;
    placeholder.classList.add(
      dragging.classList.contains('lane-right') ? 'lane-right' : 'lane-left',
    );
    dragging.after(placeholder);
  });

  board.addEventListener('dragover', e => {
    if (!dragging) return;
    e.preventDefault();

    const br = board.getBoundingClientRect();
    const mid = (br.left + br.right) / 2;
    const lane = e.clientX > mid ? 'lane-right' : 'lane-left';

    dragging.classList.toggle('lane-right', lane === 'lane-right');
    dragging.classList.toggle('lane-left', lane !== 'lane-right');
    placeholder.classList.toggle('lane-right', lane === 'lane-right');
    placeholder.classList.toggle('lane-left', lane !== 'lane-right');

    const sameLane = [...board.querySelectorAll(`.${lane}.movable`)].filter(
      n => n !== dragging && n !== placeholder && getComputedStyle(n).display !== 'none',
    );
    let target = null;
    let best = Infinity;
    sameLane.forEach(n => {
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
    saveLayout();
  }

  board.addEventListener('drop', endDrag);
  board.addEventListener('dragend', endDrag);
})();

// resize cards with pointer capture
(() => {
  const MIN_W = 260;
  const MIN_H = 220;

  board.querySelectorAll('.card.resizable .resize-handle').forEach(handle => {
    const card = handle.closest('.card');
    let startW = 0,
      startH = 0,
      sx = 0,
      sy = 0,
      lane = 'left';

    function onMove(e) {
      const br = board.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      let dx = e.clientX - sx;
      let dy = e.clientY - sy;

      const newW = Math.max(MIN_W, startW + dx);
      const newH = Math.max(MIN_H, startH + dy);

      // clamp to board width
      const maxW = br.width - 24;
      const clampedW = Math.min(maxW, newW);

      // convert to lanePct [0.3, 0.8]
      if (lane === 'left') {
        const pct = clampedW / br.width;
        lanePct = Math.max(0.3, Math.min(0.8, pct));
      } else {
        const rightFrac = clampedW / br.width;
        lanePct = Math.max(0.3, Math.min(0.8, 1 - rightFrac));
      }
      applyLaneWidths();

      // vertical resize just sets card height; CSS grid makes neighbour in same row match
      card.style.height = newH + 'px';
      saveLayout();
    }

    function onUp(e) {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
    }

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      startW = rect.width;
      startH = rect.height;
      sx = e.clientX;
      sy = e.clientY;
      lane = card.classList.contains('lane-right') ? 'right' : 'left';

      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });
  });
})();

restoreLayout();

// ---------- TradingView ----------
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
    document.documentElement.getAttribute('data-theme') === 'light'
      ? 'light'
      : 'dark';

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

// ---------- ticker bar ----------
const tickerNodes = new Map();
let marqueeId = 0;
let offsetX = 0;
let halfWidth = 0;

function buildTicker(items) {
  tickerTrack.innerHTML = '';
  tickerNodes.clear();

  const doubled = [...items, ...items];
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
        setTimeout(
          () => parent.classList.remove('flash-up', 'flash-down'),
          600,
        );
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
  const speed = 60;
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

tickerWrap.addEventListener('mouseenter', () =>
  cancelAnimationFrame(marqueeId),
);
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

// ---------- movers ----------
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

// ---------- insights ----------
function renderPerf(perf) {
  const keys = ['1W', '1M', '3M', '6M', 'YTD', '1Y'];
  perfGrid.innerHTML = '';
  keys.forEach(k => {
    const v = perf ? perf[k] : null;
    const box = document.createElement('div');
    box.className = `perf-box ${clsFor(v)}`;
    box.innerHTML = `<div class="p-val">${
      v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'
    }</div><div class="p-lbl">${k}</div>`;
    perfGrid.appendChild(box);
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

// ---------- news ----------
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
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = n.source || '';
    el.append(a, meta);
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

// ---------- selection ----------
async function onSelect(symbol, override = null) {
  currentSymbol = symbol;
  tvOverride = override || null;
  mountTV(symbol, tvOverride);
  await Promise.allSettled([loadInsights(symbol), loadNews(symbol)]);
}

// ---------- boot ----------
document.addEventListener('DOMContentLoaded', () => {
  loadTickers();
  setInterval(loadTickers, 5000);

  loadMovers();
  setInterval(loadMovers, 30000);

  loadMarketNews();
  setInterval(loadMarketNews, 180000);

  if (!currentSymbol) onSelect('AAPL');
});
