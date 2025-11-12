// Preset-snap resizing, header-only drag, reliable tickers/movers,
// NewsAPI→Yahoo RSS fallback handling client-side effects,
// Market Insights: performance + 3y seasonals + sentiment gauge,
// Top-bar shortcuts for NASDAQ (^IXIC) and S&P 500 (^GSPC).

const TICKER_ENDPOINT="/api/tickers";
const MOVERS_ENDPOINT="/api/movers";
const PROF_ENDPOINT  ="/api/profile";
const METRICS_ENDPOINT="/api/metrics";
const NEWS_ENDPOINT  ="/api/news";
const SENTI_ENDPOINT ="/api/sentiment";
const MKT_NEWS_ENDPOINT="/api/market-news";

const tickerScroll=document.getElementById('tickerScroll');
const tvContainer=document.getElementById('tv_container');
const chartTitle=document.getElementById('chartTitle');
const newsList=document.getElementById('newsList');
const marketNewsList=document.getElementById('marketNewsList');
const newsMoreBtn=document.getElementById('newsMoreBtn');
const marketNewsMoreBtn=document.getElementById('marketNewsMoreBtn');
const gainersBody=document.getElementById('gainersBody');
const losersBody=document.getElementById('losersBody');
const companyBox=document.getElementById('companyBox');
const gridRoot=document.getElementById('gridRoot');
const settingsBtn=document.getElementById('settingsBtn');
const settingsMenu=document.getElementById('settingsMenu');
const themeToggle=document.getElementById('themeToggle');
const insightsTitle=document.getElementById('insightsTitle');

// Insights & canvases
const perfGrid=document.getElementById('perfGrid');
const seasonalsCanvas=document.getElementById('seasonalsCanvas');
const sctx=seasonalsCanvas.getContext('2d');
const sentiGauge=document.getElementById('sentiGauge');
const gctx=sentiGauge.getContext('2d');

let currentSymbol=null, newsExpanded=false, marketNewsExpanded=false;
let lastSeasonals=null, lastSentiment=0;

// ---------- Quick links ----------
document.querySelectorAll('.ql-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> onSymbolSelect(btn.dataset.index));
});

// ---------- Settings dropdown ----------
(function(){
  let open=false;
  const close=()=>{ settingsMenu.classList.remove('open'); open=false; };
  settingsBtn.addEventListener('click',(e)=>{ e.stopPropagation(); open=!open; settingsMenu.classList.toggle('open', open); });
  document.addEventListener('click',(e)=>{ if(!open) return; if(!settingsMenu.contains(e.target) && e.target!==settingsBtn) close(); });
})();

// ---------- Theme ----------
(function(){
  const saved=localStorage.getItem('mt_theme')||'dark';
  document.documentElement.setAttribute('data-theme', saved);
  themeToggle.checked=(saved==='light');
  themeToggle.addEventListener('change', ()=>{
    const t=themeToggle.checked?'light':'dark';
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('mt_theme', t);
    if(currentSymbol) mountTradingView(currentSymbol);
    drawSeasonals(lastSeasonals);
    drawGauge(lastSentiment);
  });
})();

// ---------- Tile visibility ----------
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

// ---------- Preset sizes & snapping ----------
const SIZE_PRESETS = {
  // span: 1|2, h in px; order is S < M < L
  "tile-chart":    [{span:2,h:520},{span:2,h:720},{span:2,h:900}],
  "tile-insights": [{span:1,h:360},{span:1,h:480},{span:2,h:480}],
  "tile-company":  [{span:1,h:260},{span:1,h:360},{span:1,h:460}],
  "tile-news":     [{span:1,h:360},{span:1,h:520},{span:2,h:520}],
  "tile-movers":   [{span:1,h:320},{span:1,h:420},{span:2,h:420}],
  "tile-marketnews":[{span:1,h:320},{span:1,h:420},{span:2,h:420}],
};
function applyPreset(card, preset){
  card.style.height = preset.h + "px";
  card.classList.toggle('span-2', preset.span===2);
  card.dataset.span = String(preset.span);
  // trigger canvas redraws if needed
  if(card.id==="tile-insights"){ drawSeasonals(lastSeasonals); drawGauge(lastSentiment); }
}
function nearestPreset(card, w, h){
  const list = SIZE_PRESETS[card.id] || [{span:1,h:320}];
  // width → span guess from current list & grid
  const gridW=gridRoot.clientWidth, gap=14, colW=(gridW-gap)/2;
  const wantSpan = (w > colW*1.25) ? 2 : 1;
  // choose those matching span (or any if none)
  const candidates = list.filter(p=>p.span===wantSpan) || list;
  // pick by height nearest
  let best=candidates[0], bestd=1e9;
  for(const p of candidates){
    const d=Math.abs(p.h - h);
    if(d<bestd){ bestd=d; best=p; }
  }
  return best;
}

// header-only drag & preset resize with ghost
(function(){
  const orderKey='mt_tile_order';
  const saved=JSON.parse(localStorage.getItem(orderKey)||'[]');
  if(saved.length){ saved.forEach(id=>{ const el=document.getElementById(id); if(el) gridRoot.appendChild(el); }); }

  let dragEl=null, placeholder=null;

  // Drag only when header is dragged
  gridRoot.addEventListener('dragstart', e=>{
    const header=e.target.closest('.card-hd[draggable="true"]');
    if(!header){ e.preventDefault(); return; }
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
    // snap span when placed on right column
    const colIndex=[...gridRoot.children].indexOf(dragEl)%2;
    if(colIndex===1){
      const list=SIZE_PRESETS[dragEl.id]||[{span:1,h:320}];
      const first1=list.find(p=>p.span===1) || list[0];
      applyPreset(dragEl, first1);
    }
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

  // Resizing → snap to preset
  const cards=[...document.querySelectorAll('.resizable')];
  let outline=null;
  cards.forEach(card=>{
    const handle=card.querySelector('.resize-handle'); if(!handle) return;
    let startX=0,startY=0,startW=0,startH=0;
    handle.addEventListener('pointerdown',(e)=>{
      startX=e.clientX; startY=e.clientY;
      const rect=card.getBoundingClientRect(); startW=rect.width; startH=rect.height;
      card.classList.add('resizing');
      outline=document.createElement('div'); outline.className='resize-outline';
      outline.style.left=rect.left+'px'; outline.style.top=rect.top+'px';
      outline.style.width=rect.width+'px'; outline.style.height=rect.height+'px';
      document.body.appendChild(outline);
      const onMove=(ev)=>{
        const dx=ev.clientX-startX, dy=ev.clientY-startY;
        const curW=Math.max(280, startW+dx), curH=Math.max(180, startH+dy);
        const p=nearestPreset(card, curW, curH);
        const rect2=card.getBoundingClientRect();
        outline.style.left=rect2.left+'px';
        outline.style.top=rect2.top+'px';
        // preview size: translate preset span into width
        const gridW=gridRoot.clientWidth, gap=14, colW=(gridW-gap)/2;
        const w=(p.span===2)?(2*colW+gap):colW;
        outline.style.width=w+'px'; outline.style.height=p.h+'px';
      };
      const onUp=(ev)=>{
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        card.classList.remove('resizing');
        const dx=ev.clientX-startX, dy=ev.clientY-startY;
        const p=nearestPreset(card, Math.max(280,startW+dx), Math.max(180,startH+dy));
        applyPreset(card, p);
        if(outline){ document.body.removeChild(outline); outline=null; }
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  });
})();

// ---------- TradingView ----------
const TV_EXCHANGE={
  AAPL:"NASDAQ",MSFT:"NASDAQ",NVDA:"NASDAQ",AMZN:"NASDAQ",META:"NASDAQ",GOOGL:"NASDAQ",TSLA:"NASDAQ",AVGO:"NASDAQ",AMD:"NASDAQ",NFLX:"NASDAQ",ADBE:"NASDAQ",
  INTC:"NASDAQ",CSCO:"NASDAQ",QCOM:"NASDAQ",TXN:"NASDAQ",CRM:"NYSE",PYPL:"NASDAQ",SHOP:"NYSE",ABNB:"NASDAQ",SNOW:"NYSE",
  JPM:"NYSE",BAC:"NYSE",WFC:"NYSE",GS:"NYSE",MS:"NYSE",V:"NYSE",MA:"NYSE",AXP:"NYSE","BRK-B":"NYSE",
  KO:"NYSE",PEP:"NASDAQ",PG:"NYSE",MCD:"NYSE",COST:"NASDAQ",HD:"NYSE",LOW:"NYSE",DIS:"NYSE",NKE:"NYSE",
  XOM:"NYSE",CVX:"NYSE",CAT:"NYSE",BA:"NYSE",UNH:"NYSE",LLY:"NYSE",MRK:"NYSE",ABBV:"NYSE",UPS:"NYSE",FDX:"NYSE",ORCL:"NYSE",IBM:"NYSE",UBER:"NYSE",LYFT:"NASDAQ",
  "^IXIC":"NASDAQ","^GSPC":"SP"
};
function toTV(symbol){
  if(symbol.startsWith("^")){
    const ex=TV_EXCHANGE[symbol]||"NASDAQ";
    const clean = symbol.replace("^","");
    // ^GSPC → SP:SPX ; ^IXIC → NASDAQ:IXIC
    if(symbol==="^GSPC") return "SP:SPX";
    if(symbol==="^IXIC") return "NASDAQ:IXIC";
    return `${ex}:${clean}`;
  }
  const ex = TV_EXCHANGE[symbol] || "NASDAQ";
  return `${ex}:${symbol}`;
}
function mountTradingView(symbol){
  chartTitle.textContent=`Chart – ${symbol}`;
  tvContainer.innerHTML="";
  if(typeof TradingView==="undefined"||!TradingView.widget){
    const warn=document.createElement("div"); warn.className="muted"; warn.textContent="TradingView failed to load."; tvContainer.appendChild(warn); return;
  }
  const theme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';
  new TradingView.widget({symbol:toTV(symbol), interval:'60', timezone:'Etc/UTC', theme, style:'1', toolbar_bg:'transparent', locale:'en', enable_publishing:false, allow_symbol_change:false, container_id:'tv_container', autosize:true});
}

// ---------- Helpers ----------
const fmtPrice=v=>(typeof v==='number'&&isFinite(v))?v.toFixed(2):'—';
const fmtChange=v=>(v==null||!isFinite(v))?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el,v){ el.className='chg '+(v>0?'pos':(v<0?'neg':'neu')); }

// ---------- Tickers ----------
const tickerNodes=new Map();
function renderTicker(items){
  if(!Array.isArray(items)||!items.length){
    items=[{symbol:"TSLA",price:null,change_pct:null},{symbol:"AAPL",price:null,change_pct:null},{symbol:"MSFT",price:null,change_pct:null}];
  }
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
  requestAnimationFrame(()=>tickerScroll.classList.add('marquee-ready'));
  if(!currentSymbol) onSymbolSelect(items[0].symbol);
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
    const r=await fetch(TICKER_ENDPOINT); const data=await r.json();
    if(!tickerScroll.childElementCount) renderTicker(data);
    else updateTicker(data);
  }catch(e){ /* keep old */ }
}

// ---------- Movers ----------
function renderMovers(movers){
  const fill=(tbody,arr)=>{ tbody.innerHTML=''; if(!Array.isArray(arr)||!arr.length){tbody.innerHTML='<tr><td class="muted">No data</td></tr>'; return;}
    arr.forEach(r=>{ const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.addEventListener('click',()=>onSymbolSelect(r.symbol)); tbody.appendChild(tr); });
  };
  fill(gainersBody, movers.gainers||[]); fill(losersBody, movers.losers||[]);
}
async function loadMovers(){ try{ const r=await fetch(MOVERS_ENDPOINT); renderMovers(await r.json()); }catch{ renderMovers({gainers:[],losers:[]}); } }

// ---------- Company ----------
async function loadCompany(symbol){
  try{
    const r=await fetch(`/api/profile?symbol=${encodeURIComponent(symbol)}`);
    const p=await r.json();
    companyBox.innerHTML=`<div class="co-name"><b>${p.name||symbol}</b> <span class="muted">(${symbol})</span></div><p class="co-desc">${p.description||''}</p>`;
  }catch{ companyBox.innerHTML='<div class="muted">No description available.</div>'; }
}

// ---------- Insights: performance, seasonals (fit), sentiment gauge ----------
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
  lastSeasonals=seasonals;
  // fit to card body width/height
  const wrap=seasonalsCanvas.parentElement;
  const W=wrap.clientWidth-8, H=Math.max(160, Math.min(360, wrap.clientHeight-60));
  seasonalsCanvas.width=W; seasonalsCanvas.height=H;
  sctx.clearRect(0,0,W,H);
  if(!seasonals) return;

  const theme=document.documentElement.getAttribute('data-theme');
  const gridColor = theme==='light' ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.08)';
  const axisColor = theme==='light' ? '#333' : '#ddd';
  const colors = {"2025":"#3b82f6","2024":"#22c55e","2023":"#f59e0b"};

  const keys=Object.keys(seasonals||{}).sort().reverse().slice(0,3);
  if(!keys.length) return;

  let minX=366,maxX=0,minY=0,maxY=0;
  keys.forEach(k=>{ (seasonals[k]||[]).forEach(([x,y])=>{ minX=Math.min(minX,x); maxX=Math.max(maxX,x); minY=Math.min(minY,y); maxY=Math.max(maxY,y); }); });
  if(minY===maxY){ minY-=1; maxY+=1; }

  const pad=28;
  const xScale=(x)=> pad + (x-minX)/(maxX-minX||1)*(W-2*pad);
  const yScale=(y)=> H-pad - (y-minY)/(maxY-minY||1)*(H-2*pad);

  // grid
  sctx.strokeStyle=gridColor; sctx.lineWidth=1; sctx.beginPath();
  [0.25,0.5,0.75].forEach(f=>{ const x=pad+f*(W-2*pad); sctx.moveTo(x,pad); sctx.lineTo(x,H-pad); });
  sctx.stroke();

  // axis
  sctx.strokeStyle=axisColor; sctx.lineWidth=1.2; sctx.beginPath();
  sctx.moveTo(pad,H-pad); sctx.lineTo(W-pad,H-pad); sctx.stroke();

  // series
  keys.forEach(k=>{
    const pts=seasonals[k]||[]; if(!pts.length) return;
    sctx.strokeStyle=colors[k]||'#aaa'; sctx.lineWidth=2; sctx.beginPath();
    pts.forEach(([x,y],i)=>{ const X=xScale(x), Y=yScale(y); if(i===0) sctx.moveTo(X,Y); else sctx.lineTo(X,Y); });
    sctx.stroke();
  });
}
function drawGauge(compound){
  lastSentiment=compound;
  const W=sentiGauge.clientWidth, H=sentiGauge.clientHeight;
  sentiGauge.width=W; sentiGauge.height=H;
  gctx.clearRect(0,0,W,H);

  const cx=W/2, cy=H-10, r=Math.min(W*0.46, H*0.95);
  // arc background
  gctx.lineWidth=12;
  const grad=gctx.createLinearGradient(cx-r,0,cx+r,0);
  grad.addColorStop(0,'#ff5a5f'); grad.addColorStop(0.5,'#ffd166'); grad.addColorStop(1,'#2ecc71');
  gctx.strokeStyle=grad;
  gctx.beginPath(); gctx.arc(cx,cy,r,Math.PI,0,false); gctx.stroke();

  // needle
  const t=(compound+1)/2; // 0..1
  const ang=Math.PI*(1-t); // left=π (bear) → right=0 (bull)
  const nx=cx + (r-8)*Math.cos(ang);
  const ny=cy + (r-8)*Math.sin(ang);
  gctx.strokeStyle = document.documentElement.getAttribute('data-theme')==='light'?'#111':'#eee';
  gctx.lineWidth=3.5;
  gctx.beginPath(); gctx.moveTo(cx,cy); gctx.lineTo(nx,ny); gctx.stroke();
  gctx.beginPath(); gctx.arc(cx,cy,5,0,Math.PI*2); gctx.fillStyle=gctx.strokeStyle; gctx.fill();
}
async function loadInsights(symbol){
  insightsTitle.textContent=`Market Insights: ${symbol}`;
  renderPerf(null); drawSeasonals(null); drawGauge(0);
  try{
    const r=await fetch(`${METRICS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const m=await r.json();
    renderPerf(m.performance);
    drawSeasonals(m.seasonals||{});
  }catch{}
  try{
    const r=await fetch(`${SENTI_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const s=await r.json();
    drawGauge(typeof s.compound==='number'?s.compound:0);
  }catch{ drawGauge(0); }
}

// Observe size changes on insights to redraw canvases
new ResizeObserver(()=>{ drawSeasonals(lastSeasonals); drawGauge(lastSentiment); })
  .observe(document.querySelector('#tile-insights .card-body'));

// ---------- News ----------
function renderNews(container, articles, limit){
  container.innerHTML=''; if(!Array.isArray(articles)||!articles.length){ container.innerHTML='<div class="muted">No headlines.</div>'; return; }
  articles.slice(0,limit).forEach(n=>{ const item=document.createElement('div'); item.className='news-item';
    const a=document.createElement('a'); a.href=n.url||'#'; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=n.title||'(untitled)';
    const meta=document.createElement('div'); meta.className='muted'; const src=n.source||'Unknown'; const ts=n.published_at||''; meta.textContent=`${src}${ts?` · ${ts}`:''}`;
    item.append(a,meta); container.appendChild(item); });
}
async function loadNews(symbol){
  newsList.innerHTML='<div class="fallback-note">Loading news…</div>';
  try{
    const r=await fetch(`${NEWS_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`); const data=await r.json();
    renderNews(newsList, data, newsExpanded?30:8); newsMoreBtn.style.display=(Array.isArray(data)&&data.length>8)?'inline-flex':'none';
    newsMoreBtn.textContent=newsExpanded?'View less':'View more';
    newsMoreBtn.onclick=()=>{ newsExpanded=!newsExpanded; renderNews(newsList, data, newsExpanded?30:8); newsMoreBtn.textContent=newsExpanded?'View less':'View more'; };
  }catch{ newsList.innerHTML='<div class="muted">Failed to load news.</div>'; newsMoreBtn.style.display='none'; }
}
async function loadMarketNews(){
  marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>';
  try{
    const r=await fetch(MKT_NEWS_ENDPOINT); const data=await r.json();
    renderNews(marketNewsList, data, marketNewsExpanded?30:6); marketNewsMoreBtn.style.display=(Array.isArray(data)&&data.length>6)?'inline-flex':'none';
    marketNewsMoreBtn.textContent=marketNewsExpanded?'View less':'View more';
    marketNewsMoreBtn.onclick=()=>{ marketNewsExpanded=!marketNewsExpanded; renderNews(marketNewsList, data, marketNewsExpanded?30:6); marketNewsMoreBtn.textContent=marketNewsExpanded?'View less':'View more'; };
  }catch{ marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; marketNewsMoreBtn.style.display='none'; }
}

// ---------- Selection ----------
async function onSymbolSelect(symbol){
  currentSymbol=symbol;
  mountTradingView(symbol);
  await Promise.all([
    loadCompany(symbol),
    loadInsights(symbol),
    loadNews(symbol)
  ]);
}

// ---------- Boot ----------
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 60_000);
  loadMovers();  setInterval(loadMovers,  60_000);
  loadMarketNews(); setInterval(loadMarketNews, 180_000);
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('TSLA'); }, 600);
});
