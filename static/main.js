// Robust tickers with sticky server cache; company description instead of stats.
// Drag & drop tiles + Settings (theme toggle + show/hide).

const TICKER_ENDPOINT    = "/api/tickers";
const MOVERS_ENDPOINT    = "/api/movers";
const QUOTE_ENDPOINT     = "/api/quote";
const PROF_ENDPOINT      = "/api/profile";
const NEWS_ENDPOINT      = "/api/news";
const SENTI_ENDPOINT     = "/api/sentiment";
const MKT_NEWS_ENDPOINT  = "/api/market-news";

// DOM
const tickerScroll   = document.getElementById('tickerScroll');
const tvContainer    = document.getElementById('tv_container');
const chartTitle     = document.getElementById('chartTitle');
const newsList       = document.getElementById('newsList');
const sentiBadge     = document.getElementById('sentimentBadge');
const sentiBar       = document.getElementById('sentimentBar');
const marketNewsList = document.getElementById('marketNewsList');
const newsMoreBtn    = document.getElementById('newsMoreBtn');
const marketNewsMoreBtn = document.getElementById('marketNewsMoreBtn');
const gainersBody    = document.getElementById('gainersBody');
const losersBody     = document.getElementById('losersBody');
const companyBox     = document.getElementById('companyBox');

const gridRoot       = document.getElementById('gridRoot');
const themeToggle    = document.getElementById('themeToggle');
const settingsMenu   = document.getElementById('settingsMenu');

const NEWS_INIT_COUNT = 8, NEWS_EXPANDED_COUNT = 30;
const MARKET_NEWS_INIT = 6, MARKET_NEWS_EXP = 30;

let currentSymbol = null, newsExpanded=false, marketNewsExpanded=false;

// ===== Settings (theme + tile toggles) =====
(function initSettings(){
  // theme
  const savedTheme = localStorage.getItem('mt_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeToggle.checked = (savedTheme === 'light');
  themeToggle.addEventListener('change', ()=>{
    const t = themeToggle.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mt_theme', t);
    if (currentSymbol) mountTradingView(currentSymbol);
  });

  // tile show/hide
  const savedVis = JSON.parse(localStorage.getItem('mt_tiles_vis') || "{}");
  Array.from(settingsMenu.querySelectorAll('.tile-toggle')).forEach(cb=>{
    const id = cb.dataset.tile;
    if (id in savedVis) { cb.checked = !!savedVis[id]; }
    applyTileVisibility(id, cb.checked);
    cb.addEventListener('change', ()=>{
      applyTileVisibility(id, cb.checked);
      const v = JSON.parse(localStorage.getItem('mt_tiles_vis') || "{}");
      v[id] = cb.checked; localStorage.setItem('mt_tiles_vis', JSON.stringify(v));
    });
  });

  // header minus buttons
  document.querySelectorAll('.min-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id = btn.dataset.hide;
      applyTileVisibility(id, false);
      const v = JSON.parse(localStorage.getItem('mt_tiles_vis') || "{}");
      v[id]=false; localStorage.setItem('mt_tiles_vis', JSON.stringify(v));
      const cb = settingsMenu.querySelector(`.tile-toggle[data-tile="${id}"]`);
      if (cb) cb.checked=false;
    });
  });
})();
function applyTileVisibility(id, show){
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = show ? '' : 'none';
}

// ===== Drag & Drop layout (DOM reorder + save) =====
(function initDrag(){
  const orderKey = 'mt_tile_order';
  const saved = JSON.parse(localStorage.getItem(orderKey) || '[]');
  if (saved.length){
    saved.forEach(id=>{
      const el=document.getElementById(id);
      if (el) gridRoot.appendChild(el);
    });
  }
  let dragEl=null;
  gridRoot.addEventListener('dragstart', e=>{
    const card = e.target.closest('.draggable'); if(!card) return;
    dragEl=card; e.dataTransfer.effectAllowed='move';
    card.classList.add('dragging');
  });
  gridRoot.addEventListener('dragend', e=>{
    const card = e.target.closest('.draggable'); if(!card) return;
    card.classList.remove('dragging');
    dragEl=null;
    saveOrder();
  });
  gridRoot.addEventListener('dragover', e=>{
    if(!dragEl) return; e.preventDefault();
    const after = getDragAfterElement(gridRoot, e.clientY);
    if (after == null) gridRoot.appendChild(dragEl);
    else gridRoot.insertBefore(dragEl, after);
  });
  function saveOrder(){
    const ids=[...gridRoot.querySelectorAll('.draggable')].map(n=>n.id);
    localStorage.setItem(orderKey, JSON.stringify(ids));
  }
  function getDragAfterElement(container, y){
    const els=[...container.querySelectorAll('.draggable:not(.dragging)')];
    return els.reduce((closest, child)=>{
      const box=child.getBoundingClientRect();
      const offset=y - box.top - box.height/2;
      if(offset<0 && offset>closest.offset){ return {offset, element:child}; }
      else return closest;
    }, {offset: Number.NEGATIVE_INFINITY}).element;
  }
})();

// ===== TradingView =====
const TV_EXCHANGE = {
  AAPL:"NASDAQ", MSFT:"NASDAQ", NVDA:"NASDAQ", AMZN:"NASDAQ", META:"NASDAQ",
  GOOGL:"NASDAQ", TSLA:"NASDAQ", AVGO:"NASDAQ", AMD:"NASDAQ", NFLX:"NASDAQ",
  ADBE:"NASDAQ", INTC:"NASDAQ", CSCO:"NASDAQ", QCOM:"NASDAQ", TXN:"NASDAQ",
  CRM:"NYSE", PYPL:"NASDAQ", SHOP:"NYSE", ABNB:"NASDAQ", SNOW:"NYSE",
  JPM:"NYSE", BAC:"NYSE", WFC:"NYSE", GS:"NYSE", MS:"NYSE", V:"NYSE", MA:"NYSE",
  AXP:"NYSE", "BRK-B":"NYSE", KO:"NYSE", PEP:"NASDAQ", MCD:"NYSE",
  PG:"NYSE", HD:"NYSE", LOW:"NYSE", COST:"NASDAQ", DIS:"NYSE", NKE:"NYSE",
  T:"NYSE", VZ:"NYSE", XOM:"NYSE", CVX:"NYSE", PFE:"NYSE", LLY:"NYSE",
  UNH:"NYSE", MRK:"NYSE", ABBV:"NYSE", CAT:"NYSE", BA:"NYSE", UPS:"NYSE",
  FDX:"NYSE", ORCL:"NYSE", IBM:"NYSE", UBER:"NYSE", LYFT:"NASDAQ"
};
const toTV = s => `${(TV_EXCHANGE[s]||'NASDAQ')}:${s}`;

function mountTradingView(symbol) {
  chartTitle.textContent = `Chart – ${symbol}`;
  tvContainer.innerHTML = "";
  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const warn = document.createElement("div");
    warn.className = "muted";
    warn.textContent = "TradingView script failed to load.";
    tvContainer.appendChild(warn);
    return;
  }
  const theme = document.documentElement.getAttribute('data-theme')==='light' ? 'light' : 'dark';
  new TradingView.widget({
    symbol: toTV(symbol),
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

// ===== Helpers =====
const fmtPrice = v => (typeof v==='number' && isFinite(v)) ? v.toFixed(2) : '—';
const fmtChange = v => (v==null||!isFinite(v)) ? '—' : `${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el, v){ el.className = 'chg ' + (v>0?'pos':(v<0?'neg':'neu')); }

// ===== Ticker bar =====
const tickerNodes = new Map();

function renderTicker(items){
  if (!Array.isArray(items) || !items.length){
    items = [{symbol:"TSLA",price:null,change_pct:null},{symbol:"AAPL",price:null,change_pct:null},{symbol:"MSFT",price:null,change_pct:null}];
  }
  tickerScroll.innerHTML = '';
  tickerNodes.clear();
  const twice = [...items, ...items];
  twice.forEach(tk=>{
    const item=document.createElement('div'); item.className='ticker-item'; item.dataset.sym=tk.symbol;
    const sym=document.createElement('span'); sym.className='sym'; sym.textContent=tk.symbol;
    const price=document.createElement('span'); price.className='price'; price.textContent=fmtPrice(tk.price);
    const chg=document.createElement('span'); chg.className='chg'; applyChangeClass(chg, tk.change_pct); chg.textContent=fmtChange(tk.change_pct);
    item.append(sym, price, chg);
    item.addEventListener('click', ()=>onSymbolSelect(tk.symbol));
    tickerScroll.appendChild(item);
    if (!tickerNodes.has(tk.symbol)) tickerNodes.set(tk.symbol,{item,price,chg,last:tk.price});
  });
  requestAnimationFrame(()=> tickerScroll.classList.add('marquee-ready'));
  if (!currentSymbol) onSymbolSelect(items[0].symbol);
}

function updateTicker(items){
  items.forEach(tk=>{
    const n=tickerNodes.get(tk.symbol); if(!n) return;
    const newText = fmtPrice(tk.price);
    if (newText !== n.price.textContent){
      const up = (tk.price||0) > (n.last||0);
      n.item.classList.remove('flash-up','flash-down'); void n.item.offsetWidth;
      n.item.classList.add(up?'flash-up':'flash-down');
      setTimeout(()=>n.item.classList.remove('flash-up','flash-down'), 600);
      n.price.textContent = newText; n.last=tk.price;
    }
    applyChangeClass(n.chg, tk.change_pct);
    n.chg.textContent = fmtChange(tk.change_pct);
  });
}

async function loadTickers(){
  try{
    const r = await fetch(TICKER_ENDPOINT);
    const data = await r.json();
    if (!tickerScroll.childElementCount) renderTicker(data);
    else updateTicker(data);
  }catch(e){
    // keep previous snapshot in UI
  }
}

// ===== Movers / Company / Quote =====
function renderMovers(movers){
  const fill = (tbody, arr) => {
    tbody.innerHTML = '';
    if (!Array.isArray(arr) || !arr.length){ tbody.innerHTML='<tr><td class="muted">No data</td></tr>'; return; }
    arr.forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.addEventListener('click', ()=>onSymbolSelect(r.symbol));
      tbody.appendChild(tr);
    });
  };
  fill(gainersBody, movers.gainers||[]);
  fill(losersBody, movers.losers||[]);
}
async function loadMovers(){
  try{
    const r=await fetch(MOVERS_ENDPOINT);
    const data=await r.json();
    renderMovers(data);
  }catch(e){
    renderMovers({gainers:[], losers:[]});
  }
}
async function loadCompany(symbol){
  try{
    const r = await fetch(`${PROF_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const p = await r.json();
    companyBox.innerHTML = `
      <div class="co-name"><b>${p.name || symbol}</b> <span class="muted">(${symbol})</span></div>
      <p class="co-desc">${(p.description || '').slice(0, 800)}</p>
    `;
  }catch(e){
    companyBox.innerHTML = `<div class="muted">No description available.</div>`;
  }
}

// ===== News / Sentiment =====
function renderNews(container, articles, limit){
  container.innerHTML = '';
  if (!Array.isArray(articles) || !articles.length){
    container.innerHTML = '<div class="muted">No headlines.</div>';
    return;
  }
  articles.slice(0, limit).forEach(n=>{
    const item = document.createElement('div'); item.className = 'news-item';
    const a = document.createElement('a');
    a.href = n.url || '#'; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = n.title || '(untitled)';
    const meta = document.createElement('div'); meta.className = 'muted';
    const src = n.source || 'Unknown'; const ts = n.published_at || '';
    meta.textContent = `${src}${ts?` · ${ts}`:''}`;
    item.append(a, meta); container.appendChild(item);
  });
}
async function loadNews(symbol){
  newsList.innerHTML='<div class="fallback-note">Loading news…</div>';
  try{
    const r=await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`); 
    const data=await r.json();
    renderNews(newsList, data, newsExpanded?NEWS_EXPANDED_COUNT:NEWS_INIT_COUNT);
    newsMoreBtn.style.display = (Array.isArray(data) && data.length>NEWS_INIT_COUNT) ? 'inline-flex' : 'none';
    newsMoreBtn.textContent = newsExpanded ? 'View less' : 'View more';
    newsMoreBtn.onclick=()=>{ newsExpanded=!newsExpanded; renderNews(newsList, data, newsExpanded?NEWS_EXPANDED_COUNT:NEWS_INIT_COUNT); newsMoreBtn.textContent=newsExpanded?'View less':'View more'; };
  }catch(e){ newsList.innerHTML='<div class="muted">Failed to load news.</div>'; newsMoreBtn.style.display='none'; }
}
function badge(score){ if(score>0.05)return{cls:'pos',label:`Positive ${(score*100).toFixed(0)}%`}; if(score<-0.05)return{cls:'neg',label:`Negative ${Math.abs(score*100).toFixed(0)}%`}; return{cls:'neu',label:'Neutral'}; }
async function loadSentiment(symbol){
  try{
    const r=await fetch(`${SENTI_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`); const s=await r.json();
    const comp=(typeof s.compound==='number')?s.compound:0; const b=badge(comp);
    sentiBadge.className=`sentiment-badge ${b.cls}`; sentiBadge.textContent=`Sentiment: ${b.label}`;
    sentiBar.style.width=Math.round((comp+1)*50)+'%';
  }catch{ sentiBadge.className='sentiment-badge'; sentiBadge.textContent='Sentiment: —'; sentiBar.style.width='0%'; }
}
async function loadMarketNews(){
  marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>';
  try{
    const r=await fetch(MKT_NEWS_ENDPOINT); 
    const data=await r.json();
    renderNews(marketNewsList, data, marketNewsExpanded?MARKET_NEWS_EXP:MARKET_NEWS_INIT);
    marketNewsMoreBtn.style.display = (Array.isArray(data) && data.length>MARKET_NEWS_INIT) ? 'inline-flex' : 'none';
    marketNewsMoreBtn.textContent = marketNewsExpanded ? 'View less' : 'View more';
    marketNewsMoreBtn.onclick=()=>{ marketNewsExpanded=!marketNewsExpanded; renderNews(marketNewsList, data, marketNewsExpanded?MARKET_NEWS_EXP:MARKET_NEWS_INIT); marketNewsMoreBtn.textContent=marketNewsExpanded?'View less':'View more'; };
  }catch(e){ marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; marketNewsMoreBtn.style.display='none'; }
}

// ===== Selection =====
async function onSymbolSelect(symbol){
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([
    loadCompany(symbol),
    loadNews(symbol),
    loadSentiment(symbol),
  ]);
}

// ===== Boot =====
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 1000*30); // 30s (server cache 45s)
  loadMovers();  setInterval(loadMovers, 1000*45);  // sync-ish with cache
  loadMarketNews(); setInterval(loadMarketNews, 1000*180);

  // Fallback chart if nothing clicked yet
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('TSLA'); }, 800);
});
