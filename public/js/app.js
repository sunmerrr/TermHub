// ── Init & Event Binding ──

function enterApp() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (scopedWorkerId()) applyScopedMode(scopedWorkerId());
  loadConfig();
  initWS();
  loadAll().then(() => loadUiState()).then(() => {
    // 푸시 알림 클릭 등으로 ?focus=ID 진입 시 해당 워커 탭을 연다
    const params = new URLSearchParams(location.search);
    const focus = params.get('focus');
    if (focus && typeof focusWorker === 'function') {
      focusWorker(focus);
      params.delete('focus');
      const rest = params.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : ''));
    }
  });
  setLayout(layout);
  loadPresets();
  if (!scopedWorkerId()) loadTemplates();
  if (typeof initPush === 'function') initPush();
}

function applyScopedMode(workerId) {
  document.body.dataset.scopedWorker = workerId;
  const toolbar = document.getElementById('spawn-toolbar');
  const scanBtn = document.getElementById('scan-btn');
  const spawnBtn = document.getElementById('toggle-toolbar-btn');
  const pushBtn = document.getElementById('push-btn');
  if (toolbar) toolbar.style.display = 'none';
  if (scanBtn) scanBtn.style.display = 'none';
  if (spawnBtn) spawnBtn.style.display = 'none';
  if (pushBtn) pushBtn.style.display = 'none';
}

function doLogin() {
  const pw = document.getElementById('pw').value;
  apiPost('/api/login', { pw })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        enterApp();
      } else {
        document.getElementById('login-err').style.display = 'block';
      }
    });
}

// 기존 쿠키로 자동 로그인 시도 — 유효하면 로그인 화면 건너뜀
fetch(scopedApiUrl('/api/workers'), { credentials: 'include' }).then(r => {
  if (r.ok) enterApp();
});

// ── Toolbar Toggle ──

function toggleToolbar() {
  const toolbar = document.getElementById('spawn-toolbar');
  const isOpen = toolbar.style.display !== 'none';
  toolbar.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) document.getElementById('cwd-input').focus();
}

// ── Event Binding ──

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('toggle-toolbar-btn').addEventListener('click', toggleToolbar);
document.getElementById('dir-btn').addEventListener('click', toggleDropdown);
document.getElementById('spawn-btn').addEventListener('click', () => {
  spawnSession();
  document.getElementById('spawn-toolbar').style.display = 'none';
});
document.getElementById('scan-btn').addEventListener('click', scanSessions);
document.getElementById('push-btn').addEventListener('click', togglePush);
document.getElementById('add-fav-btn').addEventListener('click', addFavorite);
document.getElementById('save-tpl-btn').addEventListener('click', saveCurrentAsTemplate);
document.getElementById('layout-tab-btn').addEventListener('click', () => setLayout('tab'));
document.getElementById('layout-split-btn').addEventListener('click', () => setLayout('split'));

document.addEventListener('click', e => {
  closeDropdown();
  if (!e.target.closest('.toolkit-wrap')) closeToolkitPopups();
});

window.addEventListener('resize', sendResize);

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', e => {
  if (!activeTab) return;

  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
  const hasSelection = !!(window.getSelection && window.getSelection().toString());
  if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    switchTab(-1);
    return;
  } else if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    switchTab(1);
    return;
  }

  if (e.key === 'Escape') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Escape');
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'BTab');
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Tab');
  } else if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
    if (hasSelection) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'C-c');
  } else if (e.key === 'Enter' && !e.target.closest('.input-row') && !e.target.closest('.toolbar') && !e.target.closest('#login')) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Enter');
  } else if (e.key === 'ArrowUp') {
    if (e.target.closest('.input-row')) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'Up');
  } else if (e.key === 'ArrowDown') {
    if (e.target.closest('.input-row')) return;
    e.preventDefault();
    sendSpecialKey(activeTab, 'Down');
  } else if (!inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // 입력 필드 밖에서 일반 키 입력 시 터미널로 직접 전달
    if (e.key === 'Backspace') {
      e.preventDefault();
      sendSpecialKey(activeTab, 'BSpace');
    } else if (e.key === ' ') {
      e.preventDefault();
      sendSpecialKey(activeTab, 'Space');
    } else if (e.key.length === 1) {
      e.preventDefault();
      sendSpecialKey(activeTab, e.key);
    }
  }
});
