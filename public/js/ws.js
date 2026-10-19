// ── WebSocket & API Communication ──

let ws;

function scopedWorkerId() {
  return new URLSearchParams(location.search).get('worker');
}

function scopedApiUrl(url) {
  const workerId = scopedWorkerId();
  if (!workerId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'worker=' + encodeURIComponent(workerId);
}

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const workerId = scopedWorkerId();
  const scopedQuery = workerId ? '?worker=' + encodeURIComponent(workerId) : '';
  ws = new WebSocket(proto + '://' + location.host + scopedQuery);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    sendResize(true);
    sendView(true);
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    scheduleReconnect(2000);
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
}

let reconnectTimer = null;
function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) initWS();
  }, delay);
}

// 폰을 잠갔다 켜면 소켓이 죽어 있는 경우가 많다 — 화면이 돌아오면 바로 재연결
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ws) return;
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) scheduleReconnect(0);
});

// 서버에 "지금 보고 있는 워커"를 알린다 — 스냅샷은 보고 있는 워커 것만 받는다
let lastViewKey = null;
function sendView(force) {
  if (!ws || ws.readyState !== 1) return;
  let ids;
  const scoped = scopedWorkerId();
  if (scoped) ids = [String(scoped)];
  else if (typeof layout !== 'undefined' && layout === 'split') ids = Array.from(document.querySelectorAll('#tab-bar .tab')).map(t => t.dataset.id).filter(id => /^\d+$/.test(id));
  else ids = activeTab && /^\d+$/.test(String(activeTab)) ? [String(activeTab)] : [];
  const key = ids.join(',');
  if (!force && key === lastViewKey) return;
  lastViewKey = key;
  ws.send(JSON.stringify({ type: 'view', ids }));
}

function handleMsg(d) {
  if (d.type === 'spawned') ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d.title || '', d.sessionName || '', d.startedAt || null, null);
  if (d.type === 'ui_state') applyUiState(d.ui, false);
  if (d.type === 'log') appendLog(d.id, d.src, d.text);
  if (d.type === 'status') updateStatus(d.id, d.status, d.reason || null);
  if (d.type === 'title') updateTitle(d.id, d.title || '');
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state);
  if (d.type === 'preview_detected') ensurePreview(d.workerId, d.port);
  if (d.type === 'preview_prompt') showPreviewPrompt(d.workerId, d.port, d.contentType);
  if (d.type === 'preview_tunnel') updatePreviewTunnel(d.port, d.url);
  if (d.type === 'preview_closed') closePreview(d.workerId, d.port);
  if (d.type === 'snapshot') {
    lastSnapshotLines[d.id] = d.lines;
    updateChoices(d.id);
    markWorkerOutput(d.id);
    document.querySelectorAll('#logs-' + d.id).forEach(box => {
      var wasAtBottom = isNearBottom(box);
      // 500개 노드를 매번 새로 만들지 않고 바뀐 줄만 갱신한다
      const existing = box.children;
      d.lines.forEach((text, i) => {
        if (i < existing.length) {
          if (existing[i].textContent !== text) existing[i].textContent = text;
          return;
        }
        const line = document.createElement('div');
        line.className = 'log-line stdout';
        line.textContent = text;
        box.appendChild(line);
      });
      while (box.children.length > d.lines.length) box.removeChild(box.lastChild);
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
      else updateJumpButton(box, true);
    });
  }
  if (d.type === 'paths') applyPaths(d);
  if (d.type === 'templates') {
    templates = Array.isArray(d.templates) ? d.templates : [];
    renderDropdown();
  }
  if (d.type === 'presets') {
    presets = Array.isArray(d.presets) ? d.presets : [];
    renderPresets();
  }
}

function notifyActive(id) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active', id: id !== undefined ? String(id) : undefined }));
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

// 워커별 마지막 전송 크기 — 같은 크기면 다시 보내지 않는다 (resize마다 TUI가 전체를 다시 그려 중복이 쌓인다)
const lastSentSizes = {};

function sendResize(force) {
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
  const key = cols + 'x' + rows;
  document.querySelectorAll('.tab').forEach(t => {
    const id = t.dataset.id;
    if (!/^\d+$/.test(id)) return; // 미리보기 탭은 워커가 아니다
    if (force !== true && lastSentSizes[id] === key) return;
    lastSentSizes[id] = key;
    ws.send(JSON.stringify({ type: 'resize', id, cols, rows }));
  });
}

// ── API Calls ──

function showLogin() {
  const loginEl = document.getElementById('login');
  const appEl = document.getElementById('app');
  if (loginEl) loginEl.style.display = 'flex';
  if (appEl) appEl.style.display = 'none';
}

function apiPost(url, body) {
  return fetch(scopedApiUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  }).then(r => {
    // 로그인 자체의 401은 비번 오류 — 호출자가 처리
    if (r.status === 401 && url !== '/api/login') showLogin();
    return r;
  });
}

function apiGet(url) {
  return fetch(scopedApiUrl(url), { credentials: 'include' }).then(r => {
    if (r.status === 401) {
      showLogin();
      return null;
    }
    return r.json();
  });
}

function loadAll() {
  return apiGet('/api/workers')
    .then(list => {
      if (!list) return;
      const activeIds = new Set(list.map(w => String(w.id)));
      Object.keys(customTitles).forEach(id => {
        if (!activeIds.has(String(id))) clearCustomTitle(id);
      });
      list.forEach(w => {
        ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd, w.exitReason || null, w.title || '', w.sessionName || '', w.startedAt || null, w.lastOutputAt || null);
        if (w.aiState) updateAIState(w.id, w.aiState);
      });
    });
}

function loadConfig() {
  return apiGet('/api/config')
    .then(cfg => {
      if (!cfg) return;
      if (cfg.scopedWorkerId && typeof applyScopedMode === 'function') applyScopedMode(cfg.scopedWorkerId);
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (cfg.favorites && !localStorage.getItem('fav')) {
        favorites = cfg.favorites;
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
