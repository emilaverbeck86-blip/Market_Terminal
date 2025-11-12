// Robust front-end: timeouts, clear error messaging, snap-resize preview fixed,
// Stooq-backed endpoints, SPX/QQQ shortcuts preserved.

const ENDPOINTS={
  tickers:"/api/tickers",
  movers:"/api/movers",
  profile:"/api/profile",
  metrics:"/api/metrics",
  news:"/api/news",
  mktnews:"/api/market-news",
  health:"/api/health"
};

const tickerScroll=document.getElementById('tickerScroll');
const tvContainer=document.getElementById('tv_container');
const chartTitle=document.getElementById('chartTitle');
const newsList=document.getElementById('newsList');
const marketNewsList=document.getElementById('marketNewsList');
const gainersBody=document.getElementById('gainersBody');
const losersBody=document.getElementById('losersBody');
const companyBox=document.getElementById('companyBox');
const gridRoot=document.getElementById('gridRoot');
const themeToggle=document.getElementById('themeToggle');
const settingsBtn=document.getElementById('settingsBtn');
const settingsMenu=document.getElementById('settingsMenu');

let currentSymbol=null, currentTVOverride=null;
let lastSeasonals=null, lastCompound=0;

// --- helpers ---
function fetchJSON(url, {timeout=10000, params} = {}){
  const ctrl=new AbortController();
  const id=setTimeout(()=>ctrl.abort(), timeout);
  const u = params ? (url + "?" + new URLSearchParams(params).toString()) : url;
  return fetch(u, {signal: ctrl.signal})
    .then(r=>{ if(!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.json(); })
    .finally(()=>clearTimeout(id));
}
const fmtPrice=v=>(typeof v==='number'&&isFinite(v))?v.toFixed(2):'—';
const fmtChange=v=>(v==null||!isFinite(v))?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el,v){ el.className='chg '+(v>0?'pos':(v<0?'neg':'neu')); }

// --- Settings dropdown & theme ---
(function(){
  let open=false;
  const close=()=>{ settingsMenu.classList.remove('open'); open=false; };
  settingsBtn.addEventListener('click',(e)=>{ e.stopPropagation(); open=!open; settingsMenu.classList.toggle('open', open); });
  document.addEventListener('click',(e)=>{ if(!open) return; if(!settingsMenu.contains(e.target) && e.target!==settingsBtn) close(); });

  const saved=localStorage.getItem('mt_theme')||'dark';
  document.documentElement.setAttribute('data-theme', saved);
  themeToggle.checked=(saved==='light');
  themeToggle.addEventListener('change', ()=>{
    const t=themeToggle.checked?'light':'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mt_theme', t);
    if(currentSymbol) mountTradingView(currentSymbol, currentTVOverride);
    drawSeasonals(lastSeasonals);
    drawGauge(lastCompound);
  });
})();

// --- tile visibility (unchanged) ---
(function(){
  const savedVis=JSON.parse(localStorage.getItem('mt_tiles_vis')||"{}");
  settingsMenu.querySelectorAll('.tile-toggle').forEach(cb=>{
    const id=cb.dataset.tile;
    if(id in savedVis) cb.checked=!!savedVis[id];
    applyTileVisibility(id, cb.checked);
    cb.addEventListener('change', ()=>{
      applyTileVisibility(id, cb.checked);
      const v=JSON.parse(localStorage.getItem('mt_tiles_vis')||"{}");
      v[id]=cb.checked; localStorage.setItem('mt_tiles_vis', JSON.stringify(v));
    });
  });
  document.querySelectorAll('.min-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const id=btn.dataset.hide; applyTileVisibility(id,false);
      const v=JSON.parse(localStorage.getItem('mt_tiles_vis')||"{}"); v[id]=false;
      localStorage.setItem('mt_tiles_vis', JSON.stringify(v));
      const cb=settingsMenu.querySelector(`.tile-toggle[data-tile="${id}"]`); if(cb) cb.checked=false;
    });
  });
})();
function applyTileVisibility(id, show){
  const el=document.getElementById(id); if(!el) return;
  el.style.display=show?'':'none';
}

// --- header-only drag (same as before) ---
(function(){
  const orderKey='mt_tile_order';
  const saved=JSON.parse(localStorage.getItem(orderKey)||'[]');
  if(saved.length){ saved.forEach(id=>{ const el=document.getElementById(id); if(el) gridRoot.appendChild(el); }); }

  let dragEl=null, placeholder=null;

  gridRoot.addEventListener('dragstart', e=>{
    const header=e.target.closest('.card-hd[draggable="true"]');
    if(!header) { e.preventDefault(); return; }
    dragEl=header.parentElement;
    dragEl.classList.add('dragging');
    placeholder=document.createElement('section');
    placeholder.className='placeholder card';
    placeholder.style.height=`${dragEl.getBoundingClientRect().height}px`;
    dragEl.after(placeholder);
  });

  gridRoot.addEventListener('dragover', e=>{
    if(!dragEl) return; e.preventDefault();
    const after=getAfter(gridRoot, e.clientY);
    if(after==null) gridRoot.appendChild(placeholder);
    else gridRoot.insertBefore(placeholder, after);
  });

  gridRoot.addEventListener('dragend', ()=>{
    if(!dragEl) return;
    dragEl.classList.remove('dragging');
    if(placeholder){ placeholder.replaceWith(dragEl); placeholder=null; }
    const ids=[...gridRoot.querySelectorAll('.card')].map(n=>n.id);
    localStorage.setItem(orderKey, JSON.stringify(ids));
    dragEl=null;
  });

  function getAfter(container, y){
    const els=[...container.querySelectorAll('.card:not(.dragging)')];
    return els.reduce((closest, child)=>{
      const box=child.getBoundingClientRect();
      const offset=y - box.top - box.height/2;
      if(offset<0 && offset>closest.offset){ return {offset, element:child}; }
      return closest;
    }, {offset:Number.NEGATIVE_INFINITY}).element;
  }
})();

// --- snap-resize with correct on-screen preview ---
(function initSnapResize(){
  const GAP = 14;
  const ROW_UNIT = 90;
  const cards=[...document.querySelectorAll('.resizable')];
  let outline=null;

  function colWidth(){ return (gridRoot.clientWidth - GAP) / 2; }

  cards.forEach(card=>{
    const handle=card.querySelector('.resize-handle');
    if(!handle) return;
    const allowed=(card.dataset.allowed||"1x3,1x4").split(",").map(s=>{
      const [c,r]=s.split("x").map(Number); return {c,r};
    });

    let startRect=null, startX=0, startY=0;

    const onMove=(e)=>{
      const dx=e.clientX-startX, dy=e.clientY-startY;
      const estW=Math.max(280, startRect.width+dx);
      const estH=Math.max(180, startRect.height+dy);

      const cW=colWidth();
      const estCols = estW > cW*1.25 ? 2 : 1;
      const estRows = Math.max(2, Math.round(estH / ROW_UNIT));

      let best=allowed[0], bestDist=1e9;
      allowed.forEach(opt=>{
        const d=Math.abs(opt.c-estCols)*3 + Math.abs(opt.r-estRows);
        if(d<bestDist){ best=opt; bestDist=d; }
      });

      // place outline exactly over the card's top-left (no drift out of viewport)
      const targetW = best.c===2 ? (cW*2 + GAP) : cW;
      const targetH = best.r * ROW_UNIT;
      outline.style.left=`${startRect.left}px`;
      outline.style.top =`${startRect.top}px`;
      outline.style.width = `${targetW}px`;
      outline.style.height= `${targetH}px`;
    };

    const onUp=()=>{
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const cW=colWidth();
      const ow=parseFloat(outline.style.width), oh=parseFloat(outline.style.height);
      const cols = (ow > cW*1.25) ? 2 : 1;
      const rows = Math.max(2, Math.round(oh/ROW_UNIT));

      card.classList.toggle('span-2', cols===2);
      card.dataset.cols=String(cols);
      card.dataset.rows=String(rows);
      card.className = card.className.replace(/\brow-\d+\b/g,'').trim();
      card.classList.add(`row-${rows}`);

      document.body.removeChild(outline); outline=null;
      card.classList.remove('resizing');

      drawSeasonals(lastSeasonals);
      drawGauge(lastCompound);
    };

    handle.addEventListener('pointerdown',(e)=>{
      startRect=card.getBoundingClientRect();
      startX=e.clientX; startY=e.clientY;
      card.classList.add('resizing');

      outline=document.createElement('div');
      outline.className='resize-outline';
      outline.style.left=`${startRect.left}px`;
      outline.style.top =`${startRect.top}px`;
      outline.style.width =`${startRect.width}px`;
      outline.style.height=`${startRect.height}px`;
      document.body.appendChild(outline);

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });
})();

// --- TradingView ---
const TV_EXCHANGE={AAPL:"NASDAQ",MSFT:"NASDAQ",NVDA:"NASDAQ",AMZN:"NASDAQ",META:"NASDAQ",GOOGL:"NASDAQ",TSLA:"NASDAQ",AVGO:"NASDAQ",AMD:"NASDAQ",NFLX:"NASDAQ",ADBE:"NASDAQ",INTC:"NASDAQ",CSCO:"NASDAQ",QCOM:"NASDAQ",TXN:"NASDAQ",CRM:"NYSE",PYPL:"NASDAQ",SHOP:"NYSE",ABNB:"NASDAQ",SNOW:"NYSE",JPM:"NYSE",BAC:"NYSE",WFC:"NYSE",GS:"NYSE",MS:"NYSE",V:"NYSE",MA:"NYSE",AXP:"NYSE","BRK-B":"NYSE",KO:"NYSE",PEP:"NASDAQ",MCD:"NYSE",PG:"NYSE",HD:"NYSE",LOW:"NYSE",COST:"NASDAQ",DIS:"NYSE",NKE:"NYSE",T:"NYSE",VZ:"NYSE",XOM:"NYSE",CVX:"NYSE",PFE:"NYSE",LLY:"NYSE",UNH:"NYSE",MRK:"NYSE",ABBV:"NYSE",CAT:"NYSE",BA:"NYSE",UPS:"NYSE",FDX:"NYSE",ORCL:"NYSE",IBM:"NYSE",UBER:"NYSE",LYFT:"NASDAQ"};
const toTV=s=>`${(TV_EXCHANGE[s]||'NASDAQ')}:${s}`;
function mountTradingView(symbol, tvOverride=null){
  chartTitle.textContent=`Chart – ${symbol}`;
  tvContainer.innerHTML="";
  if(typeof TradingView==="undefined"||!TradingView.widget){
    const warn=document.createElement("div"); warn.className="muted"; warn.textContent="TradingView failed to load."; tvContainer.appendChild(warn); return;
  }
  const theme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';
  new TradingView.widget({
    symbol: tvOverride || toTV(symbol),
    interval:'60',
    timezone:'Etc/UTC',
    theme,
    style:'1',
    toolbar_bg:'transparent',
    locale:'en',
    enable_publishing:false,
    allow_symbol_change:false,
    container_id:'tv_container',
    autosize:true
  });
}

// --- Ticker bar (robust) ---
const tickerNodes=new Map();
function renderTicker(items){
  tickerScroll.innerHTML=''; tickerNodes.clear();
  const twice=[...items,...items];
  twice.forEach(tk=>{
    const item=document.createElement('div'); item.className='ticker-item'; item.dataset.sym=tk.symbol;
    const sym=document.createElement('span'); sym.className='sym'; sym.textContent=tk.symbol;
    const price=document.createElement('span'); price.className='price'; price.textContent=fmtPrice(tk.price);
    const chg=document.createElement('span'); chg.className='chg'; applyChangeClass(chg, tk.change_pct); chg.textContent=fmtChange(tk.change_pct);
    item.append(sym,price,chg);
    item.addEventListener('click', ()=>onSymbolSelect(tk.symbol));
    tickerScroll.appendChild(item);
    if(!tickerNodes.has(tk.symbol)) tickerNodes.set(tk.symbol,{item,price,chg,last:tk.price});
  });
  if(items.length) onSymbolSelect(items[0].symbol);
}
function updateTicker(items){
  items.forEach(tk=>{
    const n=tickerNodes.get(tk.symbol); if(!n) return;
    const newText=fmtPrice(tk.price);
    if(newText!==n.price.textContent){
      const up=((tk.price||0)>(n.last||0));
      n.item.classList.remove('flash-up','flash-down'); void n.item.offsetWidth;
      n.item.classList.add(up?'flash-up':'flash-down');
      setTimeout(()=>n.item.classList.remove('flash-up','flash-down'),600);
      n.price.textContent=newText; n.last=tk.price;
    }
    applyChangeClass(n.chg, tk.change_pct);
    n.chg.textContent=fmtChange(tk.change_pct);
  });
}
async function loadTickers(){
  try{
    const data=await fetchJSON(ENDPOINTS.tickers, {timeout: 12000});
    if(!tickerScroll.childElementCount) renderTicker(data);
    else updateTicker(data);
  }catch(err){
    console.error("tickers error", err);
    // show a minimal fallback once
    if(!tickerScroll.childElementCount){
      renderTicker([{symbol:"AAPL"},{symbol:"MSFT"},{symbol:"NVDA"}]);
    }
  }
}

// --- Movers (clickable rows + pointer cursor) ---
function renderMovers(movers){
  const fill=(tbody,arr)=>{
    tbody.innerHTML='';
    if(!Array.isArray(arr)||!arr.length){tbody.innerHTML='<tr><td class="muted">No data</td></tr>'; return;}
    arr.forEach(r=>{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.style.cursor='pointer';
      tr.addEventListener('mouseenter',()=>tr.style.background='rgba(255,255,255,.04)');
      tr.addEventListener('mouseleave',()=>tr.style.background='transparent');
      tr.addEventListener('click',()=>onSymbolSelect(r.symbol));
      tbody.appendChild(tr);
    });
  };
  fill(gainersBody, movers.gainers||[]); fill(losersBody, movers.losers||[]);
}
async function loadMovers(){
  try{
    const movers=await fetchJSON(ENDPOINTS.movers, {timeout: 12000});
    renderMovers(movers);
  }catch(err){
    console.error("movers error",err);
    renderMovers({gainers:[], losers:[]});
  }
}

// --- Company/profile ---
async function loadCompany(symbol){
  try{
    const p=await fetchJSON(ENDPOINTS.profile, {params:{symbol}, timeout: 8000});
    companyBox.innerHTML=`<div class="co-name"><b>${p.name||symbol}</b> <span class="muted">(${symbol})</span></div><p class="co-desc">${p.description||''}</p>`;
  }catch(err){
    console.error("profile error",err);
    companyBox.innerHTML='<div class="muted">No description available.</div>';
  }
}

// --- Insights (performance + seasonals + gauge) ---
const perfGrid=document.getElementById('perfGrid');
const seasonalsCanvas=document.getElementById('seasonalsCanvas');
const insightsTitle=document.getElementById('insightsTitle');
const gaugeCanvas=document.getElementById('gaugeCanvas');
const gctx=gaugeCanvas.getContext('2d');
const gaugeLabel=document.getElementById('gaugeLabel');

function renderPerf(perf){
  const labels=["1W","1M","3M","6M","YTD","1Y"];
  perfGrid.innerHTML='';
  labels.forEach(k=>{
    const val=perf?perf[k]:null;
    const d=document.createElement('div');
    d.className='perf-box '+(val>0?'pos':(val<0?'neg':'neu'));
    d.innerHTML=`<div class="p-val">${(val==null)?'—':`${val>0?'+':''}${val.toFixed(2)}%`}</div><div class="p-lbl">${k}</div>`;
    perfGrid.appendChild(d);
  });
}
function drawSeasonals(seasonals){
  lastSeasonals=seasonals||{};
  const parent=seasonalsCanvas.parentElement;
  const W=Math.max(320, parent.clientWidth-8), H=Math.max(140, parent.clientHeight-36);
  seasonalsCanvas.width=W; seasonalsCanvas.height=H;

  const theme=document.documentElement.getAttribute('data-theme');
  const gridColor = theme==='light' ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.08)';
  const axisColor = theme==='light' ? '#333' : '#ddd';
  const colors = {"2025":"#3b82f6","2024":"#22c55e","2023":"#f59e0b"};

  const keys=Object.keys(lastSeasonals).sort().reverse().slice(0,3);
  const ctx=seasonalsCanvas.getContext('2d'); ctx.clearRect(0,0,W,H);
  if(!keys.length) return;

  let minX=1,maxX=1,minY=0,maxY=0;
  keys.forEach(k=> (lastSeasonals[k]||[]).forEach(([x,y])=>{
    minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y);
  }));
  if(minY===maxY){ minY-=1; maxY+=1; }

  const pad=28;
  const xScale=x=> pad + (x-minX)/(maxX-minX||1)*(W-2*pad);
  const yScale=y=> H-pad - (y-minY)/(maxY-minY||1)*(H-2*pad);

  // grid
  ctx.strokeStyle=gridColor; ctx.lineWidth=1; ctx.beginPath();
  [0.25,0.5,0.75].forEach(f=>{ const x=pad+f*(W-2*pad); ctx.moveTo(x,pad); ctx.lineTo(x,H-pad); });
  ctx.stroke();

  // axis
  ctx.strokeStyle=axisColor; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(pad,H-pad); ctx.lineTo(W-pad,H-pad); ctx.stroke();

  // series
  keys.forEach(k=>{
    const pts=lastSeasonals[k]||[]; if(!pts.length) return;
    ctx.strokeStyle=colors[k]||'#aaa'; ctx.lineWidth=2; ctx.beginPath();
    pts.forEach(([x,y],i)=>{ const X=xScale(x), Y=yScale(y); if(i===0) ctx.moveTo(X,Y); else ctx.lineTo(X,Y); });
    ctx.stroke();
  });
}
new ResizeObserver(()=>drawSeasonals(lastSeasonals)).observe(seasonalsCanvas.parentElement);

// gauge
let lastCmp=0;
function drawGauge(compound=0){
  lastCmp=compound; lastCompound=compound;
  const W=gaugeCanvas.clientWidth, H=gaugeCanvas.clientHeight;
  gaugeCanvas.width=W; gaugeCanvas.height=H;
  const c=gctx; c.clearRect(0,0,W,H);
  const cx=W/2, cy=H*0.95, r=Math.min(W, H*1.9)/2 - 8;

  const grad=c.createLinearGradient(cx-r,0,cx+r,0);
  grad.addColorStop(0,"#ff5a5f"); grad.addColorStop(0.5,"#ffd166"); grad.addColorStop(1,"#2ecc71");
  c.lineWidth=10; c.strokeStyle=grad;
  c.beginPath(); c.arc(cx,cy,r,Math.PI,2*Math.PI); c.stroke();

  const angle = Math.PI + (compound+1)*Math.PI/2;
  const nx = cx + (r-6)*Math.cos(angle), ny = cy + (r-6)*Math.sin(angle);
  c.strokeStyle=getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#fff';
  c.lineWidth=3; c.beginPath(); c.moveTo(cx,cy); c.lineTo(nx,ny); c.stroke();
  c.beginPath(); c.arc(cx,cy,4,0,2*Math.PI); c.fillStyle=c.strokeStyle; c.fill();

  let label='Neutral';
  if(compound>0.05) label=`Bullish ${(compound*100).toFixed(0)}%`;
  else if(compound<-0.05) label=`Bearish ${Math.abs(compound*100).toFixed(0)}%`;
  gaugeLabel.textContent=label;
}

async function loadInsights(symbol){
  insightsTitle.textContent=`Market Insights: ${symbol}`;
  renderPerf(null); drawSeasonals(null); drawGauge(0);
  try{
    const m=await fetchJSON(ENDPOINTS.metrics, {params:{symbol}, timeout: 12000});
    renderPerf(m.performance);
    drawSeasonals(m.seasonals||{});
  }catch(err){ console.error("metrics error", err); }
  // Optional: sentiment via news provider not guaranteed here; leave gauge Neutral unless you add endpoint back
}

// --- News (scrollable tile) ---
function renderNews(container, articles){
  container.innerHTML='';
  if(!Array.isArray(articles)||!articles.length){ container.innerHTML='<div class="muted">No headlines.</div>'; return; }
  articles.forEach(n=>{
    const item=document.createElement('div'); item.className='news-item';
    const a=document.createElement('a'); a.href=n.url||'#'; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=n.title||'(untitled)';
    const meta=document.createElement('div'); meta.className='muted'; const src=n.source||'Unknown'; const ts=n.published_at||''; meta.textContent=`${src}${ts?` · ${ts}`:''}`;
    item.append(a,meta); container.appendChild(item);
  });
}
async function loadNews(symbol){
  newsList.innerHTML='<div class="fallback-note">Loading news…</div>';
  try{
    const data=await fetchJSON(ENDPOINTS.news, {params:{symbol}, timeout: 12000});
    renderNews(newsList, data);
  }catch(err){
    console.error("news error",err);
    newsList.innerHTML='<div class="muted">Failed to load news.</div>';
  }
}
async function loadMarketNews(){
  marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>';
  try{
    const data=await fetchJSON(ENDPOINTS.mktnews, {timeout: 12000});
    renderNews(marketNewsList, data);
  }catch(err){
    console.error("market news error",err);
    marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>';
  }
}

// --- Selection ---
async function onSymbolSelect(symbol, tvOverride=null){
  currentSymbol=symbol; currentTVOverride=tvOverride;
  mountTradingView(symbol, tvOverride);
  await Promise.allSettled([
    loadCompany(symbol),
    loadInsights(symbol),
    loadNews(symbol)
  ]);
}

// --- Quick links ---
document.querySelectorAll('.quick-links .ql').forEach(b=>{
  b.addEventListener('click',()=>{
    const backendSym=b.dataset.symbol;        // SPY/QQQ
    const tvSym=b.dataset.tv || null;         // TVC:SPX etc.
    onSymbolSelect(backendSym, tvSym);
  });
});

// --- Boot ---
document.addEventListener('DOMContentLoaded', async ()=>{
  // quick health check (optional)
  fetchJSON(ENDPOINTS.health, {timeout: 5000}).catch(()=>console.warn("Health check failed"));
  loadTickers(); setInterval(loadTickers, 60_000);
  loadMovers();  setInterval(loadMovers,  60_000);
  loadMarketNews(); setInterval(loadMarketNews, 180_000);
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('TSLA'); }, 800);
});
