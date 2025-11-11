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
    tvContainer.appendChild(warn
