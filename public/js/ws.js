// ── WebSocket & API Communication ──

let ws;

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    sendResize();
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    setTimeout(initWS, 2000);
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
}

function handleMsg(d) {
  if (d.type === 'spawned') ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null);
  if (d.type === 'log') appendLog(d.id, d.src, d.text);
  if (d.type === 'status') updateStatus(d.id, d.status, d.reason || null);
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state);
  if (d.type === 'snapshot') {
    document.querySelectorAll('#logs-' + d.id).forEach(box => {
      var wasAtBottom = isNearBottom(box);
      box.innerHTML = '';
      d.lines.forEach(text => {
        const line = document.createElement('div');
        line.className = 'log-line stdout';
        markPrompt(line, text);
        line.textContent = text;
        box.appendChild(line);
      });
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
    });
  }
}

function notifyActive() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active' }));
}

// ── Terminal Resize ──

function measureChar(box) {
  const span = document.createElement('span');
  span.className = 'log-line';
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.textContent = 'X';
  box.appendChild(span);
  const rect = span.getBoundingClientRect();
  box.removeChild(span);
  return { w: rect.width, h: rect.height };
}

function sendResize() {
  if (!ws || ws.readyState !== 1) return;
  const MIN_COLS = 8;
  const MIN_ROWS = 4;
  const box = Array.from(document.querySelectorAll('.logs'))
    .find(el => el.clientWidth > 0 && el.clientHeight > 0 && el.getClientRects().length > 0);
  if (!box || !box.clientWidth) return;
  const ch = measureChar(box);
  if (!ch.w || !ch.h) return;
  const style = getComputedStyle(box);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const innerW = Math.max(0, box.clientWidth - padX);
  const innerH = Math.max(0, box.clientHeight - padY);
  const cols = Math.max(MIN_COLS, Math.floor(innerW / ch.w));
  const rows = Math.max(MIN_ROWS, Math.floor(innerH / ch.h));
  document.querySelectorAll('.tab').forEach(t => {
    ws.send(JSON.stringify({ type: 'resize', id: t.dataset.id, cols, rows }));
  });
}

// ── API Calls ──

function apiPost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  });
}

function apiGet(url) {
  return fetch(url, { credentials: 'include' }).then(r => r.json());
}

function loadAll() {
  apiGet('/api/workers')
    .then(list => list.forEach(w => {
      ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd, w.exitReason || null);
      if (w.aiState) updateAIState(w.id, w.aiState);
    }));
}

function loadConfig() {
  apiGet('/api/config')
    .then(cfg => {
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (cfg.favorites && !localStorage.getItem('fav')) {
        favorites = cfg.favorites;
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
