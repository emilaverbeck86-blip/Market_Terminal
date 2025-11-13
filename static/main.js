// Stable quotes (Yahoo + fallback), smooth RAFrame marquee, live resize, recoded Market Insights.

const ENDPOINTS={
  tickers:"/api/tickers", movers:"/api/movers", profile:"/api/profile",
  metrics:"/api/metrics", news:"/api/news", mktnews:"/api/market-news"
};

const $=id=>document.getElementById(id);

// DOM
const tickerWrap=$('tickerWrap'), tickerTrack=$('tickerTrack');
const tvContainer=$('tv_container'), chartTitle=$('chartTitle');
const newsList=$('newsList'), marketNewsList=$('marketNewsList');
const gainersBody=$('gainersBody'), losersBody=$('losersBody');
const board=$('board'), themeToggle=$('themeToggle'), settingsBtn=$('settingsBtn'), settingsMenu=$('settingsMenu');
const nasdaqBtn=$('btnNasdaq'), spxBtn=$('btnSPX');
const perfGrid=$('perfGrid'), insightsTitle=$('insightsTitle'), coDesc=$('coDesc');

let currentSymbol=null, currentTVOverride=null;

// fetch helper
function fetchJSON(url,{timeout=12000,params}={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeout);
const u=params?`${url}?${new URLSearchParams(params)}`:url;return fetch(u,{signal:c.signal}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).finally(()=>clearTimeout(t));}
const fmtPrice=v=>(typeof v==='number'&&isFinite(v))?v.toFixed(2):'—';
const fmtChange=v=>(v==null||!isFinite(v))?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el,v){el.className='chg '+(v>0?'pos':(v<0?'neg':'neu'));}

// ---------- Theme/menu ----------
(()=>{let open=false;const close=()=>{settingsMenu.classList.remove('open');open=false;};
settingsBtn.addEventListener('click',e=>{e.stopPropagation();open=!open;settingsMenu.classList.toggle('open',open);});
document.addEventListener('click',e=>{if(!open)return;if(!settingsMenu.contains(e.target)&&e.target!==settingsBtn)close();});
const saved=localStorage.getItem('mt_theme')||'dark';document.documentElement.setAttribute('data-theme',saved);
themeToggle.checked=(saved==='light');themeToggle.addEventListener('change',()=>{const t=themeToggle.checked?'light':'dark';
document.documentElement.setAttribute('data-theme',t);localStorage.setItem('mt_theme',t);if(currentSymbol)mountTradingView(currentSymbol,currentTVOverride);});})();

// ---------- Drag & Live Resize (flex board) ----------
(()=>{
// move by header
let dragEl=null, ghost=null, startX=0,startY=0, startLeft=0,startTop=0;
board.addEventListener('dragstart',e=>{const hd=e.target.closest('.card-hd[draggable="true"]'); if(!hd){e.preventDefault();return;}
dragEl=hd.parentElement; dragEl.classList.add('dragging');
ghost=document.createElement('div'); ghost.className='ghost'; ghost.style.width=getComputedStyle(dragEl).width; ghost.style.height=getComputedStyle(dragEl).height;
dragEl.after(ghost);
});
board.addEventListener('dragend',()=>{ if(!dragEl) return; ghost.replaceWith(dragEl); dragEl.classList.remove('dragging'); dragEl=null; ghost=null; });

// live resize
const MIN_W=300, MIN_H=200;
board.querySelectorAll('.card.resizable .resize-handle').forEach(h=>{
  let card=h.closest('.card'), sW=0,sH=0, sx=0, sy=0, outline=null;
  const move=e=>{
    const nw=Math.max(MIN_W, sW+(e.clientX-sx));
    const nh=Math.max(MIN_H, sH+(e.clientY-sy));
    outline.style.width=nw+'px'; outline.style.height=nh+'px';
    card.style.width=nw+'px'; card.style.height=nh+'px';
  };
  const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up); if(outline){outline.remove();outline=null;} card.classList.remove('resizing');};
  h.addEventListener('pointerdown',e=>{
    e.preventDefault(); sW=card.getBoundingClientRect().width; sH=card.getBoundingClientRect().height; sx=e.clientX; sy=e.clientY; card.classList.add('resizing');
    outline=document.createElement('div'); outline.className='resize-outline'; const r=card.getBoundingClientRect(); outline.style.left=r.left+'px'; outline.style.top=r.top+'px'; outline.style.width=r.width+'px'; outline.style.height=r.height+'px';
    document.body.appendChild(outline);
    document.addEventListener('pointermove',move,{passive:false}); document.addEventListener('pointerup',up,{passive:false});
  });
});
})();

// ---------- TradingView ----------
const TV_EXCHANGE={AAPL:"NASDAQ",MSFT:"NASDAQ",NVDA:"NASDAQ",AMZN:"NASDAQ",META:"NASDAQ",GOOGL:"NASDAQ",TSLA:"NASDAQ",AVGO:"NASDAQ",AMD:"NASDAQ",NFLX:"NASDAQ",ADBE:"NASDAQ",INTC:"NASDAQ",CSCO:"NASDAQ",QCOM:"NASDAQ",TXN:"NASDAQ",CRM:"NYSE",ORCL:"NYSE",IBM:"NYSE",NOW:"NYSE",SNOW:"NYSE",ABNB:"NASDAQ",SHOP:"NYSE",PYPL:"NASDAQ",JPM:"NYSE",BAC:"NYSE",WFC:"NYSE",GS:"NYSE",MS:"NYSE",V:"NYSE",MA:"NYSE",AXP:"NYSE","BRK-B":"NYSE",SCHW:"NYSE",KO:"NYSE",PEP:"NASDAQ",PG:"NYSE",MCD:"NYSE",COST:"NASDAQ",HD:"NYSE",LOW:"NYSE",DIS:"NYSE",NKE:"NYSE",SBUX:"NASDAQ",TGT:"NYSE",WMT:"NYSE",T:"NYSE",VZ:"NYSE",CMCSA:"NASDAQ",XOM:"NYSE",CVX:"NYSE",COP:"NYSE",CAT:"NYSE",BA:"NYSE",GE:"NYSE",UPS:"NYSE",FDX:"NYSE",DE:"NYSE",UNH:"NYSE",LLY:"NYSE",MRK:"NYSE",ABBV:"NYSE",JNJ:"NYSE",PFE:"NYSE",UBER:"NYSE",BKNG:"NASDAQ",SPY:"AMEX",QQQ:"NASDAQ",DIA:"AMEX",IWM:"AMEX"};
const toTV=s=>`${(TV_EXCHANGE[s]||'NASDAQ')}:${s}`;
function mountTradingView(symbol, tvOverride=null){
  chartTitle.textContent=`Chart – ${symbol}`;
  tvContainer.innerHTML="";
  if(typeof TradingView==="undefined"||!TradingView.widget){const w=document.createElement('div');w.className='muted';w.textContent='TradingView failed to load.';tvContainer.appendChild(w);return;}
  const theme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';
  new TradingView.widget({symbol: tvOverride||toTV(symbol), interval:'60', timezone:'Etc/UTC', theme, style:'1',
    toolbar_bg:'transparent', locale:'en', enable_publishing:false, allow_symbol_change:false, container_id:'tv_container', autosize:true});
}

// ---------- Ticker marquee (requestAnimationFrame; never jumps) ----------
const tmap=new Map();
let rafId=0, x=0, contentW=0;
function rebuildMarquee(){
  const inner=[...tmap.keys()].map(sym=>{
    const n=tmap.get(sym); return n? n.el.outerHTML : '';
  }).join('');
  tickerTrack.innerHTML = `<div class="row">${inner}</div><div class="row">${inner}</div>`;
  contentW = tickerTrack.scrollWidth/2;
  x = 0;
}
function startMarquee(){
  cancelAnimationFrame(rafId);
  const speed = 60; // px/sec
  let lastTs=performance.now();
  const step=(ts)=>{
    const dt=(ts-lastTs)/1000; lastTs=ts;
    x -= speed*dt;
    if(x <= -contentW) x += contentW;
    tickerTrack.style.transform=`translateX(${x}px)`;
    rafId=requestAnimationFrame(step);
  };
  rafId=requestAnimationFrame(step);
}
tickerWrap.addEventListener('mouseenter', ()=>{tickerTrack.style.transition='none'; cancelAnimationFrame(rafId);});
tickerWrap.addEventListener('mouseleave', ()=>{startMarquee();});

function renderTicker(items){
  tmap.clear();
  const frag=document.createDocumentFragment();
  items.forEach(tk=>{
    const el=document.createElement('div'); el.className='ticker-item'; el.dataset.sym=tk.symbol;
    const s=document.createElement('span'); s.className='sym'; s.textContent=tk.symbol;
    const p=document.createElement('span'); p.className='price'; p.textContent=fmtPrice(tk.price);
    const c=document.createElement('span'); c.className='chg'; applyChangeClass(c, tk.change_pct); c.textContent=fmtChange(tk.change_pct);
    el.append(s,p,c); el.addEventListener('click',()=>onSymbolSelect(tk.symbol)); frag.appendChild(el);
    if(!tmap.has(tk.symbol)) tmap.set(tk.symbol,{el,p,c,last:tk.price});
  });
  // place once; rebuildMarquee duplicates and measures
  tickerTrack.innerHTML='';
  const row=document.createElement('div'); row.className='row'; row.appendChild(frag); tickerTrack.appendChild(row);
  rebuildMarquee(); startMarquee();
}

function updateTicker(items){
  items.forEach(tk=>{
    const n=tmap.get(tk.symbol); if(!n) return;
    const newP=fmtPrice(tk.price);
    if(newP!==n.p.textContent){
      const up=((tk.price||0)>(n.last||0));
      n.el.classList.remove('flash-up','flash-down'); void n.el.offsetWidth;
      n.el.classList.add(up?'flash-up':'flash-down');
      setTimeout(()=>n.el.classList.remove('flash-up','flash-down'), 600);
      n.p.textContent=newP; n.last=tk.price;
    }
    applyChangeClass(n.c, tk.change_pct); n.c.textContent=fmtChange(tk.change_pct);
  });
}

async function loadTickers(){
  try{
    const data=await fetchJSON(ENDPOINTS.tickers);
    if(!tmap.size) renderTicker(data); else updateTicker(data);
  }catch(e){
    if(!tmap.size) tickerTrack.innerHTML='<div class="muted" style="padding:4px 8px">tickers unavailable</div>';
    console.error(e);
  }
}

// ---------- Movers ----------
function renderMovers(m){
  const draw=(tb,arr)=>{ tb.innerHTML=''; if(!arr||!arr.length){tb.innerHTML='<tr><td class="muted">No data</td></tr>';return;}
    arr.forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.style.cursor='pointer'; tr.addEventListener('click',()=>onSymbolSelect(r.symbol)); tb.appendChild(tr); }); };
  renderTicker // eslint appeaser
  draw(gainersBody,m.gainers); draw(losersBody,m.losers);
}
async function loadMovers(){ try{ renderMovers(await fetchJSON(ENDPOINTS.movers)); }catch(e){ console.error(e); } }

// ---------- Market Insights (perf + company desc only) ----------
function renderPerf(perf){ const labels=["1W","1M","3M","6M","YTD","1Y"]; perfGrid.innerHTML='';
  labels.forEach(k=>{ const v=perf?perf[k]:null; const d=document.createElement('div'); d.className='perf-box '+(v>0?'pos':(v<0?'neg':'neu'));
    d.innerHTML=`<div class="p-val">${(v==null)?'—':`${v>0?'+':''}${v.toFixed(2)}%`}</div><div class="p-lbl">${k}</div>`; perfGrid.appendChild(d); });}

async function loadInsights(symbol){
  insightsTitle.textContent=`Market Insights: ${symbol}`; renderPerf(null); coDesc.textContent='';
  try{
    const m=await fetchJSON(ENDPOINTS.metrics,{params:{symbol}});
    renderPerf(m.performance);
    const d=(m.profile && m.profile.description) ? m.profile.description : '';
    coDesc.textContent=d;
  }catch(e){ console.error(e); }
}

// ---------- News ----------
function renderNews(container, items){ container.innerHTML=''; if(!items||!items.length){container.innerHTML='<div class="muted">No headlines.</div>';return;}
  items.forEach(n=>{const it=document.createElement('div');it.className='news-item';const a=document.createElement('a');a.href=n.url||'#';a.target='_blank';a.rel='noopener noreferrer';a.textContent=n.title||'(untitled)';
    const meta=document.createElement('div');meta.className='muted';meta.textContent=`${n.source||'News'}${n.published_at?` · ${n.published_at}`:''}`;it.append(a,meta);container.appendChild(it);});}
async function loadNews(symbol){ newsList.innerHTML='<div class="fallback-note">Loading news…</div>'; try{renderNews(newsList, await fetchJSON(ENDPOINTS.news,{params:{symbol}}));}catch{newsList.innerHTML='<div class="muted">Failed to load news.</div>';}}
async function loadMarketNews(){ marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>'; try{renderNews(marketNewsList, await fetchJSON(ENDPOINTS.mktnews));}catch{marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; }}

// ---------- Select ----------
async function onSymbolSelect(symbol, tvOverride=null){
  currentSymbol=symbol; currentTVOverride=tvOverride; mountTradingView(symbol, tvOverride);
  await Promise.allSettled([ loadInsights(symbol), loadNews(symbol) ]);
}

// shortcuts
nasdaqBtn.addEventListener('click', ()=> onSymbolSelect('QQQ', 'NASDAQ:IXIC'));
spxBtn.addEventListener('click', ()=> onSymbolSelect('SPY',  'TVC:SPX'));

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 25000);
  loadMovers();  setInterval(loadMovers,  30000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('AAPL'); }, 800);
});

// basic error surface
window.addEventListener('error', e=>console.error('JS error:', e.message, e.filename, e.lineno));
