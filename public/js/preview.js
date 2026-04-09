// ── Preview Tab Module ──
// 터미널 로그에서 감지된 localhost 포트에 대한 미리보기 탭을 관리한다.

// "preview-{workerId}-{port}" → { workerId, port, url, mode }
// mode: 'tab' (별도 탭) | 'split' (워커 패널 내 좌우 분할)
const previewTabs = new Map();

function isRemoteAccess() {
  return location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
}

function isWideScreen() {
  return window.innerWidth >= 768;
}

// ── Split Preview ──

function ensureSplitPreview(workerId, port) {
  const tabId = 'preview-' + workerId + '-' + port;
  if (previewTabs.has(tabId)) return;

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (!workerPanel) return;

  // 해당 워커 패널에 이미 split-preview가 있으면 두 번째 포트는 별도 탭으로
  if (workerPanel.querySelector('.split-preview')) {
    ensurePreviewTab(workerId, port);
    return;
  }

  const iframeSrc = 'http://localhost:' + port;

  const container = document.createElement('div');
  container.className = 'split-preview';
  container.dataset.previewId = tabId;

  container.innerHTML =
    '<div class="preview-toolbar">' +
      '<span class="preview-url" id="preview-url-' + tabId + '">' + iframeSrc + '</span>' +
      '<button class="preview-btn" onclick="refreshPreview(\'' + tabId + '\')">↺</button>' +
      '<a class="preview-btn" id="preview-open-' + tabId + '" href="' + iframeSrc + '" target="_blank">↗</a>' +
      '<button class="split-preview-close" title="미리보기 닫기">✕</button>' +
    '</div>' +
    '<iframe' +
      ' id="preview-iframe-' + tabId + '"' +
      ' class="preview-iframe"' +
      ' src="' + iframeSrc + '"' +
      ' sandbox="allow-same-origin allow-scripts allow-popups allow-forms"' +
      ' loading="lazy"' +
    '></iframe>' +
    '<div class="preview-error" id="preview-error-' + tabId + '" style="display:none">' +
      '<p>iframe 로드에 실패했습니다.</p>' +
      '<a href="' + iframeSrc + '" target="_blank">새 탭으로 열기 →</a>' +
    '</div>';

  container.querySelector('.split-preview-close').addEventListener('click', () => {
    closeSplitPreview(workerId, tabId);
  });

  // 리사이즈 핸들
  const handle = document.createElement('div');
  handle.className = 'split-resize-handle';

  workerPanel.classList.add('has-preview');
  workerPanel.appendChild(handle);
  workerPanel.appendChild(container);

  // 드래그 리사이즈 로직
  initSplitResize(handle, workerPanel);

  previewTabs.set(tabId, { workerId: String(workerId), port, url: null, mode: 'split' });

  // 터미널 cols/rows 재계산 (레이아웃 변경으로 너비가 절반이 됨)
  setTimeout(sendResize, 100);
}

function closeSplitPreview(workerId, tabId) {
  const container = document.querySelector('.split-preview[data-preview-id="' + tabId + '"]');
  // 리사이즈 핸들도 함께 제거
  if (container && container.previousElementSibling && container.previousElementSibling.classList.contains('split-resize-handle')) {
    container.previousElementSibling.remove();
  }
  if (container) container.remove();

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (workerPanel) {
    workerPanel.classList.remove('has-preview');
    // 터미널 너비 초기화
    const card = workerPanel.querySelector('.card');
    if (card) card.style.width = '';
  }

  previewTabs.delete(tabId);

  // 터미널이 전체 너비로 복원되므로 재계산
  setTimeout(sendResize, 100);
}

// 같은 포트의 미리보기가 이미 열려 있는지 확인 (workerId 무관)
function isPortPreviewed(port) {
  for (const [, info] of previewTabs) {
    if (info.port === port) return true;
  }
  return false;
}

// ── 진입점 라우터 ──
// PC(768px+) + Tab 모드: 좌우 분할. 그 외: 별도 탭.
function ensurePreview(workerId, port) {
  if (isPortPreviewed(port)) return;
  if (isWideScreen() && typeof layout !== 'undefined' && layout === 'tab') {
    ensureSplitPreview(workerId, port);
  } else {
    ensurePreviewTab(workerId, port);
  }
}

function ensurePreviewTab(workerId, port) {
  const tabId = 'preview-' + workerId + '-' + port;
  if (previewTabs.has(tabId)) return;

  // ── 탭 생성 ──
  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = tabId;
  tab.dataset.preview = 'true';
  tab.innerHTML =
    '<span class="tab-dot preview-dot"></span>' +
    '<span class="tab-label">:' + port + '</span>' +
    '<span class="tab-close preview-close">✕</span>';
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('preview-close')) return;
    selectTab(tabId);
  });

  // ── 패널 생성 ──
  const panel = document.createElement('div');
  panel.className = 'tab-panel preview-panel';
  panel.dataset.id = tabId;

  const iframeSrc = 'http://localhost:' + port;

  panel.innerHTML =
    '<div class="preview-toolbar">' +
      '<span class="preview-url" id="preview-url-' + tabId + '">' + iframeSrc + '</span>' +
      '<button class="preview-btn" onclick="refreshPreview(\'' + tabId + '\')">↺ 새로고침</button>' +
      '<a class="preview-btn" id="preview-open-' + tabId + '" href="' + iframeSrc + '" target="_blank">↗ 새 탭</a>' +
    '</div>' +
    '<iframe' +
      ' id="preview-iframe-' + tabId + '"' +
      ' class="preview-iframe"' +
      ' src="' + iframeSrc + '"' +
      ' sandbox="allow-same-origin allow-scripts allow-popups allow-forms"' +
      ' loading="lazy"' +
    '></iframe>' +
    '<div class="preview-error" id="preview-error-' + tabId + '" style="display:none">' +
      '<p>iframe 로드에 실패했습니다.</p>' +
      '<a href="' + iframeSrc + '" target="_blank">새 탭으로 열기 →</a>' +
    '</div>';

  // 닫기 버튼 이벤트
  tab.querySelector('.preview-close').addEventListener('click', () => closePreviewTab(tabId));

  document.getElementById('tab-bar').appendChild(tab);
  document.getElementById('tab-content').appendChild(panel);

  previewTabs.set(tabId, { workerId: String(workerId), port, url: null });

  // 자동 활성화
  selectTab(tabId);
}

function refreshPreview(tabId) {
  // tab 모드와 split 모드 모두 동일한 id 패턴 사용
  const iframe = document.getElementById('preview-iframe-' + tabId);
  if (!iframe) return;
  // contentWindow.location.reload()이 src 재할당보다 브라우저 호환성이 안정적
  try {
    iframe.contentWindow.location.reload();
  } catch (e) {
    // cross-origin 제약으로 reload() 접근 불가 시 타임스탬프 쿼리 파라미터로 강제 새로고침
    iframe.src = iframe.src.split('?')[0] + '?_t=' + Date.now();
  }
}

function updatePreviewTunnel(port, url) {
  for (const [tabId, info] of previewTabs) {
    if (info.port !== port) continue;

    info.url = url;

    // tab/split 모드 모두 동일한 id 패턴을 사용하므로 공통 처리
    const iframe = document.getElementById('preview-iframe-' + tabId);
    const openLink = document.getElementById('preview-open-' + tabId);
    const urlLabel = document.getElementById('preview-url-' + tabId);

    // 원격 접근이거나 터널 URL이 제공된 경우 터널 URL 사용
    if (isRemoteAccess() && url) {
      if (iframe) iframe.src = url;
      if (openLink) { openLink.href = url; }
      if (urlLabel) urlLabel.textContent = url;
    } else if (url) {
      // 로컬에서도 터널 URL로 링크 업데이트
      if (openLink) { openLink.href = url; }
      if (urlLabel) urlLabel.textContent = 'localhost:' + port + ' (' + url + ')';
    }
  }
}

function closePreviewTab(tabId) {
  const tab = document.querySelector('.tab[data-id="' + tabId + '"]');
  const panel = document.querySelector('.tab-panel[data-id="' + tabId + '"]');
  const wasActive = tab && tab.classList.contains('active');

  if (tab) tab.remove();
  if (panel) panel.remove();
  previewTabs.delete(tabId);

  if (wasActive) {
    const first = document.querySelector('.tab');
    if (first) selectTab(first.dataset.id);
    else if (typeof activeTab !== 'undefined') activeTab = null;
  }
}

function removePreviewTabs(workerId) {
  const toRemove = [];
  for (const [tabId, info] of previewTabs) {
    if (String(info.workerId) === String(workerId)) toRemove.push(tabId);
  }

  for (const tabId of toRemove) {
    const info = previewTabs.get(tabId);

    if (info && info.mode === 'split') {
      // split 모드: 워커 패널 내 요소 제거
      closeSplitPreview(workerId, tabId);
    } else {
      // tab 모드: 별도 탭/패널 제거
      const tab = document.querySelector('.tab[data-id="' + tabId + '"]');
      const panel = document.querySelector('.tab-panel[data-id="' + tabId + '"]');
      const wasActive = tab && tab.classList.contains('active');

      if (tab) tab.remove();
      if (panel) panel.remove();

      previewTabs.delete(tabId);

      // 제거된 탭이 활성 탭이었으면 다음 탭으로 전환
      if (wasActive) {
        const first = document.querySelector('.tab');
        if (first) selectTab(first.dataset.id);
        else if (typeof activeTab !== 'undefined') activeTab = null;
      }
    }
  }
}

// ── Split Resize (드래그로 좌우 비율 조절) ──

function initSplitResize(handle, panel) {
  let startX, startWidth;
  const card = panel.querySelector('.card');

  handle.addEventListener('mousedown', onMouseDown);
  handle.addEventListener('touchstart', onTouchStart, { passive: false });

  function onMouseDown(e) {
    e.preventDefault();
    startDrag(e.clientX);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  function onMouseMove(e) { doDrag(e.clientX); }

  function onMouseUp() {
    stopDrag();
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  function onTouchStart(e) {
    e.preventDefault();
    startDrag(e.touches[0].clientX);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  function onTouchMove(e) {
    e.preventDefault();
    doDrag(e.touches[0].clientX);
  }

  function onTouchEnd() {
    stopDrag();
    document.removeEventListener('touchmove', onTouchMove);
    document.removeEventListener('touchend', onTouchEnd);
  }

  function startDrag(x) {
    startX = x;
    startWidth = card.getBoundingClientRect().width;
    handle.classList.add('dragging');
    // iframe이 드래그 이벤트를 가로채지 못하도록 차단
    panel.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = 'none');
  }

  function doDrag(x) {
    const delta = x - startX;
    const panelWidth = panel.getBoundingClientRect().width;
    const newWidth = Math.max(100, Math.min(panelWidth - 100, startWidth + delta));
    card.style.width = newWidth + 'px';
  }

  function stopDrag() {
    handle.classList.remove('dragging');
    panel.querySelectorAll('iframe').forEach(f => f.style.pointerEvents = '');
    setTimeout(sendResize, 50);
  }
}

// ── Preview Prompt (비-HTML 포트 감지 시 사용자 선택) ──

function showPreviewPrompt(workerId, port, contentType) {
  // 이미 같은 포트의 미리보기가 있으면 무시
  if (isPortPreviewed(port)) return;
  var tabId = 'preview-' + workerId + '-' + port;

  // 이미 같은 포트의 프롬프트가 있으면 무시
  if (document.getElementById('preview-prompt-' + tabId)) return;

  var toast = document.createElement('div');
  toast.className = 'preview-prompt';
  toast.id = 'preview-prompt-' + tabId;

  toast.innerHTML =
    '<span class="preview-prompt-text">' +
      '포트 <b>:' + port + '</b> 감지 (' + (contentType || 'unknown') + ')' +
    '</span>' +
    '<button class="preview-prompt-btn preview-prompt-open">미리보기</button>' +
    '<button class="preview-prompt-btn preview-prompt-dismiss">무시</button>';

  toast.querySelector('.preview-prompt-open').addEventListener('click', function() {
    toast.remove();
    ensurePreview(workerId, port);
  });

  toast.querySelector('.preview-prompt-dismiss').addEventListener('click', function() {
    toast.remove();
  });

  // 30초 후 자동 사라짐
  setTimeout(function() { if (toast.parentNode) toast.remove(); }, 30000);

  document.body.appendChild(toast);
}
