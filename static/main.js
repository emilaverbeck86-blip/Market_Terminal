// endpoints
const API={tickers:'/api/tickers', movers:'/api/movers', metrics:'/api/metrics', news:'/api/news', mktnews:'/api/market-news'};
const $=id=>document.getElementById(id);

// DOM
const tickerWrap=$('tickerWrap'), tickerTrack=$('tickerTrack');
const tvContainer=$('tv_container'), chartTitle=$('chartTitle');
const perfGrid=$('perfGrid'), coDesc=$('coDesc'), insightsTitle=$('insightsTitle');
const newsList=$('newsList'), marketNewsList=$('marketNewsList');
const gainersBody=$('gainersBody'), losersBody=$('losersBody');
const board=$('board'), themeToggle=$('themeToggle'), settingsBtn=$('settingsBtn'), settingsMenu=$('settingsMenu');
const spxBtn=$('btnSPX'), ndxBtn=$('btnNasdaq');

let currentSymbol=null, tvOverride=null;

// ---- helpers
function fetchJSON(u,{params,timeout=12000}={}){const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),timeout);const url=params?`${u}?${new URLSearchParams(params)}`:u;
  return fetch(url,{signal:ctl.signal}).then(r=>{if(!r.ok) throw new Error(r.status); return r.json();}).finally(()=>clearTimeout(t));}
const fmt=(v)=>v==null||!isFinite(v)?'—':v.toFixed(2);
const fmtPct=(v)=>v==null||!isFinite(v)?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function clsFor(v){return v>0?'pos':(v<0?'neg':'neu');}

// ==== SETTINGS / THEME / TILE TOGGLES ====
(()=>{
  let open=false; const close=()=>{settingsMenu.classList.remove('open');open=false;};
  settingsBtn.addEventListener('click',e=>{e.stopPropagation();open=!open;settingsMenu.classList.toggle('open',open);});
  document.addEventListener('click',e=>{if(open && !settingsMenu.contains(e.target) && e.target!==settingsBtn) close();});

  const saved=localStorage.getItem('mt_theme')||'dark';
  document.documentElement.setAttribute('data-theme',saved);
  themeToggle.checked=(saved==='light');
  themeToggle.addEventListener('change',()=>{
    const t=themeToggle.checked?'light':'dark';
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem('mt_theme',t);
    if(currentSymbol) mountTV(currentSymbol,tvOverride);
  });

  // tile visibility
  const vis=JSON.parse(localStorage.getItem('mt_tiles')||'{}');
  document.querySelectorAll('.tile-toggle').forEach(chk=>{
    if(vis.hasOwnProperty(chk.dataset.target)) chk.checked=!!vis[chk.dataset.target];
    const el=$(chk.dataset.target); if(el) el.style.display=chk.checked?'':'none';
    chk.addEventListener('change',()=>{
      const conf={}; document.querySelectorAll('.tile-toggle').forEach(c=>conf[c.dataset.target]=c.checked);
      localStorage.setItem('mt_tiles',JSON.stringify(conf));
      const el=$(chk.dataset.target); if(el) el.style.display=chk.checked?'':'none';
      reflowBoard(); saveLayout();
    });
  });
})();

// ==== QUICK SHORTCUTS (TV-reliable) ====
spxBtn.addEventListener('click', ()=> onSelect('SPY', 'CAPITALCOM:US500'));    // capital.com US500
ndxBtn.addEventListener('click', ()=> onSelect('QQQ', 'OANDA:NAS100USD'));     // NAS100

// ==== BOARD LAYOUT (two-lane, snap, save/restore) ====
const LAYOUT_KEY='mt_layout_v2';
function getLaneWidthPercent(){
  const left = document.querySelector('.lane-left'); if(!left) return 60;
  const wrap = board.getBoundingClientRect(); const w = left.getBoundingClientRect().width;
  return Math.max(30, Math.min(85, Math.round((w / wrap.width)*100)));
}
function setLaneWidths(pct){
  const leftW = `${pct}%`; const rightW = `${100-pct-2}%`; // keep small gap
  document.querySelectorAll('.lane-left').forEach(n=>n.style.width=leftW);
  document.querySelectorAll('.lane-right').forEach(n=>n.style.width=rightW);
}
function saveLayout(){
  const lanes=[...board.children].filter(n=>n.classList.contains('movable')).map(n=>({
    id:n.id, lane:n.classList.contains('lane-right')?'right':'left', h:n.style.height||'', w:n.style.width||''
  }));
  const pct=getLaneWidthPercent();
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({pct, lanes}));
}
function restoreLayout(){
  try{
    const st=JSON.parse(localStorage.getItem(LAYOUT_KEY)||'{}');
    if(st.pct) setLaneWidths(st.pct);
    if(st.lanes && Array.isArray(st.lanes)){
      // order by original but set lanes/sizes
      st.lanes.forEach(cfg=>{
        const el=$(cfg.id); if(!el) return;
        el.classList.toggle('lane-right', cfg.lane==='right'); el.classList.toggle('lane-left', cfg.lane!=='right');
        if(cfg.w) el.style.width=cfg.w; if(cfg.h) el.style.height=cfg.h;
        board.appendChild(el);
      });
    }
  }catch{}
}
function reflowBoard(){
  // ensure both lanes fill screen widths
  const pct = getLaneWidthPercent(); setLaneWidths(pct);
}

(function initDragMove(){
  let dragging=null, placeholder=null;
  board.addEventListener('dragstart',e=>{
    const hd=e.target.closest('.card-hd'); if(!hd) return e.preventDefault();
    dragging=hd.parentElement; dragging.classList.add('dragging');
    placeholder=document.createElement('div'); placeholder.className='placeholder';
    const r=getComputedStyle(dragging); placeholder.style.width=r.width; placeholder.style.height=r.height;
    dragging.after(placeholder);
  });
  board.addEventListener('dragover',e=>{
    if(!dragging) return; e.preventDefault();
    const rect=board.getBoundingClientRect(); const mid=(rect.left+rect.right)/2;
    const lane = (e.clientX>mid)?'lane-right':'lane-left';
    dragging.classList.toggle('lane-right', lane==='lane-right'); dragging.classList.toggle('lane-left', lane!=='lane-right');
    const siblings=[...board.querySelectorAll(`.${lane}.movable:not(.dragging)`)];
    let target=null, best=1e9;
    siblings.forEach(n=>{const r=n.getBoundingClientRect(); const d=Math.abs(e.clientY-(r.top+r.bottom)/2); if(d<best){best=d;target=n;}});
    if(target) target.after(placeholder); else board.appendChild(placeholder);
  });
  function end(){
    if(!dragging) return;
    placeholder.replaceWith(dragging);
    dragging.classList.remove('dragging'); dragging=null; placeholder=null;
    reflowBoard(); saveLayout();
  }
  board.addEventListener('drop', end); board.addEventListener('dragend', end);
})();

(function initResize(){
  const MIN_W=300, MIN_H=220;
  board.querySelectorAll('.card.resizable .resize-handle').forEach(h=>{
    let card=h.closest('.card'), sW=0,sH=0, sx=0, sy=0;
    const move=e=>{
      const br=board.getBoundingClientRect(), cr=card.getBoundingClientRect();
      // clamp to screen & board boundaries
      const maxW = Math.min(window.innerWidth-16, br.right-8 - cr.left);
      const maxH = Math.min(window.innerHeight-16, window.innerHeight-8 - cr.top);
      let nw=Math.max(MIN_W, Math.min(maxW, sW+(e.clientX-sx)));
      let nh=Math.max(MIN_H, Math.min(maxH, sH+(e.clientY-sy)));

      // soft-snap bottom to neighbor in same lane (if within 12px)
      const lane = card.classList.contains('lane-right') ? 'lane-right':'lane-left';
      const nbrs=[...board.querySelectorAll(`.${lane}.movable`)].filter(n=>n!==card);
      let best=null, delta=12;
      nbrs.forEach(n=>{const r=n.getBoundingClientRect(); const diff=Math.abs((cr.top+nh)-(r.bottom)); if(diff<delta){delta=diff; best=r;}});
      if(best) nh = best.bottom - cr.top;

      card.style.width = nw+'px'; card.style.height = nh+'px';
      // when a main card in a lane is resized, reflow lane widths to fill screen
      if(card.classList.contains('lane-left')) setLaneWidths(Math.round((nw/board.getBoundingClientRect().width)*100));
      reflowBoard(); saveLayout();
    };
    const up=()=>{document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',up);};
    h.addEventListener('pointerdown',e=>{
      e.preventDefault(); const r=card.getBoundingClientRect(); sW=r.width; sH=r.height; sx=e.clientX; sy=e.clientY;
      document.addEventListener('pointermove',move,{passive:false}); document.addEventListener('pointerup',up,{passive:false});
    });
  });
})();

restoreLayout(); reflowBoard();

// ==== TradingView ====
const TV_X = { /* exchange map for common tickers */ AAPL:"NASDAQ",MSFT:"NASDAQ",NVDA:"NASDAQ",AMZN:"NASDAQ",META:"NASDAQ",GOOGL:"NASDAQ",TSLA:"NASDAQ",AVGO:"NASDAQ",AMD:"NASDAQ",NFLX:"NASDAQ",ADBE:"NASDAQ",INTC:"NASDAQ",CSCO:"NASDAQ",QCOM:"NASDAQ",TXN:"NASDAQ",CRM:"NYSE",ORCL:"NYSE",IBM:"NYSE",NOW:"NYSE",SNOW:"NYSE",ABNB:"NASDAQ",SHOP:"NYSE",PYPL:"NASDAQ",JPM:"NYSE",BAC:"NYSE",WFC:"NYSE",GS:"NYSE",MS:"NYSE",V:"NYSE",MA:"NYSE",AXP:"NYSE","BRK-B":"NYSE",SCHW:"NYSE",KO:"NYSE",PEP:"NASDAQ",PG:"NYSE",MCD:"NYSE",COST:"NASDAQ",HD:"NYSE",LOW:"NYSE",DIS:"NYSE",NKE:"NYSE",SBUX:"NASDAQ",TGT:"NYSE",WMT:"NYSE",T:"NYSE",VZ:"NYSE",CMCSA:"NASDAQ",XOM:"NYSE",CVX:"NYSE",COP:"NYSE",CAT:"NYSE",BA:"NYSE",GE:"NYSE",UPS:"NYSE",FDX:"NYSE",DE:"NYSE",UNH:"NYSE",LLY:"NYSE",MRK:"NYSE",ABBV:"NYSE",JNJ:"NYSE",PFE:"NYSE",UBER:"NYSE",BKNG:"NASDAQ",SPY:"AMEX",QQQ:"NASDAQ",DIA:"AMEX",IWM:"AMEX"};
const toTV=s=>`${(TV_X[s]||'NASDAQ')}:${s}`;

function mountTV(symbol, override=null){
  chartTitle.textContent=`Chart – ${symbol}`;
  tvContainer.innerHTML="";
  if(typeof TradingView==="undefined"||!TradingView.widget){tvContainer.innerHTML='<div class="muted">TradingView failed to load.</div>';return;}
  const theme=document.documentElement.getAttribute('data-theme')==='light'?'light':'dark';
  new TradingView.widget({symbol: override||toTV(symbol), interval:'60', timezone:'Etc/UTC', theme, style:'1',
    toolbar_bg:'transparent', locale:'en', enable_publishing:false, allow_symbol_change:false, container_id:'tv_container', autosize:true});
}

// ==== Ticker bar (RAF marquee) ====
const nodes=new Map(); let rafId=0, x=0, halfW=0;
function buildTicker(items){
  tickerTrack.innerHTML=''; nodes.clear();
  const row=document.createElement('div'); row.className='row';
  items.forEach(tk=>{
    const el=document.createElement('div'); el.className='ticker-item'; el.dataset.sym=tk.symbol;
    const s=document.createElement('span'); s.className='sym'; s.textContent=tk.symbol;
    const p=document.createElement('span'); p.className='price'; p.textContent=fmt(tk.price);
    const c=document.createElement('span'); c.className='chg '+clsFor(tk.change_pct); c.textContent=fmtPct(tk.change_pct);
    el.append(s,p,c); el.addEventListener('click',()=>onSelect(tk.symbol));
    row.appendChild(el); nodes.set(tk.symbol,{el,p,c,last:tk.price});
  });
  tickerTrack.appendChild(row.cloneNode(true)); tickerTrack.appendChild(row);
  halfW=tickerTrack.scrollWidth/2; x=0; startMarquee();
}
function updateTicker(items){
  items.forEach(tk=>{
    const n=nodes.get(tk.symbol); if(!n) return;
    const newP=fmt(tk.price); if(newP!==n.p.textContent){ const up=((tk.price||0)>(n.last||0));
      n.el.classList.remove('flash-up','flash-down'); void n.el.offsetWidth; n.el.classList.add(up?'flash-up':'flash-down');
      setTimeout(()=>n.el.classList.remove('flash-up','flash-down'),600); n.p.textContent=newP; n.last=tk.price; }
    n.c.className='chg '+clsFor(tk.change_pct); n.c.textContent=fmtPct(tk.change_pct);
  });
}
function startMarquee(){ cancelAnimationFrame(rafId); const speed=60; let last=performance.now();
  const step=(t)=>{const dt=(t-last)/1000; last=t; x-=speed*dt; if(x<=-halfW) x+=halfW; tickerTrack.style.transform=`translateX(${x}px)`; rafId=requestAnimationFrame(step);};
  rafId=requestAnimationFrame(step);
}
tickerWrap.addEventListener('mouseenter',()=>cancelAnimationFrame(rafId));
tickerWrap.addEventListener('mouseleave',()=>startMarquee());

async function loadTickers(){ try{
  const data=await fetchJSON(API.tickers); if(!nodes.size) buildTicker(data); else updateTicker(data);
}catch(e){ if(!nodes.size) tickerTrack.innerHTML='<div class="muted" style="padding:6px 10px;">tickers unavailable</div>'; console.error(e);} }

// ==== Movers ====
function drawMovers(tb,arr){ tb.innerHTML=''; if(!arr||!arr.length){tb.innerHTML='<tr><td class="muted">No data</td></tr>';return;}
  arr.forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.symbol}</td><td>${fmt(r.price)}</td><td class="${clsFor(r.change_pct)}">${fmtPct(r.change_pct)}</td>`;
    tr.style.cursor='pointer'; tr.addEventListener('click',()=>onSelect(r.symbol)); tb.appendChild(tr); });}
async function loadMovers(){ try{const m=await fetchJSON(API.movers); drawMovers(gainersBody,m.gainers); drawMovers(losersBody,m.losers);}catch(e){console.error(e);} }

// ==== Insights ====
function renderPerf(perf){ const keys=["1W","1M","3M","6M","YTD","1Y"]; perfGrid.innerHTML='';
  keys.forEach(k=>{const v=perf?perf[k]:null; const d=document.createElement('div'); d.className=`perf-box ${clsFor(v)}`; d.innerHTML=`<div class="p-val">${v==null?'—':(v>0?'+':'')+v.toFixed(2)+'%'}</div><div class="p-lbl">${k}</div>`; perfGrid.appendChild(d);});}
async function loadInsights(symbol){ insightsTitle.textContent=`Market Insights: ${symbol}`; renderPerf(null); coDesc.textContent=''; try{const m=await fetchJSON(API.metrics,{params:{symbol}}); renderPerf(m.performance); coDesc.textContent=(m.profile&&m.profile.description)||'';}catch(e){console.error(e);} }

// ==== News ====
function renderNews(container,rows){ container.innerHTML=''; if(!rows||!rows.length){container.innerHTML='<div class="muted">No headlines.</div>';return;}
  rows.forEach(n=>{const el=document.createElement('div'); el.className='news-item'; const a=document.createElement('a'); a.href=n.url||'#'; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=n.title||'(untitled)';
    const m=document.createElement('div'); m.className='muted'; m.textContent=`${n.source||''}`; el.append(a,m); container.appendChild(el); });}
async function loadNews(symbol){ newsList.innerHTML='<div class="fallback-note">Loading news…</div>'; try{renderNews(newsList, await fetchJSON(API.news,{params:{symbol}}));}catch{newsList.innerHTML='<div class="muted">Failed to load news.</div>';}}
async function loadMarketNews(){ marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>'; try{renderNews(marketNewsList, await fetchJSON(API.mktnews));}catch{marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; }}

// ==== Selection ====
async function onSelect(symbol, override=null){
  currentSymbol=symbol; tvOverride=override||null; mountTV(symbol, tvOverride);
  await Promise.allSettled([loadInsights(symbol), loadNews(symbol)]);
}

// ==== Boot ====
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 25000);
  loadMovers();  setInterval(loadMovers,  30000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
  setTimeout(()=>{ if(!currentSymbol) onSelect('AAPL'); }, 300);
});
