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
  const folder = tabCwd.replace(/\/$/, '').split('/').pop() || tabCwd;
  let text = tab && tab.dataset.pinned === '1' ? '📌 ' : '';
  if (tabTitle) {
    text += '#' + id + ' ' + tabTitle;
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

function ensureCard(id, cwd, status, logs, cmd, reason, title, sessionName, startedAt, lastOutputAt) {
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
    '<div class="card-cwd">' + displayPath(cwd) + '</div>' +
    '<div class="exit-reason" id="exit-reason-' + id + '"></div>' +
    '<div class="logs-wrap">' +
      '<div class="logs" id="logs-' + id + '"></div>' +
      '<button class="jump-bottom" id="jump-' + id + '" title="맨 아래로">↓</button>' +
    '</div>' +
    '<div class="choices" id="choices-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '"' + (status === 'stopped' || status === 'completed' ? ' style="display:none"' : '') + '>' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<button id="send-' + id + '">Send</button>' +
      '<div class="toolkit-wrap">' +
        '<button class="toolkit-toggle" id="tk-btn-' + id + '">⌨</button>' +
        '<div class="toolkit-popup" id="tk-popup-' + id + '">' +
          '<div class="tk-label">Keys</div>' +
          '<div class="key-grid">' +
            '<button class="key-btn" id="key-esc-' + id + '">esc</button>' +
            '<button class="key-btn" id="key-up-' + id + '">↑</button>' +
            '<button class="key-btn" id="key-down-' + id + '">↓</button>' +
            '<button class="key-btn key-enter" id="key-enter-' + id + '">↵</button>' +
            '<button class="key-btn" id="key-tab-' + id + '">tab</button>' +
            '<button class="key-btn" id="key-stab-' + id + '">⇧tab</button>' +
            '<button class="key-btn" id="key-ctrlc-' + id + '">⌃c</button>' +
            '<button class="key-btn" id="key-ctrlc2-' + id + '" title="⌃c 두 번 (종료)">⌃c×2</button>' +
            '<button class="key-btn" id="key-slash-' + id + '" title="슬래시 명령 자동완성">/</button>' +
          '</div>' +
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
  var folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;
  tab.innerHTML = '<span class="tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="tab-dot-' + id + '"></span><span class="tab-label" id="tab-label-' + id + '">#' + id + ' ' + (cmd || 'claude') + ' · ' + folder + '</span>';
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

  bindCard(id, panel);
  bindCard(id, splitCard);

  if (status === 'stopped') {
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.onclick = () => removeWorker(id);
    });
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = 'none');
  }

  renderTitle(id, cwd, cmdLabel);
  renderWorkerMeta(id);
  if (logs) {
    logs.forEach(l => appendLog(id, l.src, l.text));
    // 다음 출력 변화 전에도 선택지 버튼을 띄울 수 있도록 초기 로그를 스냅샷으로 삼는다
    lastSnapshotLines[id] = logs.map(l => l.text);
  }
  if (reason) updateExitReason(id, reason);
  if (status === 'running') updateExitReason(id, null);
  setTimeout(sendResize, 100);
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
  const keyMap = {
    up: 'Up', down: 'Down', enter: 'Enter', esc: 'Escape',
    tab: 'Tab', stab: 'BTab', ctrlc: 'C-c'
  };
  Object.entries(keyMap).forEach(([btnId, tmuxKey]) => {
    const btn = q('#key-' + btnId + '-' + id);
    if (btn) btn.addEventListener('click', () => sendSpecialKey(id, tmuxKey));
  });
  const slashBtn = q('#key-slash-' + id);
  if (slashBtn) slashBtn.addEventListener('click', () => sendKeys(id, ['/']));
  const ctrlc2Btn = q('#key-ctrlc2-' + id);
  if (ctrlc2Btn) ctrlc2Btn.addEventListener('click', () => sendKeys(id, ['C-c', 'C-c']));

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
  if (logs) {
    bindPinchZoom(logs);
    logs.addEventListener('scroll', () => updateJumpButton(logs));
  }
  if (jumpBtn && logs) {
    jumpBtn.addEventListener('click', () => {
      logs.scrollTop = logs.scrollHeight;
      updateJumpButton(logs);
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
        notifyActive();
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

// ── Jump to Bottom ──

function updateJumpButton(box, hasNew) {
  const btn = box.parentElement && box.parentElement.querySelector('.jump-bottom');
  if (!btn) return;
  if (isNearBottom(box)) {
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

// ── Logs ──

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 50;
}

function appendLog(id, src, text) {
  document.querySelectorAll('#logs-' + id).forEach(box => {
    var wasAtBottom = isNearBottom(box);
    const line = document.createElement('div');
    line.className = 'log-line ' + src;
    line.textContent = text;
    box.appendChild(line);
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
    else updateJumpButton(box, true);
  });
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
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = 'none');
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
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = '');
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

function updateAIState(id, state) {
  workerAiState[id] = state;
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
      el.textContent = 'idle';
    } else if (state === 'waiting') {
      el.classList.add('ai-waiting');
      el.textContent = 'waiting';
    } else {
      el.textContent = 'running';
    }
  });
  refreshTabPriority();
}

function removeWorker(id) {
  apiPost('/api/remove', { id });
  clearCustomTitle(id);
  delete workerTimes[id];
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
}

function updateCwd(id, cwd) {
  document.querySelectorAll('#card-' + id + ' .card-cwd').forEach(el => {
    el.textContent = displayPath(cwd);
  });
  // Also update card inside tab-panel
  document.querySelectorAll('.tab-panel[data-id="' + id + '"] .card-cwd').forEach(el => {
    el.textContent = displayPath(cwd);
  });
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) tab.dataset.cwd = cwd;
  renderTitle(id, cwd);
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
  notifyActive();
  apiPost('/api/key', { id, key });
}

function sendKeys(id, keys) {
  notifyActive();
  apiPost('/api/key', { id, keys });
}

function sendInput(id) {
  let text = '';
  const inps = document.querySelectorAll('#inp-' + id);
  inps.forEach(inp => { if (!text && inp.value.trim()) text = inp.value.trim(); });
  if (!text) return;
  text = text.split('\n').filter(l => l.trim() !== '').join('\n');
  if (!text) return;
  inps.forEach(inp => { inp.value = ''; inp.style.height = 'auto'; });
  notifyActive();
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
  spawnWorkerRequest({ cwd, cmd });
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
