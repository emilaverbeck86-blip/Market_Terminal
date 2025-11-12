// Stable quotes, non-buggy drag/resize, black/white UI.

const ENDPOINTS={
  tickers:"/api/tickers", movers:"/api/movers", profile:"/api/profile",
  metrics:"/api/metrics", news:"/api/news", mktnews:"/api/market-news",
  sentiment:"/api/sentiment"
};

const $ = id => document.getElementById(id);
const tickerScroll=$('tickerScroll'), tvContainer=$('tv_container'), chartTitle=$('chartTitle');
const newsList=$('newsList'), marketNewsList=$('marketNewsList');
const gainersBody=$('gainersBody'), losersBody=$('losersBody'), companyBox=$('companyBox');
const gridRoot=$('gridRoot'), themeToggle=$('themeToggle'), settingsBtn=$('settingsBtn'), settingsMenu=$('settingsMenu');
const nasdaqBtn=$('btnNasdaq'), spxBtn=$('btnSPX');
const perfGrid=$('perfGrid'), seasonalsCanvas=$('seasonalsCanvas'), insightsTitle=$('insightsTitle');
const gaugeCanvas=$('gaugeCanvas'), gctx=gaugeCanvas.getContext('2d'), gaugeLabel=$('gaugeLabel');

let currentSymbol=null, currentTVOverride=null, lastSeasonals=null, lastCompound=0;

function fetchJSON(url, {timeout=12000, params}={}){
  const ctrl=new AbortController();
  const id=setTimeout(()=>ctrl.abort(), timeout);
  const full=params?`${url}?${new URLSearchParams(params)}`:url;
  return fetch(full,{signal:ctrl.signal}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).finally(()=>clearTimeout(id));
}
const fmtPrice=v=>(typeof v==='number'&&isFinite(v))?v.toFixed(2):'—';
const fmtChange=v=>(v==null||!isFinite(v))?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el,v){el.className='chg '+(v>0?'pos':(v<0?'neg':'neu'));}

// THEME + SETTINGS
(()=>{let open=false;const close=()=>{settingsMenu.classList.remove('open');open=false;};
settingsBtn.addEventListener('click',e=>{e.stopPropagation();open=!open;settingsMenu.classList.toggle('open',open);});
document.addEventListener('click',e=>{if(!open)return;if(!settingsMenu.contains(e.target)&&e.target!==settingsBtn)close();});
const saved=localStorage.getItem('mt_theme')||'dark';document.documentElement.setAttribute('data-theme',saved);
themeToggle.checked=(saved==='light');themeToggle.addEventListener('change',()=>{const t=themeToggle.checked?'light':'dark';
document.documentElement.setAttribute('data-theme',t);localStorage.setItem('mt_theme',t);if(currentSymbol)mountTradingView(currentSymbol,currentTVOverride);drawSeasonals(lastSeasonals);drawGauge(lastCompound);});})();

// DRAG (header only)
(()=>{const key='mt_tile_order';const saved=JSON.parse(localStorage.getItem(key)||'[]');if(saved.length){saved.forEach(id=>{const el=$(id);if(el)gridRoot.appendChild(el);});}
let dragEl=null, ph=null;
gridRoot.addEventListener('dragstart',e=>{const hd=e.target.closest('.card-hd[draggable="true"]');if(!hd){e.preventDefault();return;}
dragEl=hd.parentElement;dragEl.classList.add('dragging');ph=document.createElement('section');ph.className='placeholder card';ph.style.height=`${dragEl.getBoundingClientRect().height}px`;dragEl.after(ph);});
gridRoot.addEventListener('dragover',e=>{if(!dragEl)return;e.preventDefault();const after=getAfter(gridRoot,e.clientY);if(after==null)gridRoot.appendChild(ph);else gridRoot.insertBefore(ph,after);});
gridRoot.addEventListener('dragend',()=>{if(!dragEl)return;dragEl.classList.remove('dragging');if(ph){ph.replaceWith(dragEl);ph=null;}const ids=[...gridRoot.querySelectorAll('.card')].map(n=>n.id);localStorage.setItem(key,JSON.stringify(ids));dragEl=null;});
function getAfter(c,y){const els=[...c.querySelectorAll('.card:not(.dragging)')];return els.reduce((cl,ch)=>{const b=ch.getBoundingClientRect();const off=y-b.top-b.height/2;if(off<0&&off>cl.offset){return {offset:off,element:ch};}return cl;},{offset:-1e9}).element;}})();

// SNAP RESIZE (3 presets; accurate preview)
(()=>{const GAP=14, ROW_UNIT=90; function colW(){return (gridRoot.clientWidth-GAP)/2;}
const cards=[...document.querySelectorAll('.resizable')];let outline=null;
cards.forEach(card=>{const h=card.querySelector('.resize-handle');if(!h)return;const presets=(card.dataset.allowed||"1x3,1x4,2x3,2x4").split(",").map(t=>{const [c,r]=t.split("x").map(Number);return{c,r};});
let startRect=null,startX=0,startY=0;const onMove=e=>{const dx=e.clientX-startX,dy=e.clientY-startY;const estW=Math.max(280,startRect.width+dx),estH=Math.max(180,startRect.height+dy);
const estC=(estW>colW()*1.25)?2:1;const estR=Math.max(2,Math.round(estH/ROW_UNIT));let best=presets[0],dmin=1e9;presets.forEach(p=>{const d=Math.abs(p.c-estC)*3+Math.abs(p.r-estR);if(d<dmin){dmin=d;best=p;}});
const tW=best.c===2?(colW()*2+GAP):colW();const tH=best.r*ROW_UNIT;outline.style.width=`${tW}px`;outline.style.height=`${tH}px`;};
const onUp=()=>{document.removeEventListener('pointermove',onMove);document.removeEventListener('pointerup',onUp);const ow=parseFloat(outline.style.width),oh=parseFloat(outline.style.height);
const cols=(ow>colW()*1.25)?2:1;const rows=Math.max(2,Math.round(oh/ROW_UNIT));card.classList.toggle('span-2',cols===2);card.className=card.className.replace(/\brow-\d+\b/g,'').trim();card.classList.add(`row-${rows}`);
document.body.removeChild(outline);outline=null;card.classList.remove('resizing');drawSeasonals(lastSeasonals);};
h.addEventListener('pointerdown',e=>{startRect=card.getBoundingClientRect();startX=e.clientX;startY=e.clientY;card.classList.add('resizing');outline=document.createElement('div');outline.className='resize-outline';
outline.style.left=`${startRect.left}px`;outline.style.top=`${startRect.top}px`;outline.style.width=`${startRect.width}px`;outline.style.height=`${startRect.height}px`;document.body.appendChild(outline);
document.addEventListener('pointermove',onMove,{passive:false});document.addEventListener('pointerup',onUp,{passive:false});});});})();

// TRADINGVIEW
const TV_EXCHANGE={AAPL:"NASDAQ",MSFT:"NASDAQ",NVDA:"NASDAQ",AMZN:"NASDAQ",META:"NASDAQ",GOOGL:"NASDAQ",TSLA:"NASDAQ",AVGO:"NASDAQ",AMD:"NASDAQ",NFLX:"NASDAQ",ADBE:"NASDAQ",INTC:"NASDAQ",CSCO:"NASDAQ",QCOM:"NASDAQ",TXN:"NASDAQ",CRM:"NYSE",ORCL:"NYSE",IBM:"NYSE",NOW:"NYSE",SNOW:"NYSE",ABNB:"NASDAQ",SHOP:"NYSE",PYPL:"NASDAQ",JPM:"NYSE",BAC:"NYSE",WFC:"NYSE",GS:"NYSE",MS:"NYSE",V:"NYSE",MA:"NYSE",AXP:"NYSE","BRK-B":"NYSE",SCHW:"NYSE",KO:"NYSE",PEP:"NASDAQ",PG:"NYSE",MCD:"NYSE",COST:"NASDAQ",HD:"NYSE",LOW:"NYSE",DIS:"NYSE",NKE:"NYSE",SBUX:"NASDAQ",TGT:"NYSE",WMT:"NYSE",T:"NYSE",VZ:"NYSE",CMCSA:"NASDAQ",XOM:"NYSE",CVX:"NYSE",COP:"NYSE",CAT:"NYSE",BA:"NYSE",GE:"NYSE",UPS:"NYSE",FDX:"NYSE",DE:"NYSE",UNH:"NYSE",LLY:"NYSE",MRK:"NYSE",ABBV:"NYSE",JNJ:"NYSE",PFE:"NYSE",UBER:"NYSE",LYFT:"NASDAQ",BKNG:"NASDAQ",SPY:"AMEX",QQQ:"NASDAQ",DIA:"AMEX",IWM:"AMEX"};
const toTV=s=>`${(TV_EXCHANGE[s]||'NASDAQ')}:${s}`;
function mountTradingView(symbol, tvOverride=null){
  chartTitle.textContent=`Chart – ${symbol}`;
  tvContainer.innerHTML="";
  if(typeof TradingView==="undefined"||!TradingView.widget){const w=document.createElement('div');w.className='muted';w.textContent='TradingView failed to load.';tvContainer.appendChild(w);return;}
  const theme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';
  new TradingView.widget({symbol: tvOverride||toTV(symbol), interval:'60', timezone:'Etc/UTC', theme, style:'1',
    toolbar_bg:'transparent', locale:'en', enable_publishing:false, allow_symbol_change:false, container_id:'tv_container', autosize:true});
}

// TICKER BAR
const tmap=new Map();
function renderTicker(items){
  tickerScroll.innerHTML=''; tmap.clear();
  const twice=[...items,...items];
  twice.forEach(tk=>{
    const el=document.createElement('div'); el.className='ticker-item'; el.dataset.sym=tk.symbol;
    const s=document.createElement('span'); s.className='sym'; s.textContent=tk.symbol;
    const p=document.createElement('span'); p.className='price'; p.textContent=fmtPrice(tk.price);
    const c=document.createElement('span'); c.className='chg'; applyChangeClass(c, tk.change_pct); c.textContent=fmtChange(tk.change_pct);
    el.append(s,p,c); el.addEventListener('click',()=>onSymbolSelect(tk.symbol)); tickerScroll.appendChild(el);
    if(!tmap.has(tk.symbol)) tmap.set(tk.symbol,{el, p, c, last:tk.price});
  });
  if(items.length && !currentSymbol) onSymbolSelect(items[0].symbol);
}
function updateTicker(items){
  items.forEach(tk=>{
    const n=tmap.get(tk.symbol); if(!n) return;
    const newP=fmtPrice(tk.price);
    if(newP!==n.p.textContent){ const up=((tk.price||0)>(n.last||0)); n.el.classList.remove('flash-up','flash-down'); void n.el.offsetWidth;
      n.el.classList.add(up?'flash-up':'flash-down'); setTimeout(()=>n.el.classList.remove('flash-up','flash-down'),600); n.p.textContent=newP; n.last=tk.price; }
    applyChangeClass(n.c, tk.change_pct); n.c.textContent=fmtChange(tk.change_pct);
  });
}
async function loadTickers(){
  try{
    const data=await fetchJSON(ENDPOINTS.tickers); if(!tickerScroll.childElementCount) renderTicker(data); else updateTicker(data);
  }catch(e){ if(!tickerScroll.childElementCount) tickerScroll.innerHTML='<div class="muted">tickers unavailable</div>'; console.error(e); }
}

// MOVERS
function renderMovers(m){
  const draw=(tb,arr)=>{ tb.innerHTML=''; if(!arr||!arr.length){tb.innerHTML='<tr><td class="muted">No data</td></tr>';return;}
    arr.forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.style.cursor='pointer'; tr.addEventListener('click',()=>onSymbolSelect(r.symbol)); tb.appendChild(tr); }); };
  draw(gainersBody,m.gainers); draw(losersBody,m.losers);
}
async function loadMovers(){ try{ renderMovers(await fetchJSON(ENDPOINTS.movers)); }catch(e){ console.error(e); } }

// COMPANY
async function loadCompany(symbol){
  try{ const p=await fetchJSON(ENDPOINTS.profile,{params:{symbol}}); companyBox.innerHTML=`<div class="co-name"><b>${p.name||symbol}</b> <span class="muted">(${symbol})</span></div><p class="co-desc">${p.description||''}</p>`; }
  catch{ companyBox.innerHTML='<div class="muted">No profile available at this time.</div>'; }
}

// INSIGHTS
function renderPerf(perf){ const labels=["1W","1M","3M","6M","YTD","1Y"]; perfGrid.innerHTML='';
  labels.forEach(k=>{ const v=perf?perf[k]:null; const d=document.createElement('div'); d.className='perf-box '+(v>0?'pos':(v<0?'neg':'neu'));
    d.innerHTML=`<div class="p-val">${(v==null)?'—':`${v>0?'+':''}${v.toFixed(2)}%`}</div><div class="p-lbl">${k}</div>`; perfGrid.appendChild(d); });}
function drawSeasonals(seasonals){ lastSeasonals=seasonals||{}; const par=seasonalsCanvas.parentElement; const W=Math.max(320,par.clientWidth-8), H=Math.max(140,par.clientHeight-36);
  const ctx=seasonalsCanvas.getContext('2d'); seasonalsCanvas.width=W; seasonalsCanvas.height=H; ctx.clearRect(0,0,W,H);
  const keys=Object.keys(lastSeasonals).sort().reverse().slice(0,3); if(!keys.length)return;
  const grid='rgba(255,255,255,.08)', axis='#ddd', colors={"2025":"#fff","2024":"#aaa","2023":"#666"};
  let minX=1,maxX=1,minY=0,maxY=0; keys.forEach(k=>(lastSeasonals[k]||[]).forEach(([x,y])=>{minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);})); if(minY===maxY){minY-=1;maxY+=1;}
  const pad=28, xS=x=>pad+(x-minX)/(maxX-minX||1)*(W-2*pad), yS=y=>H-pad-(y-minY)/(maxY-minY||1)*(H-2*pad);
  ctx.strokeStyle=grid; ctx.beginPath(); [0.25,0.5,0.75].forEach(f=>{const x=pad+f*(W-2*pad); ctx.moveTo(x,pad); ctx.lineTo(x,H-pad);}); ctx.stroke();
  ctx.strokeStyle=axis; ctx.beginPath(); ctx.moveTo(pad,H-pad); ctx.lineTo(W-pad,H-pad); ctx.stroke();
  keys.forEach(k=>{ const pts=lastSeasonals[k]||[]; if(!pts.length) return; const c=colors[k]; ctx.strokeStyle=c; ctx.lineWidth=2; ctx.beginPath();
    pts.forEach(([x,y],i)=>{const X=xS(x),Y=yS(y); if(i===0)ctx.moveTo(X,Y); else ctx.lineTo(X,Y);}); ctx.stroke();}); }
new ResizeObserver(()=>drawSeasonals(lastSeasonals)).observe(seasonalsCanvas.parentElement);

function drawGauge(comp=0){ lastCompound=comp; const W=gaugeCanvas.clientWidth,H=gaugeCanvas.clientHeight; gaugeCanvas.width=W; gaugeCanvas.height=H;
  const c=gctx; c.clearRect(0,0,W,H); const cx=W/2, cy=H*0.95, r=Math.min(W,H*1.9)/2-8;
  const g=c.createLinearGradient(cx-r,0,cx+r,0); g.addColorStop(0,"#ff4d4d"); g.addColorStop(0.5,"#bbb"); g.addColorStop(1,"#35d07f");
  c.lineWidth=10; c.strokeStyle=g; c.beginPath(); c.arc(cx,cy,r,Math.PI,2*Math.PI); c.stroke();
  const angle=Math.PI+(comp+1)*Math.PI/2; const nx=cx+(r-6)*Math.cos(angle), ny=cy+(r-6)*Math.sin(angle);
  c.strokeStyle='#fff'; c.lineWidth=3; c.beginPath(); c.moveTo(cx,cy); c.lineTo(nx,ny); c.stroke(); c.beginPath(); c.arc(cx,cy,4,0,2*Math.PI); c.fillStyle='#fff'; c.fill();
  let label='Neutral'; if(comp>0.05)label=`Bullish ${(comp*100).toFixed(0)}%`; else if(comp<-0.05)label=`Bearish ${Math.abs(comp*100).toFixed(0)}%`; gaugeLabel.textContent=label; }

async function loadInsights(symbol){
  insightsTitle.textContent=`Market Insights: ${symbol}`; renderPerf(null); drawSeasonals(null); drawGauge(0);
  try{ const m=await fetchJSON(ENDPOINTS.metrics,{params:{symbol}}); renderPerf(m.performance); drawSeasonals(m.seasonals||{}); }catch(e){ console.error(e); }
  try{ const s=await fetchJSON(ENDPOINTS.sentiment,{params:{symbol}}); drawGauge(typeof s.compound==='number'?s.compound:0); }catch(e){ console.error(e); }
}

// NEWS
function renderNews(container, items){ container.innerHTML=''; if(!items||!items.length){container.innerHTML='<div class="muted">No headlines.</div>';return;}
  items.forEach(n=>{const it=document.createElement('div');it.className='news-item';const a=document.createElement('a');a.href=n.url||'#';a.target='_blank';a.rel='noopener noreferrer';a.textContent=n.title||'(untitled)';
    const meta=document.createElement('div');meta.className='muted';meta.textContent=`${n.source||'News'}${n.published_at?` · ${n.published_at}`:''}`;it.append(a,meta);container.appendChild(it);});}
async function loadNews(symbol){ newsList.innerHTML='<div class="fallback-note">Loading news…</div>'; try{renderNews(newsList, await fetchJSON(ENDPOINTS.news,{params:{symbol}}));}catch{newsList.innerHTML='<div class="muted">Failed to load news.</div>';}}
async function loadMarketNews(){ marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>'; try{renderNews(marketNewsList, await fetchJSON(ENDPOINTS.mktnews));}catch{marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; }}

// SELECT
async function onSymbolSelect(symbol, tvOverride=null){
  currentSymbol=symbol; currentTVOverride=tvOverride; mountTradingView(symbol, tvOverride);
  await Promise.allSettled([ loadCompany(symbol), loadInsights(symbol), loadNews(symbol) ]);
}

// SHORTCUTS
nasdaqBtn.addEventListener('click', ()=> onSymbolSelect('QQQ', 'NASDAQ:IXIC'));
spxBtn.addEventListener('click', ()=> onSymbolSelect('SPY',  'TVC:SPX'));

// BOOT
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 45000);
  loadMovers();  setInterval(loadMovers,  60000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('AAPL'); }, 700);
});

// surface any JS errors quickly
window.addEventListener('error', e=>console.error('JS error:', e.message, e.filename, e.lineno));
