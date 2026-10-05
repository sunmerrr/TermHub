// ── Layout & Tab Management ──

let layout = localStorage.getItem('layout') || 'tab';
let activeTab = null;

function setLayout(mode) {
  layout = mode;
  localStorage.setItem('layout', mode);
  document.getElementById('tab-mode').style.display = mode === 'tab' ? 'flex' : 'none';
  document.getElementById('split-mode').style.display = mode === 'split' ? 'block' : 'none';
  document.getElementById('split-content').style.display = mode === 'split' ? 'grid' : 'none';
  document.getElementById('layout-tab-btn').classList.toggle('layout-active', mode === 'tab');
  document.getElementById('layout-split-btn').classList.toggle('layout-active', mode === 'split');
  updateSplitGrid();
  setTimeout(sendResize, 50);
}

function updateSplitGrid() {
  const sc = document.getElementById('split-content');
  const cards = sc.querySelectorAll('.card');
  const n = cards.length;
  if (n === 0) return;

  let cols, rows;
  if (n <= 3) {
    cols = n; rows = 1;
  } else {
    cols = Math.ceil(n / 2); rows = 2;
  }

  sc.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  sc.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}

// 대기(waiting)·핀 탭은 CSS order로만 앞당긴다 — DOM 순서(드래그 정렬)는 그대로 둬서
// 상태가 풀리면 원래 자리로 돌아간다. 브라우저 탭 제목에도 대기 개수를 표시한다.
function refreshTabPriority() {
  let waiting = 0;
  document.querySelectorAll('#tab-bar .tab').forEach(tab => {
    const isWaiting = !!tab.querySelector('.tab-dot.ai-waiting');
    const isPinned = tab.dataset.pinned === '1';
    tab.classList.toggle('waiting', isWaiting);
    tab.style.order = isPinned ? -2 : (isWaiting ? -1 : 0);
    if (isWaiting) waiting++;
  });
  document.title = waiting ? '(' + waiting + ') TermHub' : 'TermHub';
}

// ── Shared UI state (서버 저장: 탭 순서·핀·마지막 활성 탭) ──

let uiState = { tabOrder: [], pinned: [], activeTab: null };
let uiStateSaveTimer = null;
let uiStatePending = {};
// 이 클라이언트가 직접 스폰한 워커만 자동으로 활성 탭이 된다 (다른 기기의 스폰이 화면을 뺏지 않도록)
let pendingSpawnSelect = false;

function isWorkerTabId(id) {
  return /^\d+$/.test(String(id));
}

function currentWorkerTabOrder() {
  return Array.from(document.querySelectorAll('#tab-bar .tab'))
    .map(t => t.dataset.id)
    .filter(isWorkerTabId);
}

function saveUiState(partial) {
  Object.assign(uiState, partial);
  if (typeof isScopedMode === 'function' && isScopedMode()) return;
  Object.assign(uiStatePending, partial);
  clearTimeout(uiStateSaveTimer);
  uiStateSaveTimer = setTimeout(() => {
    const body = uiStatePending;
    uiStatePending = {};
    apiPost('/api/ui-state', body);
  }, 300);
}

function applyUiState(ui, initial) {
  uiState = Object.assign({ tabOrder: [], pinned: [], activeTab: null }, ui || {});
  const bar = document.getElementById('tab-bar');
  const pinned = new Set(uiState.pinned.map(String));
  const tabs = Array.from(bar.querySelectorAll('.tab'));
  tabs.forEach(tab => {
    if (!isWorkerTabId(tab.dataset.id)) return;
    tab.dataset.pinned = pinned.has(tab.dataset.id) ? '1' : '';
    document.querySelectorAll('#pin-' + tab.dataset.id).forEach(btn => btn.classList.toggle('on', pinned.has(tab.dataset.id)));
    renderTitle(tab.dataset.id);
  });

  // 저장된 순서 먼저, 목록에 없는 탭(새 워커·미리보기)은 현재 순서대로 뒤에
  const byId = new Map(tabs.map(t => [t.dataset.id, t]));
  const ordered = uiState.tabOrder.map(String).filter(id => byId.has(id)).map(id => byId.get(id));
  const rest = tabs.filter(t => !ordered.includes(t));
  const desired = ordered.concat(rest);
  // 순서가 그대로면 DOM을 건드리지 않는다 (다른 기기의 activeTab 저장 브로드캐스트마다 깜빡이지 않도록)
  if (desired.some((t, i) => t !== tabs[i])) desired.forEach(t => bar.appendChild(t));
  refreshTabPriority();

  if (initial) {
    const saved = uiState.activeTab && byId.has(uiState.activeTab) ? uiState.activeTab : null;
    const first = currentWorkerTabOrder()[0] || (tabs[0] && tabs[0].dataset.id);
    if (saved || first) selectTab(saved || first);
  }
}

function loadUiState() {
  if (typeof isScopedMode === 'function' && isScopedMode()) {
    if (!activeTab) {
      const first = document.querySelector('#tab-bar .tab');
      if (first) selectTab(first.dataset.id);
    }
    return Promise.resolve();
  }
  return apiGet('/api/ui-state')
    .then(ui => applyUiState(ui && !ui.error ? ui : null, true))
    .catch(() => applyUiState(null, true));
}

function togglePin(id) {
  const set = new Set(uiState.pinned.map(String));
  if (set.has(String(id))) set.delete(String(id)); else set.add(String(id));
  saveUiState({ pinned: [...set] });
  applyUiState(uiState, false);
}

function selectTab(id, fromUser) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.id === id));
  setTimeout(sendResize, 0);
  if (fromUser && isWorkerTabId(id)) saveUiState({ activeTab: String(id) });
}

function switchTab(delta) {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  if (!tabs.length) return;
  if (!activeTab) {
    selectTab(tabs[0].dataset.id);
    return;
  }
  const idx = tabs.findIndex(t => t.dataset.id === activeTab);
  const next = idx === -1 ? 0 : (idx + delta + tabs.length) % tabs.length;
  selectTab(tabs[next].dataset.id, true);
}

function bindTabDrag(tab) {
  tab.draggable = true;
  tab.addEventListener('dragstart', e => {
    tab.classList.add('dragging');
    // 드래그 중에는 order 우선순위를 끄고 DOM 순서 그대로 보여야 드롭 위치가 맞는다
    tabBar.classList.add('reordering');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.id);
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
    tabBar.classList.remove('reordering');
  });
}

function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.tab:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  els.forEach(el => {
    const box = el.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  });
  return closest.element;
}

const tabBar = document.getElementById('tab-bar');
if (tabBar) {
  const indicator = document.createElement('div');
  indicator.id = 'tab-drop-indicator';
  tabBar.appendChild(indicator);

  tabBar.addEventListener('dragover', e => {
    e.preventDefault();
    const dragging = document.querySelector('.tab.dragging');
    if (!dragging) return;
    const after = getDragAfterElement(tabBar, e.clientX);
    if (!after) tabBar.appendChild(dragging);
    else tabBar.insertBefore(dragging, after);

    const target = after || tabBar.lastElementChild;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const barRect = tabBar.getBoundingClientRect();
    const x = after ? rect.left - barRect.left : rect.right - barRect.left;
    indicator.style.transform = `translateX(${x}px)`;
    indicator.classList.add('show');
  });

  tabBar.addEventListener('dragleave', e => {
    if (e.relatedTarget && tabBar.contains(e.relatedTarget)) return;
    indicator.classList.remove('show');
  });

  tabBar.addEventListener('drop', () => {
    indicator.classList.remove('show');
    saveUiState({ tabOrder: currentWorkerTabOrder() });
  });
}
