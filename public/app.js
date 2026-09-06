// --- Cloud access key -----------------------------------------------
// Bookmark this page as: https://your-app.onrender.com/?key=YOUR_SECRET
// so your phone remembers it. The key gets appended to every API call
// automatically from here on.
(function () {
  const params = new URLSearchParams(window.location.search);
  let key = params.get('key');
  if (key) {
    sessionStorage.setItem('journalKey', key);
  } else {
    key = sessionStorage.getItem('journalKey');
  }
  if (!key) {
    key = prompt('Enter your journal access key:');
    if (key) sessionStorage.setItem('journalKey', key);
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (url, options) {
    if (typeof url === 'string' && url.startsWith('/api/')) {
      const sep = url.includes('?') ? '&' : '?';
      url = url + sep + 'key=' + encodeURIComponent(key || '');
    }
    return originalFetch(url, options);
  };
})();

// app.js
let currentTrade = null;
let currentDetail = null;
let chart = null;
let candleSeries = null;
let activeTf = null;

const tradeListEl = document.getElementById('tradeList');
const tradeCountEl = document.getElementById('tradeCount');
const emptyPanel = document.getElementById('emptyPanel');
const tradePanel = document.getElementById('tradePanel');
const tfTabsEl = document.getElementById('tfTabs');
const noteStrategyEl = document.getElementById('noteStrategy');

async function loadStrategies(selectAfter = null) {
  const res = await fetch('/api/strategies');
  const strategies = await res.json();

  noteStrategyEl.innerHTML = '<option value="">Strategy…</option>';
  for (const s of strategies) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    noteStrategyEl.appendChild(opt);
  }
  const addOpt = document.createElement('option');
  addOpt.value = '__add_new__';
  addOpt.textContent = '+ Add new strategy…';
  noteStrategyEl.appendChild(addOpt);

  if (selectAfter) noteStrategyEl.value = selectAfter;
}

noteStrategyEl.addEventListener('change', async () => {
  if (noteStrategyEl.value !== '__add_new__') return;
  const name = prompt('New strategy name:');
  if (!name || !name.trim()) { noteStrategyEl.value = ''; return; }
  await fetch('/api/strategies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  await loadStrategies(name.trim());
});

// MT5 timestamps look like "2026.07.17 22:45" - convert to unix seconds
function parseMT5Time(str) {
  if (!str) return null;
  const [datePart, timePart] = str.split(' ');
  const [y, m, d] = datePart.split('.').map(Number);
  const [hh, mm] = (timePart || '00:00').split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000);
}

// R-multiple: reward distance / risk distance, using the actual SL set at
// entry. This is the standard trader definition - it's a pure price-ratio,
// so it doesn't need lot size, pip value, or broker-specific tick info.
function computeR(trade) {
  if (!trade.open || !trade.close) return null;
  const sl = parseFloat(trade.open.sl);
  const entry = parseFloat(trade.open.price);
  const close = parseFloat(trade.close.price);
  if (!sl || isNaN(sl) || sl === 0) return null; // no SL recorded - can't compute risk

  const risk = Math.abs(entry - sl);
  if (risk === 0) return null;

  const reward = trade.direction === 'BUY' ? (close - entry) : (entry - close);
  return reward / risk;
}

function formatR(r) {
  if (r === null) return null;
  const sign = r >= 0 ? '+' : '';
  return `${sign}${r.toFixed(2)}R`;
}

async function loadTrades() {
  const res = await fetch('/api/trades');
  const trades = await res.json();
  tradeCountEl.textContent = `${trades.length} trade${trades.length === 1 ? '' : 's'}`;

  if (trades.length === 0) {
    tradeListEl.innerHTML = '<div class="empty-state">No trades yet. Once TradeJournalExporter.mq5 logs a trade, it\'ll show up here.</div>';
    return;
  }

  tradeListEl.innerHTML = '';
  for (const t of trades) {
    const item = document.createElement('div');
    item.className = 'trade-item';
    item.dataset.id = t.position_id;

    const profit = t.close ? t.close.profit : null;
    const profitClass = profit === null ? 'open' : profit >= 0 ? 'pos' : 'neg';
    const profitText = profit === null ? 'open' : (profit >= 0 ? '+' : '') + profit.toFixed(2);
    const time = (t.close || t.open).time;
    const rText = formatR(computeR(t));
    const rClass = rText ? (rText.startsWith('+') ? 'pos' : 'neg') : '';

    item.innerHTML = `
      <div class="trade-item-top">
        <span><span class="trade-symbol">${t.symbol}</span><span class="trade-dir ${t.direction.toLowerCase()}">${t.direction}</span></span>
        <span>
          ${rText ? `<span class="trade-r ${rClass}">${rText}</span>` : ''}
          <span class="trade-profit ${profitClass}">${profitText}</span>
        </span>
      </div>
      <div class="trade-item-bottom">${time}</div>
    `;
    item.addEventListener('click', () => selectTrade(t.position_id));
    tradeListEl.appendChild(item);
  }
}

async function selectTrade(id) {
  document.querySelectorAll('.trade-item').forEach(el => el.classList.toggle('active', el.dataset.id === String(id)));

  const res = await fetch(`/api/trade/${id}`);
  if (!res.ok) return;
  const detail = await res.json();
  currentDetail = detail;
  currentTrade = detail.trade;

  trashPanel.style.display = 'none';
  trashToggleBtn.classList.remove('active');
  trashOpen = false;
  reportsPanel.style.display = 'none';
  reportsToggleBtn.classList.remove('active');
  reportsOpen = false;
  emptyPanel.style.display = 'none';
  tradePanel.style.display = 'flex';

  renderHeader(detail.trade);
  renderTfTabs(detail);
  renderNoteForm(detail.trade);
}

function renderHeader(t) {
  document.getElementById('tSymbol').textContent = t.symbol;
  const dirEl = document.getElementById('tDirection');
  dirEl.textContent = t.direction;
  dirEl.style.background = t.direction === 'BUY' ? 'rgba(46,158,109,0.18)' : 'rgba(216,80,58,0.18)';
  dirEl.style.color = t.direction === 'BUY' ? '#2e9e6d' : '#d8503a';
  document.getElementById('tStatus').textContent = t.status;

  document.getElementById('tOpenPrice').textContent = t.open ? t.open.price : '—';
  document.getElementById('tClosePrice').textContent = t.close ? t.close.price : '—';
  const profitEl = document.getElementById('tProfit');
  if (t.close) {
    profitEl.textContent = (t.close.profit >= 0 ? '+' : '') + t.close.profit.toFixed(2);
    profitEl.style.color = t.close.profit >= 0 ? '#2e9e6d' : '#d8503a';
  } else {
    profitEl.textContent = 'open';
    profitEl.style.color = '#8b95a1';
  }
  document.getElementById('tTime').textContent = (t.close || t.open).time;

  const rEl = document.getElementById('tR');
  const r = computeR(t);
  if (r !== null) {
    rEl.textContent = formatR(r);
    rEl.style.color = r >= 0 ? '#2e9e6d' : '#d8503a';
  } else if (t.close) {
    rEl.textContent = 'no SL recorded';
    rEl.style.color = '#8b95a1';
  } else {
    rEl.textContent = '—';
    rEl.style.color = '#8b95a1';
  }
}

function renderTfTabs(detail) {
  // only show timeframes we have BOTH candle data and structure data for
  const tfs = Object.keys(detail.candles).filter(tf => detail.structure.timeframes[tf]);
  tfTabsEl.innerHTML = '';

  if (tfs.length === 0) {
    tfTabsEl.innerHTML = '<span style="color:#8b95a1;font-size:12px;">No candle/structure snapshot found for this trade — was MarketStructure.mq5 attached at the time?</span>';
    document.getElementById('chart').innerHTML = '';
    return;
  }

  activeTf = tfs.includes(activeTf) ? activeTf : tfs[0];

  for (const tf of tfs) {
    const tab = document.createElement('div');
    tab.className = 'tf-tab' + (tf === activeTf ? ' active' : '');
    tab.textContent = tf.replace('PERIOD_', '');
    tab.addEventListener('click', () => {
      activeTf = tf;
      renderTfTabs(detail);
      renderChart(detail, tf);
    });
    tfTabsEl.appendChild(tab);
  }

  renderChart(detail, activeTf);
}

function renderChart(detail, tf) {
  const container = document.getElementById('chart');
  container.innerHTML = '';

  chart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#12161b' }, textColor: '#8b95a1' },
    grid: { vertLines: { color: '#1c2128' }, horzLines: { color: '#1c2128' } },
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: '#23292f', visible: true },
    width: container.clientWidth,
    height: container.clientHeight,
  });

  // Forex needs 5-decimal precision - the library defaults to 2 (stock-style),
  // which is why every price line was showing as a rounded "1.14" instead of
  // the real distinct value.
  const pricePrecision = { type: 'price', precision: 5, minMove: 0.00001 };

  candleSeries = chart.addCandlestickSeries({
    upColor: '#2e9e6d', downColor: '#d8503a',
    borderUpColor: '#2e9e6d', borderDownColor: '#d8503a',
    wickUpColor: '#2e9e6d', wickDownColor: '#d8503a',
    priceFormat: pricePrecision,
  });

  const candles = (detail.candles[tf] || [])
    .map(c => ({ time: parseMT5Time(c.time), open: c.open, high: c.high, low: c.low, close: c.close }))
    .filter(c => c.time !== null)
    .sort((a, b) => a.time - b.time);
  candleSeries.setData(candles);

  const structure = detail.structure.timeframes[tf];
  const allMarkers = [];

  if (structure) {
    // BOS/CHoCH events as markers on the candle series
    for (const ev of (structure.events || [])) {
      const t = parseMT5Time(ev.time);
      if (t === null) continue;
      allMarkers.push({
        time: t,
        position: ev.direction === 'up' ? 'belowBar' : 'aboveBar',
        color: ev.type === 'CHoCH' ? '#d98b3f' : (ev.direction === 'up' ? '#2e9e6d' : '#d8503a'),
        shape: ev.direction === 'up' ? 'arrowUp' : 'arrowDown',
        text: ev.type,
      });
    }

    // S/R zones as horizontal price lines
    (structure.zones || []).forEach(z => {
      candleSeries.createPriceLine({
        price: z.price, color: '#5a6472', lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: `SR (${z.touches}x)`,
      });
    });
  }

  // Entry/exit: a price line so you can see the level across the whole
  // chart, PLUS a marker pinned to the exact candle so you can see WHEN,
  // not just what price.
  if (detail.trade.open) {
    const entryPrice = parseFloat(detail.trade.open.price);
    const entryTime = parseMT5Time(detail.trade.open.time);
    candleSeries.createPriceLine({
      price: entryPrice, color: '#d98b3f', lineWidth: 2,
      lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: 'Entry',
    });
    if (entryTime !== null) {
      allMarkers.push({
        time: entryTime,
        position: detail.trade.direction === 'BUY' ? 'belowBar' : 'aboveBar',
        color: '#d98b3f',
        shape: detail.trade.direction === 'BUY' ? 'arrowUp' : 'arrowDown',
        text: `Entry ${entryPrice.toFixed(5)}`,
      });
    }
  }
  if (detail.trade.close) {
    const exitPrice = parseFloat(detail.trade.close.price);
    const exitTime = parseMT5Time(detail.trade.close.time);
    candleSeries.createPriceLine({
      price: exitPrice, color: '#8b95a1', lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: 'Exit',
    });
    if (exitTime !== null) {
      allMarkers.push({
        time: exitTime,
        position: detail.trade.direction === 'BUY' ? 'aboveBar' : 'belowBar',
        color: '#8b95a1',
        shape: 'circle',
        text: `Exit ${exitPrice.toFixed(5)}`,
      });
    }
  }

  candleSeries.setMarkers(allMarkers.sort((a, b) => a.time - b.time));

  chart.timeScale().fitContent();

  new ResizeObserver(() => {
    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);
}

function renderNoteForm(t) {
  document.getElementById('noteText').value = t.note || '';
  document.getElementById('noteTags').value = t.tags || '';
  document.getElementById('noteRating').value = t.rating || '';
  noteStrategyEl.value = t.strategy || '';
  document.getElementById('saveStatus').textContent = '';
}

document.getElementById('saveNoteBtn').addEventListener('click', async () => {
  if (!currentTrade) return;
  const note = document.getElementById('noteText').value;
  const tags = document.getElementById('noteTags').value;
  const rating = document.getElementById('noteRating').value || null;
  const strategy = noteStrategyEl.value === '__add_new__' ? '' : noteStrategyEl.value;

  const res = await fetch(`/api/trade/${currentTrade.position_id}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note, tags, rating, strategy }),
  });
  const status = document.getElementById('saveStatus');
  status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

document.getElementById('deleteTradeBtn').addEventListener('click', async () => {
  if (!currentTrade) return;
  const label = `${currentTrade.symbol} ${currentTrade.direction} opened ${currentTrade.open ? currentTrade.open.time : ''}`;
  if (!confirm(`Move this trade to Trash?\n\n${label}\n\nIt won't show in your main list, but nothing is permanently deleted — you can restore it from Trash anytime.`)) {
    return;
  }
  const res = await fetch(`/api/trade/${currentTrade.position_id}`, { method: 'DELETE' });
  if (res.ok) {
    currentTrade = null;
    tradePanel.style.display = 'none';
    emptyPanel.style.display = 'flex';
    loadTrades();
    loadTrashCount();
  } else {
    alert('Failed to move trade to trash.');
  }
});

// --- Trash panel -------------------------------------------------------
const trashPanel = document.getElementById('trashPanel');
const trashToggleBtn = document.getElementById('trashToggleBtn');
let trashOpen = false;

async function loadTrashCount() {
  const res = await fetch('/api/trash');
  const items = await res.json();
  document.getElementById('trashCount').textContent = items.length;
  return items;
}

async function renderTrash() {
  const items = await loadTrashCount();
  const listEl = document.getElementById('trashList');
  if (items.length === 0) {
    listEl.innerHTML = '<p class="hint">Trash is empty.</p>';
    return;
  }
  listEl.innerHTML = '';
  for (const t of items) {
    const row = document.createElement('div');
    row.className = 'trash-item';
    row.innerHTML = `
      <div class="trash-item-info">
        <span><strong>${t.symbol}</strong> ${t.direction}</span>
        <span class="hint">deleted ${t.deleted_at}</span>
      </div>
      <div class="trash-item-actions">
        <button class="restore-btn" data-id="${t.position_id}">Restore</button>
        <button class="purge-btn" data-id="${t.position_id}">Delete forever</button>
      </div>
    `;
    listEl.appendChild(row);
  }
  listEl.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/trash/${btn.dataset.id}/restore`, { method: 'POST' });
      await renderTrash();
      loadTrades();
    });
  });
  listEl.querySelectorAll('.purge-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this trade? This cannot be undone.')) return;
      await fetch(`/api/trash/${btn.dataset.id}`, { method: 'DELETE' });
      await renderTrash();
    });
  });
}

trashToggleBtn.addEventListener('click', () => {
  trashOpen = !trashOpen;
  trashToggleBtn.classList.toggle('active', trashOpen);
  if (trashOpen) {
    reportsOpen = false;
    reportsToggleBtn.classList.remove('active');
    reportsPanel.style.display = 'none';
    emptyPanel.style.display = 'none';
    tradePanel.style.display = 'none';
    trashPanel.style.display = 'block';
    renderTrash();
  } else {
    trashPanel.style.display = 'none';
    emptyPanel.style.display = currentTrade ? 'none' : 'flex';
    tradePanel.style.display = currentTrade ? 'flex' : 'none';
  }
});

// --- Reports panel -------------------------------------------------------
const reportsPanel = document.getElementById('reportsPanel');
const reportsToggleBtn = document.getElementById('reportsToggleBtn');
let reportsOpen = false;
let allTradesCache = [];
let currentReportPeriod = 'day';

reportsToggleBtn.addEventListener('click', () => {
  reportsOpen = !reportsOpen;
  reportsToggleBtn.classList.toggle('active', reportsOpen);
  if (reportsOpen) {
    trashOpen = false;
    trashToggleBtn.classList.remove('active');
    trashPanel.style.display = 'none';
    emptyPanel.style.display = 'none';
    tradePanel.style.display = 'none';
    reportsPanel.style.display = 'block';
    loadReports();
  } else {
    reportsPanel.style.display = 'none';
    emptyPanel.style.display = currentTrade ? 'none' : 'flex';
    tradePanel.style.display = currentTrade ? 'flex' : 'none';
  }
});

// -- helpers shared by everything below --

function fmtMoney(n) {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}
function moneyClass(n) {
  const v = Number(n) || 0;
  return v > 0 ? 'pos' : v < 0 ? 'neg' : 'dim';
}
function getClosedTrades(trades) {
  return trades.filter(t => t.close).map(t => ({
    ...t,
    profit: Number(t.close.profit) || 0,
    closeEpoch: parseMT5Time(t.close.time),
    r: computeR(t),
  })).filter(t => t.closeEpoch !== null).sort((a, b) => a.closeEpoch - b.closeEpoch);
}

function pad2(n) { return String(n).padStart(2, '0'); }
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function dayBucketOf(epochSec) {
  const d = new Date(epochSec * 1000);
  const key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const label = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  return { key, label };
}
function weekStartOf(d) {
  const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = s.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day; // back to Monday
  s.setUTCDate(s.getUTCDate() + diff);
  return s;
}
function weekBucketOf(epochSec) {
  const d = new Date(epochSec * 1000);
  const start = weekStartOf(d);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
  const key = `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}-${pad2(start.getUTCDate())}`;
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const label = sameMonth
    ? `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCDate()}–${end.getUTCDate()}, ${end.getUTCFullYear()}`
    : `${MONTH_NAMES[start.getUTCMonth()]} ${start.getUTCDate()} – ${MONTH_NAMES[end.getUTCMonth()]} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  return { key, label };
}
function monthBucketOf(epochSec) {
  const d = new Date(epochSec * 1000);
  const key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
  const label = `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return { key, label };
}
function bucketOf(epochSec, periodType) {
  if (periodType === 'week') return weekBucketOf(epochSec);
  if (periodType === 'month') return monthBucketOf(epochSec);
  return dayBucketOf(epochSec);
}
function currentBucketKey(periodType) {
  return bucketOf(Math.floor(Date.now() / 1000), periodType).key;
}

// Build one stats row per period, most-recent first.
function buildBuckets(closedTrades, periodType) {
  const map = new Map();
  for (const t of closedTrades) {
    const { key, label } = bucketOf(t.closeEpoch, periodType);
    if (!map.has(key)) map.set(key, { key, label, trades: [] });
    map.get(key).trades.push(t);
  }
  const buckets = Array.from(map.values());
  for (const b of buckets) {
    const wins = b.trades.filter(t => t.profit > 0);
    const losses = b.trades.filter(t => t.profit < 0);
    const breakeven = b.trades.filter(t => t.profit === 0);
    const decided = wins.length + losses.length;
    b.wins = wins.length;
    b.losses = losses.length;
    b.breakeven = breakeven.length;
    b.winRate = decided ? (wins.length / decided) * 100 : 0;
    b.netPL = b.trades.reduce((s, t) => s + t.profit, 0);
    b.avgWin = wins.length ? wins.reduce((s, t) => s + t.profit, 0) / wins.length : null;
    b.avgLoss = losses.length ? losses.reduce((s, t) => s + t.profit, 0) / losses.length : null;
    const rTrades = b.trades.filter(t => t.r !== null);
    b.avgR = rTrades.length ? rTrades.reduce((s, t) => s + t.r, 0) / rTrades.length : null;
    b.best = b.trades.reduce((a, t) => (!a || t.profit > a.profit) ? t : a, null);
    b.worst = b.trades.reduce((a, t) => (!a || t.profit < a.profit) ? t : a, null);
  }
  buckets.sort((a, b) => b.key.localeCompare(a.key));
  return buckets;
}

function computeStreaks(closedTradesAsc) {
  let longestWin = 0, longestLoss = 0;
  let curType = null, curCount = 0;
  for (const t of closedTradesAsc) {
    if (t.profit > 0) {
      curCount = curType === 'win' ? curCount + 1 : 1;
      curType = 'win';
      longestWin = Math.max(longestWin, curCount);
    } else if (t.profit < 0) {
      curCount = curType === 'loss' ? curCount + 1 : 1;
      curType = 'loss';
      longestLoss = Math.max(longestLoss, curCount);
    } else {
      curType = null; curCount = 0;
    }
  }
  return { currentType: curType, currentCount: curCount, longestWin, longestLoss };
}

function computeBreakdown(closedTrades, field) {
  const map = new Map();
  for (const t of closedTrades) {
    const key = (t[field] && String(t[field]).trim()) || '(none)';
    if (!map.has(key)) map.set(key, { key, trades: [] });
    map.get(key).trades.push(t);
  }
  const rows = Array.from(map.values()).map(r => {
    const wins = r.trades.filter(t => t.profit > 0).length;
    const losses = r.trades.filter(t => t.profit < 0).length;
    const decided = wins + losses;
    return {
      key: r.key,
      count: r.trades.length,
      winRate: decided ? (wins / decided) * 100 : 0,
      netPL: r.trades.reduce((s, t) => s + t.profit, 0),
    };
  });
  rows.sort((a, b) => b.netPL - a.netPL);
  return rows;
}

function renderBreakdownTable(containerEl, rows) {
  if (!rows.length) {
    containerEl.innerHTML = '<p class="hint">No closed trades yet.</p>';
    return;
  }
  let html = '<table class="breakdown-table"><thead><tr><th>Name</th><th>Trades</th><th>Win rate</th><th>Net P/L</th></tr></thead><tbody>';
  for (const r of rows) {
    html += `<tr><td>${r.key}</td><td>${r.count}</td><td>${r.winRate.toFixed(0)}%</td><td class="${moneyClass(r.netPL)}">${fmtMoney(r.netPL)}</td></tr>`;
  }
  html += '</tbody></table>';
  containerEl.innerHTML = html;
}

function renderStreaks(closedTradesAsc) {
  const s = computeStreaks(closedTradesAsc);
  const el = document.getElementById('streaksRow');
  const curLabel = s.currentCount === 0 ? '—' : `${s.currentCount} ${s.currentType === 'win' ? 'win' : 'loss'}${s.currentCount === 1 ? '' : 's'}`;
  const curEmoji = s.currentType === 'win' ? '🔥' : s.currentType === 'loss' ? '❄️' : '';
  el.innerHTML = `
    <div class="streak-card">
      <div class="streak-card-value ${s.currentType === 'win' ? 'pos' : s.currentType === 'loss' ? 'neg' : 'dim'}">${curEmoji} ${curLabel}</div>
      <div class="streak-card-label">Current streak</div>
    </div>
    <div class="streak-card">
      <div class="streak-card-value pos">${s.longestWin}</div>
      <div class="streak-card-label">Longest win streak</div>
    </div>
    <div class="streak-card">
      <div class="streak-card-value neg">${s.longestLoss}</div>
      <div class="streak-card-label">Longest loss streak</div>
    </div>
  `;
}

let equityChart = null, equitySeries = null;
function renderEquityCurve(closedTradesAsc) {
  const container = document.getElementById('equityChart');
  container.innerHTML = '';
  if (!closedTradesAsc.length) {
    container.innerHTML = '<div class="empty-state">No closed trades yet.</div>';
    return;
  }
  equityChart = LightweightCharts.createChart(container, {
    layout: { background: { color: 'transparent' }, textColor: '#8b95a1' },
    grid: { vertLines: { color: '#23292f' }, horzLines: { color: '#23292f' } },
    rightPriceScale: { borderColor: '#23292f' },
    timeScale: { borderColor: '#23292f' },
    width: container.clientWidth,
    height: container.clientHeight,
  });
  equitySeries = equityChart.addLineSeries({ color: '#d98b3f', lineWidth: 2 });

  let running = 0;
  const seen = new Set();
  const data = [];
  for (const t of closedTradesAsc) {
    running += t.profit;
    // one point per unique timestamp, keep the last cumulative value for that second
    if (seen.has(t.closeEpoch)) {
      data[data.length - 1].value = running;
    } else {
      seen.add(t.closeEpoch);
      data.push({ time: t.closeEpoch, value: running });
    }
  }
  equitySeries.setData(data);
  equityChart.timeScale().fitContent();

  new ResizeObserver(() => {
    equityChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  }).observe(container);
}

async function fetchGoals() {
  try {
    const res = await fetch('/api/goals');
    if (!res.ok) return { day: 0, week: 0, month: 0 };
    return await res.json();
  } catch (e) {
    return { day: 0, week: 0, month: 0 };
  }
}

async function saveGoal(periodType, target) {
  await fetch('/api/goals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ period_type: periodType, target }),
  });
}

const PERIOD_LABELS = { day: 'Today', week: 'This week', month: 'This month' };

function renderGoalCards(closedTrades, goals) {
  const el = document.getElementById('goalCards');
  el.innerHTML = '';
  for (const periodType of ['day', 'week', 'month']) {
    const buckets = buildBuckets(closedTrades, periodType);
    const curKey = currentBucketKey(periodType);
    const curBucket = buckets.find(b => b.key === curKey);
    const currentNet = curBucket ? curBucket.netPL : 0;
    const target = Number(goals[periodType]) || 0;

    let pct = 0;
    if (target > 0) pct = Math.max(0, Math.min(100, (currentNet / target) * 100));
    const hit = target > 0 && currentNet >= target;
    let barColor = 'var(--accent)';
    if (currentNet < 0) barColor = 'var(--down)';
    else if (hit) barColor = 'var(--up)';

    // streak of prior COMPLETED periods (excluding the current one) that hit target
    let streak = 0;
    if (target > 0) {
      for (const b of buckets) {
        if (b.key === curKey) continue;
        if (b.netPL >= target) streak++;
        else break;
      }
    }

    const card = document.createElement('div');
    card.className = 'goal-card';
    card.innerHTML = `
      <div class="goal-card-title">${PERIOD_LABELS[periodType]}</div>
      <div class="goal-card-current ${moneyClass(currentNet)}">${fmtMoney(currentNet)}</div>
      <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${pct}%;background:${barColor};"></div></div>
      <div class="goal-card-target-row">
        <span>Target $</span>
        <input type="number" step="any" value="${target || ''}" placeholder="0" data-period="${periodType}" class="goalTargetInput" />
        <button data-period="${periodType}" class="goalSaveBtn">Save</button>
      </div>
      ${streak >= 1 ? `<div class="goal-card-streak">🔥 Hit this goal ${streak} ${periodType}${streak === 1 ? '' : 's'} running before this one</div>` : ''}
    `;
    el.appendChild(card);
  }

  el.querySelectorAll('.goalSaveBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const periodType = btn.dataset.period;
      const input = el.querySelector(`.goalTargetInput[data-period="${periodType}"]`);
      const val = Number(input.value);
      if (!isFinite(val)) return;
      btn.textContent = 'Saving…';
      await saveGoal(periodType, val);
      btn.textContent = 'Save';
      loadReports();
    });
  });
}

function csvEscape(v) {
  const s = String(v === null || v === undefined ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportReportCsv(periodType, buckets) {
  const header = ['Period', 'Trades', 'Wins', 'Losses', 'Breakeven', 'Win rate %', 'Net P/L', 'Avg win', 'Avg loss', 'Avg R', 'Best trade', 'Worst trade'];
  const rows = buckets.map(b => [
    b.label, b.trades.length, b.wins, b.losses, b.breakeven,
    b.winRate.toFixed(1), b.netPL.toFixed(2),
    b.avgWin !== null ? b.avgWin.toFixed(2) : '',
    b.avgLoss !== null ? b.avgLoss.toFixed(2) : '',
    b.avgR !== null ? b.avgR.toFixed(2) : '',
    b.best ? `${b.best.symbol} ${fmtMoney(b.best.profit)}` : '',
    b.worst ? `${b.worst.symbol} ${fmtMoney(b.worst.profit)}` : '',
  ]);
  const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trade-report-${periodType}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderReportTable(periodType, buckets, goals) {
  const target = Number(goals[periodType]) || 0;
  const body = document.getElementById('reportTableBody');
  if (!buckets.length) {
    body.innerHTML = '<tr><td colspan="10" class="hint">No closed trades yet.</td></tr>';
    return;
  }
  body.innerHTML = buckets.map(b => `
    <tr>
      <td>${b.label}</td>
      <td>${b.trades.length} (${b.wins}W/${b.losses}L${b.breakeven ? `/${b.breakeven}BE` : ''})</td>
      <td>${b.winRate.toFixed(0)}%</td>
      <td class="${moneyClass(b.netPL)}">${fmtMoney(b.netPL)}</td>
      <td class="pos">${b.avgWin !== null ? fmtMoney(b.avgWin) : '—'}</td>
      <td class="neg">${b.avgLoss !== null ? fmtMoney(b.avgLoss) : '—'}</td>
      <td>${b.avgR !== null ? b.avgR.toFixed(2) + 'R' : '—'}</td>
      <td class="${b.best ? moneyClass(b.best.profit) : ''}">${b.best ? `${b.best.symbol} ${fmtMoney(b.best.profit)}` : '—'}</td>
      <td class="${b.worst ? moneyClass(b.worst.profit) : ''}">${b.worst ? `${b.worst.symbol} ${fmtMoney(b.worst.profit)}` : '—'}</td>
      <td>${target > 0 ? (b.netPL >= target ? '✅' : '—') : '—'}</td>
    </tr>
  `).join('');
}

async function loadReports() {
  const res = await fetch('/api/trades');
  allTradesCache = await res.json();
  const closed = getClosedTrades(allTradesCache);
  const goals = await fetchGoals();

  renderGoalCards(closed, goals);
  renderEquityCurve(closed);
  renderStreaks(closed);
  renderBreakdownTable(document.getElementById('strategyBreakdown'), computeBreakdown(closed, 'strategy'));
  renderBreakdownTable(document.getElementById('symbolBreakdown'), computeBreakdown(closed, 'symbol'));

  const buckets = buildBuckets(closed, currentReportPeriod);
  renderReportTable(currentReportPeriod, buckets, goals);

  document.getElementById('exportCsvBtn').onclick = () => exportReportCsv(currentReportPeriod, buckets);
}

document.getElementById('periodToggle').querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentReportPeriod = btn.dataset.period;
    document.getElementById('periodToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
    const closed = getClosedTrades(allTradesCache);
    fetchGoals().then(goals => {
      const buckets = buildBuckets(closed, currentReportPeriod);
      renderReportTable(currentReportPeriod, buckets, goals);
      document.getElementById('exportCsvBtn').onclick = () => exportReportCsv(currentReportPeriod, buckets);
    });
  });
});

loadStrategies();
loadTrades();
loadTrashCount();

document.getElementById('syncCloudBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('syncStatus');
  statusEl.textContent = 'Syncing…';
  try {
    const res = await fetch('/api/sync-to-cloud', { method: 'POST' });
    const result = await res.json();
    if (res.ok) {
      statusEl.textContent = `Synced ${result.tradesReceived} trades, ${result.snapshotsReceived} snapshots.`;
    } else {
      statusEl.textContent = `Failed: ${result.error}`;
    }
  } catch (e) {
    statusEl.textContent = 'Failed: could not reach local server.';
  }
  setTimeout(() => { statusEl.textContent = ''; }, 6000);
});
