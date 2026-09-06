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
