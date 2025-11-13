// Stable quotes (Yahoo/Stooq/TwelveData), RAF marquee, free board with two-lane snap,
// live resize with full cleanup, settings (tile toggles + proper theme switch).

const ENDPOINTS={
  tickers:"/api/tickers", movers:"/api/movers", metrics:"/api/metrics",
  news:"/api/news", mktnews:"/api/market-news"
};
const $=id=>document.getElementById(id);

// DOM
const tickerWrap=$('tickerWrap'), tickerTrack=$('tickerTrack');
const tvContainer=$('tv_container'), chartTitle=$('chartTitle');
const newsList=$('newsList'), marketNewsList=$('marketNewsList');
const gainersBody=$('gainersBody'), losersBody=$('losersBody');
const board=$('board'), themeToggle=$('themeToggle'),
      settingsBtn=$('settingsBtn'), settingsMenu=$('settingsMenu');
const nasdaqBtn=$('btnNasdaq'), spxBtn=$('btnSPX');
const perfGrid=$('perfGrid'), insightsTitle=$('insightsTitle'), coDesc=$('coDesc');

let currentSymbol=null, currentTVOverride=null;

// helpers
function fetchJSON(url,{timeout=12000,params}={}){const c=new AbortController();const t=setTimeout(()=>c.abort(),timeout);
const u=params?`${url}?${new URLSearchParams(params)}`:url;return fetch(u,{signal:c.signal}).then(r=>{if(!r.ok)throw new Error(r.status);return r.json();}).finally(()=>clearTimeout(t));}
const fmtPrice=v=>(typeof v==='number'&&isFinite(v))?v.toFixed(2):'—';
const fmtChange=v=>(v==null||!isFinite(v))?'—':`${v>0?'+':(v<0?'−':'')}${Math.abs(v).toFixed(2)}%`;
function applyChangeClass(el,v){el.className='chg '+(v>0?'pos':(v<0?'neg':'neu'));}

// SETTINGS (theme + tile toggles)
(()=>{
  // theme
  let open=false;const close=()=>{settingsMenu.classList.remove('open');open=false;};
  settingsBtn.addEventListener('click',e=>{e.stopPropagation();open=!open;settingsMenu.classList.toggle('open',open);});
  document.addEventListener('click',e=>{if(!open)return;if(!settingsMenu.contains(e.target)&&e.target!==settingsBtn)close();});
  const saved=localStorage.getItem('mt_theme')||'dark';
  document.documentElement.setAttribute('data-theme',saved);
  themeToggle.checked=(saved==='light');
  themeToggle.addEventListener('change',()=>{
    const t=themeToggle.checked?'light':'dark';
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem('mt_theme',t);
    if(currentSymbol) mountTradingView(currentSymbol,currentTVOverride);
  });

  // tile visibility
  function applyVisibility(){
    document.querySelectorAll('.tile-toggle').forEach(chk=>{
      const id=chk.dataset.target; const el=$(id); if(!el) return;
      el.style.display = chk.checked ? '' : 'none';
    });
  }
  // restore saved visibility
  const vis = JSON.parse(localStorage.getItem('mt_tiles')||'{}');
  document.querySelectorAll('.tile-toggle').forEach(chk=>{
    if(vis[chk.dataset.target]===false) chk.checked=false;
  });
  applyVisibility();
  document.querySelectorAll('.tile-toggle').forEach(chk=>{
    chk.addEventListener('change',()=>{
      const conf={}; document.querySelectorAll('.tile-toggle').forEach(c=>conf[c.dataset.target]=c.checked);
      localStorage.setItem('mt_tiles',JSON.stringify(conf));
      applyVisibility();
    });
  });
})();

// HEADER quick shortcuts (US500 / NAS100 via TradingView)
nasdaqBtn.addEventListener('click', ()=> onSymbolSelect('QQQ', 'OANDA:NAS100USD'));
spxBtn.addEventListener('click', ()=> onSymbolSelect('SPY',  'CURRENCYCOM:US500'));

// minus buttons on each card to hide
document.querySelectorAll('.min-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const id=btn.dataset.hide, el=$(id); if(!el) return;
    const chk=document.querySelector(`.tile-toggle[data-target="${id}"]`);
    if(chk){ chk.checked=false; chk.dispatchEvent(new Event('change')); }
  });
});

// ----- Free board: two lanes + snap-under (move by header)
(()=>{
  function laneX(){const r=board.getBoundingClientRect();return {left:r.left + 12, right:r.right - 12, mid:(r.left+r.right)/2};}
  board.querySelectorAll('.movable .card-hd').forEach(h=>h.setAttribute('draggable','true'));

  let dragging=null, placeholder=null;
  const cleanupPlaceholder=()=>{ if(placeholder){ placeholder.remove(); placeholder=null; } };

  board.addEventListener('dragstart',e=>{
    const hd=e.target.closest('.card-hd'); if(!hd) return e.preventDefault();
    dragging=hd.parentElement; dragging.classList.add('dragging');
    placeholder=document.createElement('div'); placeholder.className='placeholder';
    placeholder.style.width=getComputedStyle(dragging).width; placeholder.style.height=getComputedStyle(dragging).height;
    dragging.after(placeholder);
  });

  board.addEventListener('dragover',e=>{
    if(!dragging) return; e.preventDefault();
    const {mid}=laneX(); const lane = (e.clientX>mid)?'lane-right':'lane-left';
    dragging.classList.toggle('lane-right', lane==='lane-right');
    dragging.classList.toggle('lane-left', lane!=='lane-right');
    const laneNodes=[...board.querySelectorAll(`.movable.${lane}:not(.dragging)`)];
    let target=null, mind=1e9;
    laneNodes.forEach(n=>{const r=n.getBoundingClientRect(); const d=Math.abs(e.clientY-(r.top+r.bottom)/2); if(d<mind){mind=d; target=n;}});
    if(target) target.after(placeholder); else board.appendChild(placeholder);
  });

  function endDrag(){
    if(!dragging) return;
    placeholder.replaceWith(dragging);
    dragging.classList.remove('dragging');
    dragging=null; cleanupPlaceholder();
  }

  board.addEventListener('dragend', endDrag);
  board.addEventListener('drop', endDrag);
})();

// ----- Live resize with CLAMP + FULL CLEANUP so outlines never get stuck
(()=>{
  const MIN_W=300, MIN_H=220;
  const killOutline=()=>{document.querySelectorAll('.resize-outline').forEach(n=>n.remove());};
  ['pointerup','pointercancel','blur','mouseleave'].forEach(ev=>window.addEventListener(ev,killOutline));

  board.querySelectorAll('.card.resizable .resize-handle').forEach(h=>{
    let card=h.closest('.card'), sW=0,sH=0, sx=0, sy=0, outline=null;

    const move=e=>{
      const br=board.getBoundingClientRect();
      const maxW=Math.min(window.innerWidth-16, br.right-8 - card.getBoundingClientRect().left);
      const maxH=Math.min(window.innerHeight-16, window.innerHeight-8 - card.getBoundingClientRect().top);
      const nw=Math.max(MIN_W, Math.min(maxW, sW+(e.clientX-sx)));
      const nh=Math.max(MIN_H, Math.min(maxH, sH+(e.clientY-sy)));
      outline.style.width=nw+'px'; outline.style.height=nh+'px';
      card.style.width=nw+'px'; card.style.height=nh+'px';
    };

    const up=()=>{
      document.removeEventListener('pointermove',move);
      document.removeEventListener('pointerup',up);
      document.removeEventListener('pointercancel',up);
      window.removeEventListener('blur',up);
      if(outline){ outline.remove(); outline=null; }
      card.classList.remove('resizing');
    };

    h.addEventListener('pointerdown',e=>{
      e.preventDefault(); sW=card.getBoundingClientRect().width; sH=card.getBoundingClientRect().height; sx=e.clientX; sy=e.clientY; card.classList.add('resizing');
      outline=document.createElement('div'); outline.className='resize-outline'; const r=card.getBoundingClientRect();
      outline.style.left=r.left+'px'; outline.style.top=r.top+'px'; outline.style.width=r.width+'px'; outline.style.height=r.height+'px';
      document.body.appendChild(outline);
      document.addEventListener('pointermove',move,{passive:false});
      document.addEventListener('pointerup',up,{passive:false});
      document.addEventListener('pointercancel',up,{passive:false});
      window.addEventListener('blur',up);
    });
  });
})();

// ----- TradingView -----
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

// ----- Marquee (RAF) -----
const tmap=new Map(); let rafId=0, x=0, contentW=0;
function rebuildMarquee(){ const inner=[...tmap.keys()].map(sym=>tmap.get(sym).el.outerHTML).join('');
  tickerTrack.innerHTML=`<div class="row">${inner}</div><div class="row">${inner}</div>`;
  contentW=tickerTrack.scrollWidth/2; x=0; }
function startMarquee(){ cancelAnimationFrame(rafId); const speed=60; let last=performance.now();
  const step=(ts)=>{const dt=(ts-last)/1000; last=ts; x-=speed*dt; if(x<=-contentW) x+=contentW; tickerTrack.style.transform=`translateX(${x}px)`; rafId=requestAnimationFrame(step);};
  rafId=requestAnimationFrame(step); }
tickerWrap.addEventListener('mouseenter', ()=>cancelAnimationFrame(rafId));
tickerWrap.addEventListener('mouseleave', ()=>startMarquee());

function renderTicker(items){
  tmap.clear();
  const frag=document.createDocumentFragment();
  items.forEach(tk=>{
    const el=document.createElement('div'); el.className='ticker-item'; el.dataset.sym=tk.symbol;
    const s=document.createElement('span'); s.className='sym'; s.textContent=tk.symbol;
    const p=document.createElement('span'); p.className='price'; p.textContent=fmtPrice(tk.price);
    const c=document.createElement('span'); c.className='chg'; applyChangeClass(c, tk.change_pct); c.textContent=fmtChange(tk.change_pct);
    el.append(s,p,c); el.addEventListener('click',()=>onSymbolSelect(tk.symbol)); frag.appendChild(el);
    tmap.set(tk.symbol,{el,p,c,last:tk.price});
  });
  const row=document.createElement('div'); row.className='row'; row.appendChild(frag); tickerTrack.innerHTML=''; tickerTrack.appendChild(row);
  rebuildMarquee(); startMarquee();
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
    const data=await fetchJSON(ENDPOINTS.tickers);
    if(!tmap.size) renderTicker(data); else updateTicker(data);
  }catch(e){ if(!tmap.size) tickerTrack.innerHTML='<div class="muted" style="padding:4px 8px">tickers unavailable</div>'; console.error(e); }
}

// ----- Movers -----
function renderMovers(m){
  const draw=(tb,arr)=>{ tb.innerHTML=''; if(!arr||!arr.length){tb.innerHTML='<tr><td class="muted">No data</td></tr>';return;}
    arr.forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.symbol}</td><td>${fmtPrice(r.price)}</td><td class="${r.change_pct>0?'pos':(r.change_pct<0?'neg':'neu')}">${fmtChange(r.change_pct)}</td>`;
      tr.style.cursor='pointer'; tr.addEventListener('click',()=>onSymbolSelect(r.symbol)); tb.appendChild(tr); }); };
  draw(gainersBody,m.gainers); draw(losersBody,m.losers);
}
async function loadMovers(){ try{ renderMovers(await fetchJSON(ENDPOINTS.movers)); }catch(e){ console.error(e); } }

// ----- Insights -----
function renderPerf(perf){ const labels=["1W","1M","3M","6M","YTD","1Y"]; perfGrid.innerHTML='';
  labels.forEach(k=>{ const v=perf?perf[k]:null; const d=document.createElement('div'); d.className='perf-box '+(v>0?'pos':(v<0?'neg':'neu'));
    d.innerHTML=`<div class="p-val">${(v==null)?'—':`${v>0?'+':''}${v.toFixed(2)}%`}</div><div class="p-lbl">${k}</div>`; perfGrid.appendChild(d); });}
async function loadInsights(symbol){
  insightsTitle.textContent=`Market Insights: ${symbol}`; renderPerf(null); coDesc.textContent='';
  try{ const m=await fetchJSON(ENDPOINTS.metrics,{params:{symbol}}); renderPerf(m.performance); coDesc.textContent=(m.profile&&m.profile.description)||''; }
  catch(e){ console.error(e); }
}

// ----- News -----
function renderNews(container, items){ container.innerHTML=''; if(!items||!items.length){container.innerHTML='<div class="muted">No headlines.</div>';return;}
  items.forEach(n=>{const it=document.createElement('div');it.className='news-item';const a=document.createElement('a');a.href=n.url||'#';a.target='_blank';a.rel='noopener noreferrer';a.textContent=n.title||'(untitled)';
    const meta=document.createElement('div');meta.className='muted';meta.textContent=`${n.source||'News'}${n.published_at?` · ${n.published_at}`:''}`;it.append(a,meta);container.appendChild(it);});}
async function loadNews(symbol){ newsList.innerHTML='<div class="fallback-note">Loading news…</div>'; try{renderNews(newsList, await fetchJSON(ENDPOINTS.news,{params:{symbol}}));}catch{newsList.innerHTML='<div class="muted">Failed to load news.</div>';}}
async function loadMarketNews(){ marketNewsList.innerHTML='<div class="fallback-note">Loading market headlines…</div>'; try{renderNews(marketNewsList, await fetchJSON(ENDPOINTS.mktnews));}catch{marketNewsList.innerHTML='<div class="muted">Failed to load market headlines.</div>'; }}

// ----- Select -----
async function onSymbolSelect(symbol, tvOverride=null){
  currentSymbol=symbol; currentTVOverride=tvOverride; mountTradingView(symbol, tvOverride);
  await Promise.allSettled([ loadInsights(symbol), loadNews(symbol) ]);
}

// ----- Boot -----
document.addEventListener('DOMContentLoaded', ()=>{
  loadTickers(); setInterval(loadTickers, 25000);
  loadMovers();  setInterval(loadMovers,  30000);
  loadMarketNews(); setInterval(loadMarketNews, 180000);
  setTimeout(()=>{ if(!currentSymbol) onSymbolSelect('AAPL'); }, 500);
});

// error surface
window.addEventListener('error', e=>console.error('JS error:', e.message, e.filename, e.lineno));
