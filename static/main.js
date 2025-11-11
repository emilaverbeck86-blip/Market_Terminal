// Market Terminal — tickers, TV chart, quote, movers, news, sentiment.
// Calendar now embedded via iframe in index.html (no JS call needed).

const TICKER_ENDPOINT    = "/api/tickers";
const MOVERS_ENDPOINT    = "/api/movers";
const QUOTE_ENDPOINT     = "/api/quote";
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
const quoteBox       = document.getElementById('quoteBox');
const gainersBody    = document.getElementById('gainersBody');
const losersBody     = document.getElementById('losersBody');

const NEWS_INIT_COUNT = 8, NEWS_EXPANDED_COUNT = 30;
const MARKET_NEWS_INIT = 6, MARKET_NEWS_EXP = 30;

let currentSymbol = null, newsExpanded=false, marketNewsExpanded=false;

// TradingView exchange map
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
    warn.textContent = "TradingView script failed to load (check network/adblock).";
    tvContainer.appendChild(warn);
    return;
  }
  new TradingView.widget({
    symbol: toTV(symbol),
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

// --------- Ticker bar ----------
const nodes = new Map();
const fmtPrice = v => (typeof v==='number' && isFinite(v)) ? v.toFixed(2) : '—';
const fmtChange = v => (v==null||!isFinite(v)) ? '0.00%' : `${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el, v){ el.className = 'chg ' + (v>0?'pos':(v<0?'neg':'')); }

function buildTickerRow(items){
  tickerScroll.innerHTML = '';
  nodes.clear();
  const twice = [...items, ...items];
  twice.forEach(tk=>{
    const item=document.createElement('div'); item.className='ticker-item'; item.dataset.sym=tk.symbol;
    const sym=document.createElement('span'); sym.className='sym'; sym.textContent=tk.symbol;
    const price=document.createElement('span'); price.className='price'; price.textContent=fmtPrice(tk.price);
    const chg=document.createElement('span'); chg.className='chg'; applyChangeClass(chg, tk.change_pct); chg.textContent=fmtChange(tk.change_pct);
    item.append(sym, price, chg);
    item.addEventListener('click', ()=>onSymbolSelect(tk.symbol));
    tickerScroll.appendChild(item);
    if (!nodes.has(tk.symbol)) nodes.set(tk.symbol,{item,price,chg,last:tk.price});
  });
  requestAnimationFrame(()=> tickerScroll.classList.add('marquee-ready'));
  if (!currentSymbol && items.length) onSymbolSelect(items[0].symbol);
}
function liveUpdate(items){
  items.forEach(tk=>{
    const n=nodes.get(tk.symbol); if(!n) return;
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
    if (!r.ok) throw new Error('tickers');
    const data = await r.json();
    if (!tickerScroll.childElementCount) buildTickerRow(data);
    else liveUpdate(data);
  }catch(e){ /* keep prior */ }
}

// --------- Movers & Quote ----------
function renderMovers(movers){
  const fill = (tbody, arr) => {
    tbody.innerHTML = '';
    arr.forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML = `<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'')}">${fmtChange(r.change_pct)}</td>`;
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
    if (!r.ok) return;
    renderMovers(await r.json());
  }catch(e){}
}
async function loadQuote(symbol){
  try{
    const r = await fetch(`${QUOTE_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    if (!r.ok) throw new Error('quote');
    const q = await r.json();
    quoteBox.innerHTML = `
      <div class="stat-row">
        <div><b>${q.symbol || symbol}</b></div>
        <div class="stat-price">${q.price!=null?fmtPrice(q.price):'—'} <span class="${q.change_pct>0?'pos':(q.change_pct<0?'neg':'')}">${fmtChange(q.change_pct)}</span></div>
      </div>
      <div class="stats-grid">
        <div><span>Prev Close</span><b>${q.previous_close??'—'}</b></div>
        <div><span>Day Low</span><b>${q.day_low??'—'}</b></div>
        <div><span>Day High</span><b>${q.day_high??'—'}</b></div>
        <div><span>52w Low</span><b>${q.year_low??'—'}</b></div>
        <div><span>52w High</span><b>${q.year_high??'—'}</b></div>
        <div><span>Volume</span><b>${q.volume??'—'}</b></div>
        <div><span>Market Cap</span><b>${q.market_cap??'—'}</b></div>
      </div>
    `;
  }catch(e){
    quoteBox.innerHTML = '<div class="muted">Quote unavailable.</div>';
  }
}

// --------- News / Sentiment / Market News ----------
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
  newsList.innerHTML='<div class="fallback-note">Loading news…</div>';
  try{
    const r=await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const data=await r.json();
    if (!Array.isArray(data) || !data.length){
      newsList.innerHTML='<div class="muted">No recent headlines found.</div>'; newsMoreBtn.style.display='none'; return;
    }
    renderNews(newsList, data, newsExpanded?NEWS_EXPANDED_COUNT:NEWS_INIT_COUNT);
    newsMoreBtn.style.display = data.length > NEWS_INIT_COUNT ? 'inline-flex' : 'none';
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
    const r=await fetch(MKT_NEWS_ENDPOINT); const data=await r.json();
    if (!Array.isArray(data) || !data.length){
      marketNewsList.innerHTML='<div class="muted">No market headlines available.</div>'; marketNewsMoreBtn.style.display='none'; return;
    }
    renderNews(marketNewsList, data, marketNewsExpanded?MARKET_NEWS_EXP:MARKET_NEWS_INIT);
    marketNewsMoreBtn.style.display = data.length > MARKET_NEWS_INIT ? 'inline-flex' : 'none';
    marketNewsMoreBtn.textContent = marketNewsExpanded ? 'View less' : 'View more';
    marketNewsMoreBtn.onclick=()=>{ marketNewsExpanded=!marketNewsExpanded; renderNews(marketNewsList, data, marketNewsExpanded?MARKET_NEWS_EXP:MARKET_NEWS_INIT); marketNewsMoreBtn.textContent=marketNewsExpanded?'View less':'View more'; };
  }catch(e){ marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; marketNewsMoreBtn.style.display='none'; }
}

// --------- Selection ----------
async function onSymbolSelect(symbol){
  currentSymbol = symbol;
  mountTradingView(symbol);
  await Promise.all([ loadQuote(symbol), loadNews(symbol), loadSentiment(symbol) ]);
}

// --------- Boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 10000);
  loadMovers();  setInterval(loadMovers, 30000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
});
