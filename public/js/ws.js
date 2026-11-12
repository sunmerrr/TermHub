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
    // 서버가 재시작됐으면(재부팅 등) 워커 목록이 달라져 있다 — 다시 받아 유령 탭을 정리한다
    if (wsConnectedBefore) loadAll();
    wsConnectedBefore = true;
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    scheduleReconnect(2000);
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
}

let wsConnectedBefore = false;
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
  // 화면을 내리면 아무 워커도 안 보고 있다고 알린다 — 서버가 그 사이 알림을 보내고 스냅샷 전송도 멈춘다
  sendView(true);
  if (document.visibilityState !== 'visible' || !ws) return;
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) scheduleReconnect(0);
});

// 사용자가 이 기기에서 실제로 조작 중인지 서버에 알린다 — 보고 있는 워커의 알림은 보내지 않는다
let lastPresenceSent = 0;
function sendPresence() {
  const now = Date.now();
  if (!ws || ws.readyState !== 1 || now - lastPresenceSent < 20000) return;
  lastPresenceSent = now;
  ws.send(JSON.stringify({ type: 'presence' }));
}
['pointerdown', 'keydown', 'wheel', 'touchstart', 'focus'].forEach(type => {
  window.addEventListener(type, sendPresence, { passive: true, capture: true });
});

// 서버에 "지금 보고 있는 워커"를 알린다 — 스냅샷은 보고 있는 워커 것만 받는다
let lastViewKey = null;
function sendView(force) {
  if (!ws || ws.readyState !== 1) return;
  let ids;
  const scoped = scopedWorkerId();
  if (document.visibilityState !== 'visible') ids = [];
  else if (scoped) ids = [String(scoped)];
  else if (typeof layout !== 'undefined' && layout === 'split') ids = Array.from(document.querySelectorAll('#tab-bar .tab')).map(t => t.dataset.id).filter(id => /^\d+$/.test(id));
  else ids = activeTab && /^\d+$/.test(String(activeTab)) ? [String(activeTab)] : [];
  const key = ids.join(',');
  if (!force && key === lastViewKey) return;
  lastViewKey = key;
  ws.send(JSON.stringify({ type: 'view', ids }));
}

function handleMsg(d) {
  if (d.type === 'spawned') ensureCard(d.id, d.cwd, d.status, [], d.cmd, d.reason || null, d.title || '', d.sessionName || '', d.startedAt || null, null, d.claudeName || '');
  if (d.type === 'claude') updateClaudeName(d.id, d.claudeName || '');
  if (d.type === 'ui_state') applyUiState(d.ui, false);
  if (d.type === 'status') updateStatus(d.id, d.status, d.reason || null);
  if (d.type === 'title') updateTitle(d.id, d.title || '');
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state, d.since);
  if (d.type === 'task') updateTask(d.id, d.task);
  if (d.type === 'git') updateGitInfo(d.id, d.git);
  if (d.type === 'preview_detected') ensurePreview(d.workerId, d.port);
  if (d.type === 'preview_prompt') showPreviewPrompt(d.workerId, d.port, d.contentType);
  if (d.type === 'preview_tunnel') updatePreviewTunnel(d.port, d.url);
  if (d.type === 'preview_closed') closePreview(d.workerId, d.port);
  if (d.type === 'term') writeTermSeed(d);
  if (d.type === 'out') writeTermOutput(d);
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

// 워커별 마지막 전송 크기 — 같은 크기면 다시 보내지 않는다 (resize마다 TUI가 전체를 다시 그려 중복이 쌓인다)
const lastSentSizes = {};

function sendResize(force) {
  if (!ws || ws.readyState !== 1) return;
  const MIN_COLS = 8;
  const MIN_ROWS = 4;
  // 보이는 터미널 하나로 크기를 재서 모든 워커에 같은 크기를 제안한다 (숨은 탭 패널은 크기가 0이라 잴 수 없다)
  const visible = Object.values(terms).find(x => x.box.clientWidth > 0 && x.box.clientHeight > 0 && x.box.getClientRects().length > 0);
  if (!visible) return;
  const dims = visible.fit.proposeDimensions();
  if (!dims || !isFinite(dims.cols) || !isFinite(dims.rows)) return;
  const cols = Math.max(MIN_COLS, dims.cols);
  const rows = Math.max(MIN_ROWS, dims.rows);
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
      // 서버에 없는 워커의 탭은 유령이다 — 화면에서만 지운다
      document.querySelectorAll('#tab-bar .tab').forEach(tab => {
        if (!activeIds.has(String(tab.dataset.id))) removeWorkerDom(tab.dataset.id);
      });
      list.forEach(w => {
        ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd, w.exitReason || null, w.title || '', w.sessionName || '', w.startedAt || null, w.lastOutputAt || null, w.claudeName || '');
        if (w.aiState) updateAIState(w.id, w.aiState, w.aiStateAt);
        updateTask(w.id, w.task || '');
        updateGitInfo(w.id, w.git || null);
        if (w.claudeName) updateClaudeName(w.id, w.claudeName);
      });
    });
}

function loadConfig() {
  return apiGet('/api/config')
    .then(cfg => {
      if (!cfg) return;
      if (cfg.scopedWorkerId && typeof applyScopedMode === 'function') applyScopedMode(cfg.scopedWorkerId);
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (Number(cfg.promptCacheTtlMinutes) > 0) window._cacheTtlMin = Number(cfg.promptCacheTtlMinutes);
      if (cfg.favorites && !localStorage.getItem('fav')) {
        favorites = cfg.favorites;
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
