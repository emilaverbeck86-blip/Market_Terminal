// Market Terminal — Pro ticker + TradingView + Sentiment + Market News + Econ Calendar
// Calendar is USD-only, high+medium impact, general (not tied to selected ticker).
// Shows Actual / Forecast / Previous.

const TICKER_ENDPOINT     = "/api/tickers";
const NEWS_ENDPOINT       = "/api/news";
const SENTI_ENDPOINT      = "/api/sentiment";
const MKT_NEWS_ENDPOINT   = "/api/market-news";
const CAL_ENDPOINT        = "/api/calendar";

const NEWS_INIT_COUNT        = 8;
const NEWS_EXPANDED_COUNT    = 30;
const MARKET_NEWS_INIT_COUNT = 6;
const MARKET_NEWS_EXPANDED   = 30;

const tickerScroll       = document.getElementById('tickerScroll');
const tvContainer        = document.getElementById('tv_container');
const chartTitle         = document.getElementById('chartTitle');
const newsList           = document.getElementById('newsList');
const sentiBadge         = document.getElementById('sentimentBadge');
const sentiBar           = document.getElementById('sentimentBar');
const marketNewsList     = document.getElementById('marketNewsList');
const econCalBody        = document.getElementById('econCalBody');
const newsMoreBtn        = document.getElementById('newsMoreBtn');
const marketNewsMoreBtn  = document.getElementById('marketNewsMoreBtn');

let currentSymbol = null;
let newsExpanded = false;
let marketNewsExpanded = false;

// ---- TradingView ----
function toTradingViewSymbol(symbol) {
  const compact = symbol.toUpperCase().replace(/[-]/g,'');
  if (/^[A-Z]{3,5}USDT?$/.test(compact)) return `BINANCE:${compact}`;
  return `NASDAQ:${symbol.toUpperCase()}`;
}
function mountTradingView(symbol) {
  chartTitle.textContent = `Chart – ${symbol}`;
  tvContainer.innerHTML = "";
  if (typeof TradingView === "undefined" || !TradingView.widget) {
    const warn = document.createElement("div");
    warn.className = "muted";
    warn.textContent = "TradingView script failed to load (check network/adblock).";
    tvContainer.appendChild(warn);
    return;
  }
  new TradingView.widget({
    symbol: toTradingViewSymbol(symbol),
    interval: '60',
    timezone: 'Etc/UTC',
    theme: 'dark',
    style: '1',
    toolbar_bg: '#000',
    locale: 'en',
    enable_publishing: false,
    allow_symbol_change: false,
    container_id: 'tv_container',
    autosize: true,
  });
}

// ---- Ticker ----
const nodes = new Map();
function firstRender(tickers){
  const build = (arr) => {
    arr.forEach(tk => {
      const item = document.createElement('div');
      item.className = 'ticker-item';
      item.dataset.sym = tk.symbol;

      const sym = document.createElement('span');
      sym.className = 'sym';
      sym.textContent = tk.symbol;

      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = fmtPrice(tk.price);

      const chg = document.createElement('span');
      chg.className = 'chg';
      applyChangeClass(chg, tk.change_pct);
      chg.textContent = fmtChange(tk.change_pct);

      item.append(sym, price, chg);
      item.addEventListener('click', () => onSymbolSelect(tk.symbol));
      tickerScroll.appendChild(item);

      nodes.set(tk.symbol, { item, price, chg, lastPrice: tk.price });
    });
  };
  build(tickers); build(tickers);
  if (!currentSymbol && tickers.length) onSymbolSelect(tickers[0].symbol);
}
function liveUpdate(tickers){
  tickers.forEach(tk => {
    const n = nodes.get(tk.symbol);
    if (!n) return;
    const priceText = fmtPrice(tk.price);
    if (priceText !== n.price.textContent){
      const up = (tk.price || 0) > (n.lastPrice || 0);
      n.item.classList.remove('flash-up','flash-down');
      void n.item.offsetWidth;
      n.item.classList.add(up ? 'flash-up' : 'flash-down');
      setTimeout(()=> n.item.classList.remove('flash-up','flash-down'), 600);
      n.price.textContent = priceText;
      n.lastPrice = tk.price;
    }
    applyChangeClass(n.chg, tk.change_pct);
    n.chg.textContent = fmtChange(tk.change_pct);
  });
}
function renderTickers(data){ if (!tickerScroll.childElementCount) firstRender(data); else liveUpdate(data); }
function fmtPrice(v){ return (typeof v === 'number' && isFinite(v)) ? Number(v).toFixed(2) : '—'; }
function fmtChange(v){ const n=(typeof v==='number'&&isFinite(v))?v:0; const s=n>0?'+':(n<0?'−':''); return `${s}${Math.abs(n).toFixed(2)}%`; }
function applyChangeClass(el,v){ el.className = 'chg ' + (v>0?'pos':(v<0?'neg':'')); }
async function fetchTickers(){
  try{
    const r = await fetch(TICKER_ENDPOINT);
    if (!r.ok) throw new Error(`tickers ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) throw new Error('empty');
    renderTickers(data);
  }catch(e){
    if (!tickerScroll.childElementCount){
      renderTickers([{symbol:"AAPL"},{symbol:"MSFT"},{symbol:"NVDA"},{symbol:"TSLA"},{symbol:"BTCUSDT"},{symbol:"ETHUSDT"}]);
    }
  }
}

// ---- News & Sentiment ----
async function onSymbolSelect(symbol){
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([ loadNews(symbol), loadSentiment(symbol) ]);
}
function renderNews(container, articles, limit){
  container.innerHTML = '';
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
  newsList.innerHTML = '<div class="fallback-note">Loading news…</div>';
  try{
    const r = await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) throw new Error(`news ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length){
      newsList.innerHTML = '<div class="muted">No recent headlines found.</div>';
      newsMoreBtn.style.display = 'none'; return;
    }
    renderNews(newsList, data, newsExpanded ? NEWS_EXPANDED_COUNT : NEWS_INIT_COUNT);
    newsMoreBtn.style.display = data.length > NEWS_INIT_COUNT ? 'inline-flex' : 'none';
    newsMoreBtn.textContent = newsExpanded ? 'View less' : 'View more';
    newsMoreBtn.onclick = () => {
      newsExpanded = !newsExpanded;
      renderNews(newsList, data, newsExpanded ? NEWS_EXPANDED_COUNT : NEWS_INIT_COUNT);
      newsMoreBtn.textContent = newsExpanded ? 'View less' : 'View more';
    };
  }catch(e){
    newsList.innerHTML = '<div class="muted">Failed to load news.</div>';
    newsMoreBtn.style.display = 'none';
  }
}
function badge(score){ if(score>0.05)return{cls:'pos',label:`Positive ${(score*100).toFixed(0)}%`}; if(score<-0.05)return{cls:'neg',label:`Negative ${Math.abs(score*100).toFixed(0)}%`}; return{cls:'neu',label:'Neutral'}; }
async function loadSentiment(symbol){
  try{
    const r = await fetch(`${SENTI_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) throw new Error(`sentiment ${r.status}`);
    const s = await r.json();
    const comp = (typeof s.compound === 'number') ? s.compound : 0;
    const b = badge(comp);
    sentiBadge.className = `sentiment-badge ${b.cls}`;
    sentiBadge.textContent = `Sentiment: ${b.label}`;
    sentiBar.style.width = Math.round((comp + 1) * 50) + '%';
  }catch{
    sentiBadge.className = 'sentiment-badge';
    sentiBadge.textContent = 'Sentiment: —';
    sentiBar.style.width = '0%';
  }
}

// ---- Market News (general, US) ----
async function loadMarketNews(){
  marketNewsList.innerHTML = '<div class="fallback-note">Loading market headlines…</div>';
  try{
    const r = await fetch(MKT_NEWS_ENDPOINT);
    if (!r.ok) throw new Error(`market-news ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length){
      marketNewsList.innerHTML = '<div class="muted">No market headlines available.</div>';
      marketNewsMoreBtn.style.display = 'none'; return;
    }
    renderNews(marketNewsList, data, marketNewsExpanded ? MARKET_NEWS_EXPANDED : MARKET_NEWS_INIT_COUNT);
    marketNewsMoreBtn.style.display = data.length > MARKET_NEWS_INIT_COUNT ? 'inline-flex' : 'none';
    marketNewsMoreBtn.textContent = marketNewsExpanded ? 'View less' : 'View more';
    marketNewsMoreBtn.onclick = () => {
      marketNewsExpanded = !marketNewsExpanded;
      renderNews(marketNewsList, data, marketNewsExpanded ? MARKET_NEWS_EXPANDED : MARKET_NEWS_INIT_COUNT);
      marketNewsMoreBtn.textContent = marketNewsExpanded ? 'View less' : 'View more';
    };
  }catch(e){
    marketNewsList.innerHTML = '<div class="muted">Failed to load market headlines.</div>';
    marketNewsMoreBtn.style.display = 'none';
  }
}

// ---- Economic Calendar (general USD; high+medium) ----
async function loadCalendar(){
  econCalBody.innerHTML = '<tr><td colspan="6" class="muted">Loading calendar…</td></tr>';
  try{
    const r = await fetch(CAL_ENDPOINT);
    if (!r.ok) throw new Error(`calendar ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data) || !data.length){
      econCalBody.innerHTML = '<tr><td colspan="6" class="muted">No data available.</td></tr>';
      return;
    }
    econCalBody.innerHTML = '';
    data.forEach(ev=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${ev.datetime || ''}</td>
        <td>${ev.event || ''}</td>
        <td>${ev.actual ?? ''}</td>
        <td>${ev.forecast ?? ''}</td>
        <td>${ev.previous ?? ''}</td>
        <td>${ev.country || ''}</td>
      `;
      econCalBody.appendChild(tr);
    });
  }catch(e){
    econCalBody.innerHTML = '<tr><td colspan="6" class="muted">No data available.</td></tr>';
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  fetchTickers(); setInterval(fetchTickers, 5000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
  loadCalendar(); setInterval(loadCalendar, 1800000);
});
