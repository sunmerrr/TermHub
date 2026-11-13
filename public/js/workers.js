// ── Worker Card UI ──

let customTitles = {};

function saveCustomTitles() {
}

function clearCustomTitle(id) {
  if (!Object.prototype.hasOwnProperty.call(customTitles, id)) return;
  delete customTitles[id];
  saveCustomTitles();
}

function getTitleBase(id, cmd) {
  return customTitles[id] || cmd || 'claude';
}

function trimTitle(text) {
  const max = 24;
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function renderTitle(id, cwd, cmd) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  const tabCwd = cwd || (tab && tab.dataset.cwd) || '';
  const tabCmd = cmd || (tab && tab.dataset.cmd) || 'claude';
  const tabTitle = customTitles[id] || (tab && tab.dataset.title) || '';
  // 직접 지은 제목이 없으면 Claude 세션 간 메시징 이름(pokerdiary-7f)을 쓴다 — 세션끼리 부를 때 쓰는 이름과 탭이 일치한다
  const claudeName = (tab && tab.dataset.claudeName) || '';
  const folder = tabCwd.replace(/\/$/, '').split('/').pop() || tabCwd;
  let text = tab && tab.dataset.pinned === '1' ? '📌 ' : '';
  if (tabTitle) {
    text += '#' + id + ' ' + tabTitle;
  } else if (claudeName) {
    text += '#' + id + ' ' + claudeName;
  } else {
    text += '#' + id + ' ' + tabCmd + ' · ' + folder;
  }
  ['tab-label-' + id, 'card-title-' + id].forEach(function(elId) {
    document.querySelectorAll('#' + elId).forEach(function(el) {
      el.textContent = text;
    });
  });
}

function killBtnHtml(id, status) {
  if (status === 'stopped' || status === 'completed') {
    return '<button class="kill-btn" id="kill-' + id + '" style="border-color:#f85149;color:#f85149">Remove</button>';
  }
  return '<button class="kill-btn" id="kill-' + id + '">Stop</button>';
}

function isScopedMode() {
  return typeof scopedWorkerId === 'function' && !!scopedWorkerId();
}

function cardActionButtonsHtml(id, status) {
  if (isScopedMode()) return '';
  return '<button class="pin-btn" id="pin-' + id + '" title="Pin tab">📌</button>' +
    '<button class="share-btn" id="share-' + id + '" title="Scoped URL">Share</button>' +
    '<button class="diff-btn" id="diff-' + id + '" title="Git Diff">Diff</button>' +
    killBtnHtml(id, status);
}

// ⌨ 팝업의 특수 키. keys는 tmux send-keys 키 이름을 순서대로 보낸다.
// 폰은 입력창으로 글자만 보낼 수 있어 커서 이동·편집·Ctrl 조합을 여기서 누른다
const SPECIAL_KEY_GROUPS = [
  { label: 'Keys', keys: [
    ['esc', ['Escape']], ['↑', ['Up']], ['↓', ['Down']], ['↵', ['Enter'], 'key-enter'],
    ['←', ['Left']], ['→', ['Right']], ['tab', ['Tab']], ['⇧tab', ['BTab'], '', '모드 전환 (Claude: 권한 모드)'],
    ['home', ['Home']], ['end', ['End']], ['space', ['Space']], ['⌫', ['BSpace']],
    ['del', ['DC']], ['esc×2', ['Escape', 'Escape'], '', 'Claude: 이전 메시지로 되돌리기']
  ] },
  { label: 'Ctrl', keys: [
    ['⌃c', ['C-c'], '', '중단'], ['⌃c×2', ['C-c', 'C-c'], '', '종료'], ['⌃d', ['C-d'], '', '입력 끝(EOF)·셸 종료'], ['⌃l', ['C-l'], '', '화면 다시 그리기'],
    ['⌃u', ['C-u'], '', '줄 앞부분 지우기'], ['⌃k', ['C-k'], '', '줄 뒷부분 지우기'], ['⌃w', ['C-w'], '', '단어 지우기'], ['⌃r', ['C-r'], '', '입력 기록 검색'],
    ['⌃a', ['C-a'], '', '줄 처음으로'], ['⌃e', ['C-e'], '', '줄 끝으로'], ['⌃z', ['C-z'], '', '일시 정지(백그라운드로)'], ['⌃\\', ['C-\\'], '', '강제 종료(SIGQUIT)']
  ] },
  { label: 'Claude', keys: [
    ['/', ['/'], '', '슬래시 명령'], ['@', ['@'], '', '파일 언급'], ['!', ['!'], '', '셸 명령 모드'], ['?', ['?'], '', '단축키 도움말'],
    ['⌃o', ['C-o'], '', '대화 기록 펼치기'], ['⌃t', ['C-t'], '', '할 일 목록'], ['⌃b', ['C-b'], '', '실행 중인 작업을 백그라운드로'], ['⌃_', ['C-_'], '', '입력 되돌리기']
  ] }
];

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function specialKeysHtml() {
  return SPECIAL_KEY_GROUPS.map(g =>
    '<div class="tk-label">' + g.label + '</div>' +
    '<div class="key-grid">' +
      g.keys.map(([label, keys, cls, title]) =>
        '<button class="key-btn' + (cls ? ' ' + cls : '') + '" data-keys="' + escapeHtml(JSON.stringify(keys)) + '"' +
        (title ? ' title="' + escapeHtml(title) + '"' : '') + '>' + escapeHtml(label) + '</button>'
      ).join('') +
    '</div>'
  ).join('');
}

function ensureCard(id, cwd, status, logs, cmd, reason, title, sessionName, startedAt, lastOutputAt, claudeName) {
  if (document.getElementById('card-' + id)) return;

  const cmdLabel = cmd || 'claude';
  if (title) customTitles[id] = title;
  workerTimes[id] = { startedAt: startedAt || null, lastOutputAt: lastOutputAt || null };
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'card-' + id;
  card.innerHTML =
    '<div class="card-header">' +
      '<span class="card-title" id="card-title-' + id + '">#' + id + ' ' + cmdLabel + ' · ' + (cwd.replace(/\/$/, '').split('/').pop() || cwd) + '</span>' +
      '<span class="card-meta" id="meta-' + id + '"></span>' +
      '<span class="badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="badge-' + id + '">' + status + '</span>' +
      cardActionButtonsHtml(id, status) +
    '</div>' +
    '<div class="card-cwd"><span class="cwd-path">' + displayPath(cwd) + '</span><span class="card-git" id="git-' + id + '"></span><span class="card-usage" id="usage-' + id + '"></span><span class="card-task" id="task-' + id + '"></span></div>' +
    '<div class="exit-reason" id="exit-reason-' + id + '"></div>' +
    '<div class="logs-wrap">' +
      '<div class="logs" id="logs-' + id + '"></div>' +
      '<button class="jump-bottom" id="jump-' + id + '" title="맨 아래로">↓</button>' +
    '</div>' +
    '<div class="choices" id="choices-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '"' + (status === 'stopped' || status === 'completed' ? ' style="display:none"' : '') + '>' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<button id="send-' + id + '">Send</button>' +
      '<button class="attach-btn" id="attach-' + id + '" title="파일 첨부 (붙여넣기·드래그도 가능)">📎</button>' +
      '<input type="file" id="file-' + id + '" multiple hidden>' +
      '<div class="toolkit-wrap">' +
        '<button class="toolkit-toggle" id="tk-btn-' + id + '">⌨</button>' +
        '<div class="toolkit-popup" id="tk-popup-' + id + '">' +
          specialKeysHtml() +
          '<div class="tk-label tk-label-row">Quick<button class="tk-edit" id="tk-edit-' + id + '" title="빠른 입력 편집">✎</button></div>' +
          '<div class="preset-list" id="presets-' + id + '"></div>' +
          '<div class="tk-label">Text size</div>' +
          '<div class="font-ctrl">' +
            '<button class="key-btn" id="font-dec-' + id + '">A−</button>' +
            '<span class="font-size-label">' + logFontSize + 'px</span>' +
            '<button class="key-btn" id="font-inc-' + id + '">A+</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  if (directTermInput) {
    // PC는 터미널에 바로 입력하므로 아래 입력 줄을 통째로 숨기고(style.css) 📎·⌨만 헤더로 옮긴다
    const tools = document.createElement('span');
    tools.className = 'header-tools';
    tools.id = 'header-tools-' + id;
    if (status === 'stopped' || status === 'completed') tools.style.display = 'none';
    const row = card.querySelector('.input-row');
    ['.attach-btn', 'input[type=file]', '.toolkit-wrap'].forEach(sel => tools.appendChild(row.querySelector(sel)));
    const header = card.querySelector('.card-header');
    header.insertBefore(tools, header.querySelector('.pin-btn'));
  }

  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.id = id;
  panel.appendChild(card.cloneNode(true));
  document.getElementById('tab-content').appendChild(panel);

  const splitCard = card;
  document.getElementById('split-content').appendChild(splitCard);
  updateSplitGrid();

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = id;
  tab.dataset.cwd = cwd;
  tab.dataset.cmd = cmdLabel;
  tab.dataset.sessionName = sessionName || '';
  tab.dataset.title = title || '';
  tab.dataset.claudeName = claudeName || '';
  var folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;
  tab.innerHTML = '<span class="tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="tab-dot-' + id + '"></span><span class="tab-label" id="tab-label-' + id + '">#' + id + ' ' + (cmd || 'claude') + ' · ' + folder + '</span><span class="tab-changes" id="tab-changes-' + id + '"></span><span class="tab-ctx" id="tab-ctx-' + id + '"></span>';
  tab.dataset.pinned = (typeof uiState !== 'undefined' && uiState.pinned.map(String).includes(String(id))) ? '1' : '';
  tab.addEventListener('click', () => selectTab(id, true));
  tab.addEventListener('dblclick', e => {
    e.stopPropagation();
    const current = customTitles[id] || tab.dataset.title || cmdLabel;
    const next = prompt('Tab title', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      delete customTitles[id];
      tab.dataset.title = '';
    } else {
      customTitles[id] = trimTitle(trimmed);
      tab.dataset.title = customTitles[id];
    }
    saveCustomTitles();
    renderTitle(id);
    apiPost('/api/title', { id, title: customTitles[id] || '' });
  });
  bindTabDrag(tab);
  document.getElementById('tab-bar').appendChild(tab);

  // 처음 열린 탭이거나 내가 방금 스폰한 워커일 때만 활성화 — 다른 기기의 스폰이 화면을 바꾸지 않는다
  if (!activeTab || pendingSpawnSelect) {
    pendingSpawnSelect = false;
    selectTab(id);
  }
  refreshTabPriority();
  sendView();

  bindCard(id, panel);
  bindCard(id, splitCard);

  if (status === 'stopped') {
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.onclick = () => removeWorker(id);
    });
    document.querySelectorAll('#input-row-' + id + ', #header-tools-' + id).forEach(el => el.style.display = 'none');
  }

  renderTitle(id, cwd, cmdLabel);
  renderWorkerMeta(id);
  // 터미널은 탭 패널 쪽에만 만든다 — 분할 화면 카드는 레이아웃 전환을 없앤 뒤로 보이지 않는다
  const termBox = panel.querySelector('#logs-' + id);
  if (termBox) createTerminal(id, termBox);
  if (logs) {
    // 첫 출력이 오기 전에도 선택지 버튼을 띄울 수 있도록 초기 로그를 스냅샷으로 삼는다
    lastSnapshotLines[id] = logs.map(l => l.text);
  }
  if (reason) updateExitReason(id, reason);
  if (status === 'running') updateExitReason(id, null);
  restoreDraft(id);
  setTimeout(sendResize, 100);
}

// ── 입력 초안 (기기별) ──
// 폰 브라우저는 백그라운드에서 페이지를 자주 새로 불러온다 — 쓰던 지시문이 사라지지 않게 워커별로 저장한다.
// 서버 재시작 뒤 같은 번호가 다른 워커에 다시 쓰일 수 있어 시작 시각까지 키에 넣는다.
function draftKey(id) {
  const t = workerTimes[id];
  return 'draft:' + id + ':' + ((t && t.startedAt) || '');
}

function saveDraft(id, text) {
  try {
    if (text && text.trim()) localStorage.setItem(draftKey(id), text);
    else localStorage.removeItem(draftKey(id));
  } catch (e) {
    console.warn('draft save failed', e);
  }
}

function restoreDraft(id) {
  let text = null;
  try { text = localStorage.getItem(draftKey(id)); } catch (e) { console.warn('draft load failed', e); }
  if (!text) return;
  document.querySelectorAll('#inp-' + id).forEach(inp => {
    if (inp.value) return;
    inp.value = text;
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight || 30, 120) + 'px';
  });
}

function bindCard(id, root) {
  const q = sel => root.querySelector ? root.querySelector(sel) : document.getElementById(sel.slice(1));

  const killBtn = q('#kill-' + id);
  const sendBtn = q('#send-' + id);
  const inp = q('#inp-' + id);

  const diffBtn = q('#diff-' + id);
  if (diffBtn) diffBtn.addEventListener('click', () => openGitDiff(id));

  const shareBtn = q('#share-' + id);
  if (shareBtn) shareBtn.addEventListener('click', () => shareWorkerUrl(id, shareBtn));

  const pinBtn = q('#pin-' + id);
  if (pinBtn) pinBtn.addEventListener('click', () => togglePin(id));

  if (killBtn) killBtn.addEventListener('click', () => killWorker(id));
  if (sendBtn) sendBtn.addEventListener('click', () => sendInput(id));
  if (inp) {
    // IME 조합 중 Enter 누르면 마지막 글자가 중복되는 크롬 버그 회피:
    // 조합 중일 때는 Enter를 IME 확정용으로 흘려보내고, compositionend에서 전송
    let pendingEnter = false;
    inp.addEventListener('compositionend', () => {
      if (pendingEnter) {
        pendingEnter = false;
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) {
          pendingEnter = true;
          return;
        }
        e.preventDefault();
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
    });
    inp.addEventListener('input', () => {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
      saveDraft(id, inp.value);
    });
    inp.addEventListener('paste', e => {
      const files = e.clipboardData && e.clipboardData.files;
      if (!files || !files.length) return;
      e.preventDefault();
      uploadFiles(id, files);
    });
  }

  // 파일 첨부: 📎 버튼, 카드에 드래그 앤 드롭
  const attachBtn = q('#attach-' + id);
  const fileInput = q('#file-' + id);
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) uploadFiles(id, fileInput.files);
      fileInput.value = '';
    });
  }
  const dropTarget = root.classList && root.classList.contains('card') ? root : q('.card');
  if (dropTarget) {
    dropTarget.addEventListener('dragover', e => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dropTarget.classList.add('dropping');
    });
    dropTarget.addEventListener('dragleave', e => {
      if (!dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('dropping');
    });
    dropTarget.addEventListener('drop', e => {
      dropTarget.classList.remove('dropping');
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      uploadFiles(id, e.dataTransfer.files);
    });
  }

  // Toolkit toggle
  const tkBtn = q('#tk-btn-' + id);
  const tkPopup = q('#tk-popup-' + id);
  if (tkBtn && tkPopup) {
    tkBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = tkPopup.classList.toggle('open');
      tkBtn.classList.toggle('open', isOpen);
      document.querySelectorAll('.toolkit-popup.open').forEach(p => {
        if (p !== tkPopup) {
          p.classList.remove('open');
          p.previousElementSibling.classList.remove('open');
        }
      });
    });
  }

  // Key buttons
  if (root.querySelectorAll) root.querySelectorAll('.key-btn[data-keys]').forEach(btn => {
    btn.addEventListener('click', () => sendKeys(id, JSON.parse(btn.dataset.keys)));
  });

  // Quick presets
  const editBtn = q('#tk-edit-' + id);
  if (editBtn) editBtn.addEventListener('click', e => {
    e.stopPropagation();
    const editing = !document.body.classList.contains('presets-editing');
    document.body.classList.toggle('presets-editing', editing);
  });
  renderPresets();

  // Text size
  const decBtn = q('#font-dec-' + id);
  const incBtn = q('#font-inc-' + id);
  if (decBtn) decBtn.addEventListener('click', e => { e.stopPropagation(); applyLogFontSize(logFontSize - 1, true); });
  if (incBtn) incBtn.addEventListener('click', e => { e.stopPropagation(); applyLogFontSize(logFontSize + 1, true); });

  const logs = q('#logs-' + id);
  const jumpBtn = q('#jump-' + id);
  if (logs) bindPinchZoom(logs);
  if (jumpBtn) {
    jumpBtn.addEventListener('click', () => {
      const t = terms[id];
      if (!t) return;
      t.term.scrollToBottom();
      updateTermJump(id, false);
    });
  }
}

// ── Quick Presets (서버 저장, 모든 기기 공유) ──

let presets = [];

function loadPresets() {
  apiGet('/api/presets').then(d => {
    if (!d) return;
    presets = Array.isArray(d.presets) ? d.presets : [];
    renderPresets();
  }).catch(() => {});
}

function savePresets(next) {
  presets = next;
  renderPresets();
  apiPost('/api/presets', { presets: next });
}

function renderPresets() {
  document.querySelectorAll('.preset-list').forEach(list => {
    const id = list.id.replace('presets-', '');
    list.innerHTML = '';
    presets.forEach((text, idx) => {
      const chip = document.createElement('button');
      chip.className = 'preset-chip';
      chip.textContent = text;
      chip.title = text;
      const del = document.createElement('span');
      del.className = 'preset-del';
      del.textContent = '✕';
      chip.appendChild(del);
      chip.addEventListener('click', e => {
        e.stopPropagation();
        if (document.body.classList.contains('presets-editing')) {
          savePresets(presets.filter((_, i) => i !== idx));
          return;
        }
        closeToolkitPopups();
        notifyActive(id);
        apiPost('/api/input', { id, text });
      });
      list.appendChild(chip);
    });
    const add = document.createElement('button');
    add.className = 'preset-chip preset-add';
    add.textContent = '+';
    add.title = '빠른 입력 추가';
    add.addEventListener('click', e => {
      e.stopPropagation();
      const text = prompt('빠른 입력 문구');
      if (text === null) return;
      const trimmed = text.trim();
      if (!trimmed || presets.includes(trimmed)) return;
      savePresets(presets.concat([trimmed]));
    });
    list.appendChild(add);
  });
}

function closeToolkitPopups() {
  document.querySelectorAll('.toolkit-popup.open').forEach(p => {
    p.classList.remove('open');
    p.previousElementSibling.classList.remove('open');
  });
  document.body.classList.remove('presets-editing');
}

// ── Log Text Size (기기별 설정) ──

const LOG_FONT_MIN = 8;
const LOG_FONT_MAX = 24;
let logFontSize = (function() {
  const saved = parseInt(localStorage.getItem('logFontSize'), 10);
  return saved >= LOG_FONT_MIN && saved <= LOG_FONT_MAX ? saved : 12;
})();
document.documentElement.style.setProperty('--log-font', logFontSize + 'px');

function applyLogFontSize(px, resize) {
  const next = Math.min(LOG_FONT_MAX, Math.max(LOG_FONT_MIN, Math.round(px)));
  if (next === logFontSize && !resize) return;
  logFontSize = next;
  document.documentElement.style.setProperty('--log-font', next + 'px');
  localStorage.setItem('logFontSize', String(next));
  document.querySelectorAll('.font-size-label').forEach(el => { el.textContent = next + 'px'; });
  Object.values(terms).forEach(t => { t.term.options.fontSize = next; });
  // 글자 크기가 바뀌면 터미널 cols/rows도 달라진다
  if (resize) sendResize();
}

function bindPinchZoom(box) {
  let startDist = 0;
  let startSize = 0;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  box.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    startDist = dist(e.touches);
    startSize = logFontSize;
  }, { passive: true });
  box.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();
    applyLogFontSize(startSize * (dist(e.touches) / startDist), false);
  }, { passive: false });
  box.addEventListener('touchend', () => {
    if (!startDist) return;
    startDist = 0;
    applyLogFontSize(logFontSize, true);
  });
}

// ── Worker Meta (경과 시간 · 마지막 출력) ──

const workerTimes = {};

function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

function renderWorkerMeta(id) {
  const t = workerTimes[id];
  if (!t) return;
  const now = Date.now();
  const parts = [];
  if (t.startedAt) parts.push('up ' + fmtDuration(now - t.startedAt));
  if (t.lastOutputAt) parts.push(now - t.lastOutputAt < 60000 ? 'active now' : 'last ' + fmtDuration(now - t.lastOutputAt) + ' ago');
  const text = parts.join(' · ');
  document.querySelectorAll('#meta-' + id).forEach(el => {
    el.textContent = text;
    el.title = (t.startedAt ? 'Started ' + new Date(t.startedAt).toLocaleString() : '') +
      (t.lastOutputAt ? '\nLast output ' + new Date(t.lastOutputAt).toLocaleString() : '');
  });
}

function markWorkerOutput(id) {
  if (!workerTimes[id]) workerTimes[id] = { startedAt: null, lastOutputAt: null };
  workerTimes[id].lastOutputAt = Date.now();
  renderWorkerMeta(id);
}

setInterval(() => Object.keys(workerTimes).forEach(renderWorkerMeta), 30000);

// ── Terminal (xterm.js) ──
// 서버가 tmux pane 출력 바이트를 그대로 보내고(out), 처음 볼 때·크기가 바뀔 때 시작 화면(term)을 보낸다.
// 터미널 크기는 서버가 정한 pane 크기를 따른다 — 이 기기 화면에서 계산한 크기는 sendResize로 제안만 한다.

const terms = {};
// xterm.js는 앱의 질의(DA·커서 위치·색 조회 등)에 onData로 자동 응답한다. tmux가 이미 대신 답했으므로
// 이것까지 보내면 앱에 쓰레기 입력이 된다 — 사용자 입력이 아닌 응답 형태는 버린다
const TERM_REPLY_RE = /^\x1b(\[[?>]?[\d;]*[cnR]|\[[IO]|\][^\x07\x1b]*(\x07|\x1b\\)|P[^\x1b]*\x1b\\)$/;
const TERM_SCAN_THROTTLE_MS = 250;
// 마우스·트랙패드 기기(PC)는 터미널에 바로 입력하고 아래 입력창을 숨긴다(style.css의 pointer: fine).
// 터치 기기는 xterm.js의 한글 조합이 불안정해 입력창을 그대로 쓴다. 화면 너비가 아니라 입력 방식으로 나눈다
const directTermInput = !!(window.matchMedia && matchMedia('(pointer: fine)').matches);

// xterm.js의 터치 스크롤은 iOS Safari에서 동작하지 않아(보이는 화면만 보이고 위로 못 올라간다) 한 손가락 스와이프를 직접 줄 스크롤로 바꾼다.
// 두 손가락은 글자 크기 핀치(bindPinchZoom)에 맡긴다.
const TOUCH_MOMENTUM_DECAY = 0.95;
const TOUCH_MOMENTUM_MIN = 0.3;

function bindTouchScroll(term, box) {
  let lastY = null;
  let lastT = 0;
  let velocity = 0;
  let pending = 0;
  let raf = 0;
  // 브라우저 기본 팬이 끼어들면 첫 touchmove 뒤로 이벤트가 끊긴다 — 세로는 줄 스크롤, 가로는 아래에서 상자를 직접 민다
  box.style.touchAction = 'none';
  let lastX = 0;
  const lineHeight = () => {
    const screen = box.querySelector('.xterm-screen');
    return screen && term.rows ? screen.clientHeight / term.rows : 16;
  };
  // 손가락이 아래로 움직이면(dy > 0) 이전 출력 쪽(위)으로 올라간다
  const scrollBy = dy => {
    pending += dy;
    const lh = lineHeight();
    const lines = Math.trunc(pending / lh);
    if (!lines) return;
    pending -= lines * lh;
    term.scrollLines(-lines);
  };
  const onMove = e => {
    if (e.touches.length !== 1 || lastY === null) return;
    const y = e.touches[0].clientY;
    const now = performance.now();
    const dy = y - lastY;
    if (now > lastT) velocity = dy / (now - lastT) * 16;
    lastY = y;
    lastT = now;
    e.preventDefault();
    e.stopPropagation();
    // 다른 기기가 크기를 쥐어 터미널이 상자보다 넓을 때만 가로로 밀린다
    box.scrollLeft -= e.touches[0].clientX - lastX;
    lastX = e.touches[0].clientX;
    scrollBy(dy);
  };
  let target = null;
  const release = () => {
    if (!target) return;
    target.removeEventListener('touchmove', onMove);
    target.removeEventListener('touchend', onEnd);
    target.removeEventListener('touchcancel', onEnd);
    target = null;
  };
  const onEnd = e => {
    if (e.touches.length) return;
    release();
    if (lastY === null) return;
    lastY = null;
    // 손을 떼기 직전에 멈춰 있었다면 관성 없이 끝낸다
    if (e.type === 'touchcancel' || performance.now() - lastT > 100) return;
    const step = () => {
      velocity *= TOUCH_MOMENTUM_DECAY;
      if (Math.abs(velocity) < TOUCH_MOMENTUM_MIN) return;
      scrollBy(velocity);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  // 터치 이벤트는 손가락이 처음 닿은 요소로만 간다. xterm.js가 스크롤하며 줄 DOM을 새로 그리면 그 요소가 문서에서 빠져
  // 상자까지 올라오지 않으므로, 이동·종료 리스너는 그 요소에 직접 단다
  box.addEventListener('touchstart', e => {
    cancelAnimationFrame(raf);
    release();
    if (e.touches.length !== 1) { lastY = null; return; }
    lastY = e.touches[0].clientY;
    lastX = e.touches[0].clientX;
    lastT = performance.now();
    velocity = 0;
    pending = 0;
    target = e.target;
    target.addEventListener('touchmove', onMove, { passive: false });
    target.addEventListener('touchend', onEnd);
    target.addEventListener('touchcancel', onEnd);
    // xterm.js 자체 터치 스크롤과 겹치지 않게 막는다
    e.stopPropagation();
  }, { capture: true, passive: true });
}

function createTerminal(id, box) {
  if (terms[id] || typeof Terminal === 'undefined') return;
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Consolas, monospace',
    fontSize: logFontSize,
    scrollback: 5000,
    cursorBlink: false,
    theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3', selectionBackground: '#264f78' }
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  // 터치 기기에서는 터미널을 눌러도 화상 키보드를 띄우지 않는다 — 입력은 아래 입력창으로 한다
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches) {
    term.textarea.setAttribute('inputmode', 'none');
    bindTouchScroll(term, box);
  }
  // 입력창이 없는 PC에서도 이미지 붙여넣기로 첨부할 수 있게 한다 — xterm.js보다 먼저 받아야 하므로 capture 단계에서 처리
  box.addEventListener('paste', e => {
    const files = e.clipboardData && e.clipboardData.files;
    if (!files || !files.length) return;
    e.preventDefault();
    e.stopPropagation();
    uploadFiles(id, files);
  }, true);
  term.onData(data => {
    if (TERM_REPLY_RE.test(data)) return;
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'input', id: String(id), data }));
  });
  term.onScroll(() => updateTermJump(id, false));
  terms[id] = { term, fit, box, scanTimer: null };
}

function disposeTerminal(id) {
  const t = terms[id];
  if (!t) return;
  clearTimeout(t.scanTimer);
  t.term.dispose();
  delete terms[id];
}

function base64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function isTermAtBottom(term) {
  const b = term.buffer.active;
  return b.viewportY >= b.baseY;
}

function updateTermJump(id, hasNew) {
  const t = terms[id];
  const btn = document.querySelector('.tab-panel #jump-' + id);
  if (!t || !btn) return;
  if (isTermAtBottom(t.term)) {
    btn.classList.remove('show', 'has-new');
    btn.textContent = '↓';
    return;
  }
  btn.classList.add('show');
  if (hasNew) {
    btn.classList.add('has-new');
    btn.textContent = '↓ 새 출력';
  }
}

// 선택지 버튼(parseChoices)은 화면 아래쪽 글자를 본다 — 출력이 몰아칠 때 매번 읽지 않도록 묶어서 읽는다
function scheduleTermScan(id) {
  const t = terms[id];
  if (!t || t.scanTimer) return;
  t.scanTimer = setTimeout(() => {
    t.scanTimer = null;
    const b = t.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, b.length - 40); i < b.length; i++) {
      const line = b.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    lastSnapshotLines[id] = lines;
    updateChoices(id);
  }, TERM_SCAN_THROTTLE_MS);
}

function writeTermSeed(d) {
  const t = terms[d.id];
  if (!t) return;
  t.term.reset();
  if (d.cols > 0 && d.rows > 0 && (t.term.cols !== d.cols || t.term.rows !== d.rows)) t.term.resize(d.cols, d.rows);
  t.term.write(base64Bytes(d.d), () => {
    t.term.scrollToBottom();
    updateTermJump(d.id, false);
    scheduleTermScan(d.id);
  });
}

function writeTermOutput(d) {
  const t = terms[d.id];
  if (!t) return;
  t.term.write(base64Bytes(d.d), () => {
    if (!isTermAtBottom(t.term)) updateTermJump(d.id, true);
    scheduleTermScan(d.id);
  });
  markWorkerOutput(d.id);
}

function markPrompt(line, text) {
  const trimmed = text.trim();
  if (!/^[❯>›]/.test(trimmed)) { line.textContent = text; return; }
  const idx = text.indexOf(trimmed[0]);
  const before = text.slice(0, idx);
  const symbol = trimmed[0];
  const after = text.slice(idx + symbol.length);
  const mark = document.createElement('span');
  mark.className = 'prompt-mark';
  mark.textContent = symbol;
  line.textContent = '';
  if (before) line.appendChild(document.createTextNode(before));
  line.appendChild(mark);
  line.appendChild(document.createTextNode(after));
}

function updateExitReason(id, reason) {
  document.querySelectorAll('#exit-reason-' + id).forEach(el => {
    if (reason) {
      el.textContent = 'Exit reason: ' + reason;
      el.style.display = 'block';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  });
}

function updateStatus(id, status, reason) {
  var isStopped = status === 'stopped' || status === 'completed';
  document.querySelectorAll('#badge-' + id).forEach(el => {
    el.textContent = status;
    el.className = 'badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  });
  document.querySelectorAll('#tab-dot-' + id).forEach(el => {
    el.className = 'tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  });
  if (isStopped) {
    updateExitReason(id, reason || 'Unknown');
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.textContent = 'Remove';
      btn.style.background = '#21262d';
      btn.style.borderColor = '#f85149';
      btn.style.color = '#f85149';
      btn.onclick = () => removeWorker(id);
      // Add Reconnect button if not already present
      if (!btn.parentElement.querySelector('.reconnect-btn')) {
        var reconBtn = document.createElement('button');
        reconBtn.className = 'reconnect-btn';
        reconBtn.textContent = 'Reconnect';
        reconBtn.style.cssText = 'background:#21262d;border:1px solid #3fb950;border-radius:5px;color:#3fb950;font-size:11px;padding:2px 8px;cursor:pointer';
        reconBtn.onclick = function() { reconnectWorker(id); };
        btn.parentElement.insertBefore(reconBtn, btn);
      }
    });
    document.querySelectorAll('#input-row-' + id + ', #header-tools-' + id).forEach(el => el.style.display = 'none');
  }
  if (status === 'running') {
    updateExitReason(id, null);
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.textContent = 'Stop';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '#f85149';
      btn.onclick = () => killWorker(id);
      var reconBtn = btn.parentElement.querySelector('.reconnect-btn');
      if (reconBtn) reconBtn.remove();
    });
    document.querySelectorAll('#input-row-' + id + ', #header-tools-' + id).forEach(el => el.style.display = '');
  }
  refreshTabPriority();
}

// ── Prompt Choices ──
// 터미널 하단에 번호 선택 메뉴(❯ 1. Yes / 2. No)나 (y/n) 프롬프트가 보이면
// 한 번 탭으로 응답할 수 있는 버튼을 입력창 위에 렌더링한다.

const workerAiState = {};
const lastSnapshotLines = {};

function parseChoices(lines) {
  // 화면 맨 아래 영역만 본다 — 스크롤백에 남은 옛 메뉴를 다시 띄우지 않기 위함
  const tail = lines.map(l => l.replace(/\s+$/, '')).filter(l => l !== '').slice(-14);
  if (!tail.length) return null;

  const options = [];
  let selected = -1;
  tail.forEach(line => {
    const m = line.match(/^\s*(❯|›|>)?\s*(\d{1,2})\.\s+(.+)$/);
    if (!m) return;
    const num = parseInt(m[2], 10);
    if (num !== options.length + 1) return; // 1부터 연속된 번호만 메뉴로 인정
    options.push({ num, label: m[3].trim() });
    if (m[1]) selected = options.length - 1;
  });
  // 커서(❯) 위치를 알아야 방향키로 정확히 이동할 수 있다
  if (options.length >= 2 && selected >= 0) {
    return {
      kind: 'menu',
      items: options.map((o, i) => ({
        label: o.num + '. ' + trimChoiceLabel(o.label),
        keys: moveKeys(selected, i).concat(['Enter']),
        primary: i === selected
      }))
    };
  }

  const last = tail[tail.length - 1];
  if (/\((y|yes)\/(n|no)\)|\[(y|yes)\/(n|no)\]/i.test(last)) {
    return {
      kind: 'yn',
      items: [
        { label: 'Yes', keys: ['y', 'Enter'], primary: true },
        { label: 'No', keys: ['n', 'Enter'], primary: false }
      ]
    };
  }
  return null;
}

function trimChoiceLabel(text) {
  const clean = text.replace(/\s*\((esc|enter|tab)[^)]*\)\s*$/i, '').trim();
  return clean.length > 42 ? clean.slice(0, 41) + '…' : clean;
}

function moveKeys(from, to) {
  const keys = [];
  const key = to > from ? 'Down' : 'Up';
  for (let i = 0; i < Math.abs(to - from); i++) keys.push(key);
  return keys;
}

function updateChoices(id) {
  const lines = lastSnapshotLines[id];
  const choices = workerAiState[id] === 'waiting' && lines ? parseChoices(lines) : null;
  document.querySelectorAll('#choices-' + id).forEach(box => {
    box.innerHTML = '';
    if (!choices) { box.classList.remove('show'); return; }
    choices.items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn' + (item.primary ? ' primary' : '');
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        // 중복 클릭 방지: 다음 스냅샷이 오기 전까지 버튼을 치운다
        document.querySelectorAll('#choices-' + id).forEach(b => { b.innerHTML = ''; b.classList.remove('show'); });
        sendKeys(id, item.keys);
      });
      box.appendChild(btn);
    });
    box.classList.add('show');
  });
}

// ── 프롬프트 캐시 만료 카운트다운 ──
// Claude는 마지막 응답 후 캐시 TTL(기본 5분) 안에 다음 요청이 오면 캐시를 재사용한다 — 그 안에 답하면 비용·지연이 준다.
// 마지막 응답 시각은 서버가 상태를 idle/waiting으로 바꾼 시각(since)으로 본다. TTL은 config.json promptCacheTtlMinutes.
const workerAiSince = {};

function cacheBadgeText(id, state) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  const since = workerAiSince[id];
  if (!tab || !tab.dataset.claudeName || !since) return state;
  const left = (window._cacheTtlMin || 5) * 60000 - (Date.now() - since);
  if (left <= 0) return state + ' · cache ✕';
  const sec = Math.ceil(left / 1000);
  return state + ' · cache ' + Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

function renderCacheTimer(id) {
  const state = workerAiState[id];
  if (state !== 'idle' && state !== 'waiting') return;
  document.querySelectorAll('#badge-' + id).forEach(el => {
    if (el.classList.contains('stopped') || el.classList.contains('completed')) return;
    el.textContent = cacheBadgeText(id, state);
    el.title = '프롬프트 캐시가 살아 있는 동안 답하면 비용·지연이 줄어듭니다';
  });
}

setInterval(() => Object.keys(workerAiState).forEach(renderCacheTimer), 1000);

function updateAIState(id, state, since) {
  workerAiState[id] = state;
  workerAiSince[id] = since || Date.now();
  updateChoices(id);
  // Skip if worker is stopped/completed
  var badge = document.querySelector('#badge-' + id);
  if (badge && (badge.classList.contains('stopped') || badge.classList.contains('completed'))) {
    refreshTabPriority();
    return;
  }

  document.querySelectorAll('#tab-dot-' + id).forEach(function(el) {
    el.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') el.classList.add('ai-idle');
    else if (state === 'waiting') el.classList.add('ai-waiting');
  });

  document.querySelectorAll('#badge-' + id).forEach(function(el) {
    el.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') {
      el.classList.add('ai-idle');
      el.textContent = cacheBadgeText(id, 'idle');
    } else if (state === 'waiting') {
      el.classList.add('ai-waiting');
      el.textContent = cacheBadgeText(id, 'waiting');
    } else {
      el.textContent = 'running';
      el.title = '';
    }
  });
  refreshTabPriority();
}

function removeWorker(id) {
  apiPost('/api/remove', { id });
  removeWorkerDom(id);
}

function removeWorkerDom(id) {
  clearCustomTitle(id);
  saveDraft(id, '');
  delete workerAiState[id];
  delete workerAiSince[id];
  delete workerTimes[id];
  delete lastSentSizes[id];
  disposeTerminal(id);
  removePreviewTabs(id);
  if (typeof closeGitDiff === 'function') closeGitDiff(id);

  const panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
  if (panel) panel.remove();
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) {
    const wasActive = tab.classList.contains('active');
    tab.remove();
    if (wasActive) {
      const first = document.querySelector('.tab');
      if (first) selectTab(first.dataset.id);
      else activeTab = null;
    }
  }
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  updateSplitGrid();
  refreshTabPriority();
  sendView();
}

function updateCwd(id, cwd) {
  document.querySelectorAll('#card-' + id + ' .cwd-path').forEach(el => {
    el.textContent = displayPath(cwd);
  });
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) tab.dataset.cwd = cwd;
  renderTitle(id, cwd);
}

// git 브랜치·변경 파일 수 — 카드 경로 줄에 브랜치, 탭에는 변경이 있을 때만 개수를 붙인다
function updateGitInfo(id, git) {
  const changes = git && typeof git.changes === 'number' ? git.changes : 0;
  document.querySelectorAll('#git-' + id).forEach(el => {
    el.textContent = git ? '⎇ ' + git.branch + (changes ? ' · ' + changes + ' changed' : '') : '';
  });
  document.querySelectorAll('#tab-changes-' + id).forEach(el => {
    el.textContent = changes ? '±' + changes : '';
    el.title = changes ? (git.branch + ' · 변경 파일 ' + changes + '개') : '';
  });
}

// ── 사용량 (서버 refreshWorkerUsage·계정 한도) ──
// 비용은 API 단가로 계산한 추정치다 — 구독 요금제에서는 실제 청구액이 아니다

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n || 0);
}

function fmtUsd(v) {
  return v >= 100 ? '$' + Math.round(v).toLocaleString() : '$' + v.toFixed(2);
}

function usageLevel(percent) {
  if (percent >= 80) return 'danger';
  if (percent >= 50) return 'warn';
  return '';
}

function updateUsage(id, u) {
  const parts = [];
  let title = '';
  const hasCtx = u && u.ctxPercent !== null && u.ctxPercent !== undefined;
  if (u) {
    parts.push(fmtTokens(u.tokens) + ' tok');
    if (u.costUsd !== null && u.costUsd !== undefined) parts.push('~' + fmtUsd(u.costUsd));
    title = (u.model || u.provider) +
      '\n입력 ' + fmtTokens(u.input) + ' · 출력 ' + fmtTokens(u.output) +
      ' · 캐시 읽기 ' + fmtTokens(u.cacheRead) + (u.cacheWrite ? ' · 캐시 쓰기 ' + fmtTokens(u.cacheWrite) : '') +
      (u.ctxWindow ? '\n컨텍스트 ' + fmtTokens(u.ctxTokens) + ' / ' + fmtTokens(u.ctxWindow) : '') +
      '\n비용은 API 단가 기준 추정치예요 (구독 요금제의 실제 청구액이 아님)';
  }
  const level = hasCtx ? usageLevel(u.ctxPercent) : '';
  document.querySelectorAll('#usage-' + id).forEach(el => {
    el.textContent = parts.join(' · ');
    // 경고 색은 컨텍스트 부분에만 입힌다
    if (hasCtx) {
      el.appendChild(document.createTextNode(' · '));
      const ctx = document.createElement('span');
      ctx.className = 'usage-ctx';
      ctx.dataset.level = level;
      ctx.textContent = 'ctx ' + u.ctxPercent + '%';
      el.appendChild(ctx);
    }
    el.title = title;
  });
  // 탭에는 컨텍스트가 절반을 넘었을 때만 띄운다 — 압축(/compact) 시점을 알 수 있게
  document.querySelectorAll('#tab-ctx-' + id).forEach(el => {
    const show = u && u.ctxPercent >= 50;
    el.textContent = show ? u.ctxPercent + '%' : '';
    el.title = show ? '컨텍스트 ' + u.ctxPercent + '% 사용' : '';
    el.dataset.level = show ? level : '';
  });
}

function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' 리셋';
}

function codexWindowLabel(minutes) {
  if (minutes === 300) return '5h';
  if (minutes === 10080) return '주';
  if (!minutes) return '';
  return minutes % 1440 === 0 ? (minutes / 1440) + 'd' : Math.round(minutes / 60) + 'h';
}

function renderLimits(limits) {
  const bar = document.getElementById('limits-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const group = (name, items, error) => {
    if (!items.length && !error) return;
    const g = document.createElement('span');
    g.className = 'limits-group';
    const label = document.createElement('span');
    label.className = 'limits-name';
    label.textContent = name;
    g.appendChild(label);
    if (error) {
      const e = document.createElement('span');
      e.className = 'limits-item';
      e.dataset.level = 'warn';
      e.textContent = '!';
      e.title = error;
      g.appendChild(e);
    }
    items.forEach(it => {
      const s = document.createElement('span');
      s.className = 'limits-item';
      s.dataset.level = usageLevel(it.percent);
      s.textContent = it.label + ' ' + it.percent + '%';
      s.title = name + ' ' + it.label + ' 한도 ' + it.percent + '% 사용' + (it.resetsAt ? ' · ' + fmtReset(it.resetsAt) : '');
      g.appendChild(s);
    });
    bar.appendChild(g);
  };
  const c = limits && limits.claude;
  if (c) {
    const items = [];
    if (c.session) items.push({ label: '5h', percent: c.session.percent, resetsAt: c.session.resetsAt });
    if (c.weekly) items.push({ label: '주', percent: c.weekly.percent, resetsAt: c.weekly.resetsAt });
    (c.scoped || []).forEach(s => items.push({ label: s.label, percent: s.percent, resetsAt: s.resetsAt }));
    group('Claude', items, c.error || null);
  }
  const x = limits && limits.codex;
  if (x) {
    const items = [x.primary, x.secondary].filter(Boolean).map(w => ({ label: codexWindowLabel(w.windowMinutes), percent: w.percent, resetsAt: w.resetsAt }));
    group('Codex', items, null);
  }
}

// Claude가 pane 제목에 쓰는 작업 요약 — 카드 경로 줄 오른쪽과 탭 툴팁에 보여준다
function updateTask(id, task) {
  document.querySelectorAll('#task-' + id).forEach(el => {
    el.textContent = task || '';
    el.title = task || '';
  });
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) tab.title = task || '';
}

function updateClaudeName(id, claudeName) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (!tab) return;
  tab.dataset.claudeName = claudeName || '';
  renderTitle(id);
}

function updateTitle(id, title) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  const trimmed = title || '';
  if (trimmed) customTitles[id] = trimmed;
  else delete customTitles[id];
  if (tab) tab.dataset.title = trimmed;
  renderTitle(id);
}

function reconnectWorker(id) {
  apiPost('/api/reconnect', { id })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) alert('Session is no longer alive.');
    });
}

function shareWorkerUrl(id, btn) {
  apiPost('/api/share-url', { id })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || !d.url) {
        alert(d.error || 'Failed to create scoped URL.');
        return;
      }

      const done = () => {
        if (!btn) return;
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = prev; }, 1200);
      };

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(d.url).then(done).catch(() => {
          prompt('Scoped URL', d.url);
        });
      } else {
        prompt('Scoped URL', d.url);
        done();
      }
    })
    .catch(() => alert('Failed to create scoped URL.'));
}

// ── Worker Actions ──

function sendSpecialKey(id, key) {
  notifyActive(id);
  apiPost('/api/key', { id, key });
}

function sendKeys(id, keys) {
  notifyActive(id);
  apiPost('/api/key', { id, keys });
}

// 올린 파일의 서버 경로를 입력창 끝에 붙인다 — 사용자가 메시지를 덧붙여 보내면 AI가 그 경로를 읽는다
function appendPathToInput(id, filePath) {
  const t = terms[id];
  if (directTermInput && t && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'input', id: String(id), data: filePath + ' ' }));
    t.term.focus();
    return;
  }
  document.querySelectorAll('#inp-' + id).forEach(inp => {
    const cur = inp.value;
    inp.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + filePath + ' ';
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    saveDraft(id, inp.value);
  });
}

function setAttachBusy(id, busy) {
  document.querySelectorAll('#attach-' + id).forEach(btn => {
    btn.disabled = busy;
    btn.textContent = busy ? '⏳' : '📎';
  });
}

function uploadFile(id, file) {
  return fetch(scopedApiUrl('/api/upload?id=' + encodeURIComponent(id)), {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name || 'file')
    },
    body: file,
    credentials: 'include'
  }).then(r => {
    if (r.status === 401) { showLogin(); throw new Error('unauthorized'); }
    return r.json().catch(() => ({})).then(d => {
      if (!r.ok || !d.ok) throw new Error(d.error || ('upload failed (' + r.status + ')'));
      return d;
    });
  });
}

function uploadFiles(id, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return Promise.resolve();
  setAttachBusy(id, true);
  const failed = [];
  // 순서대로 하나씩 올려 입력창에 붙는 경로 순서가 고른 순서와 같게 한다
  let chain = Promise.resolve();
  files.forEach(file => {
    chain = chain
      .then(() => uploadFile(id, file))
      .then(d => appendPathToInput(id, d.path))
      .catch(e => { if (e.message !== 'unauthorized') failed.push(file.name + ': ' + e.message); });
  });
  return chain.then(() => {
    setAttachBusy(id, false);
    if (failed.length) alert('첨부 실패\n' + failed.join('\n'));
    const inp = document.querySelector('.tab-panel.active #inp-' + id) || document.getElementById('inp-' + id);
    if (inp) inp.focus();
  });
}

function sendInput(id) {
  let text = '';
  const inps = document.querySelectorAll('#inp-' + id);
  inps.forEach(inp => { if (!text && inp.value.trim()) text = inp.value.trim(); });
  if (!text) return;
  text = text.split('\n').filter(l => l.trim() !== '').join('\n');
  if (!text) return;
  inps.forEach(inp => { inp.value = ''; inp.style.height = 'auto'; });
  saveDraft(id, '');
  notifyActive(id);
  apiPost('/api/input', { id, text });
}

function killWorker(id) {
  if (!confirm('Stop Worker #' + id + '?')) return;
  apiPost('/api/kill', { id });
}

function spawnSession() {
  var raw = document.getElementById('cwd-input').value.trim();
  var base = window._basePath || '/tmp';
  var cwd = raw ? (raw.startsWith('/') ? raw : base + '/' + raw) : base;
  const cmd = document.getElementById('cmd-input').value.trim();
  spawnWorkerRequest({ cwd, cmd, prompt: document.getElementById('prompt-input').value.trim() });
}

function spawnWorkerRequest(body) {
  pendingSpawnSelect = true;
  apiPost('/api/spawn', body)
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, status: r.status, d })))
    .then(({ ok, status, d }) => {
      if (status === 401) { pendingSpawnSelect = false; return; } // 로그인 화면이 이미 표시됨
      if (!ok || d.ok === false) {
        pendingSpawnSelect = false;
        alert(d.error || 'Invalid path. Worker not created.');
        return;
      }
      if (body.prompt) document.getElementById('prompt-input').value = '';
      addRecent(body.cwd);
    })
    .catch(() => { pendingSpawnSelect = false; alert('Failed to create worker.'); });
}

function scanSessions() {
  const btn = document.getElementById('scan-btn');
  btn.textContent = '⏳';
  apiGet('/api/scan')
    .then(found => {
      btn.textContent = '🔍';
      if (!found.length) { alert('No new tmux sessions found.'); return; }
      const names = found.map(f => '• ' + f.sessionName + ' (' + displayPath(f.cwd) + ')').join('\n');
      if (!confirm('Add these sessions to dashboard?\n\n' + names)) return;
      found.forEach(f => apiPost('/api/attach', { sessionName: f.sessionName, cwd: f.cwd }));
    })
    .catch(() => { btn.textContent = '🔍'; });
}
