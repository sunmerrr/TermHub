// ── Git Diff Panel Module ──
// 워커 탭 내 좌우 분할로 git diff 결과를 diff2html로 렌더링한다.

// workerId → { open: boolean, selectedFile: string|null }
const diffPanels = new Map();

function openGitDiff(workerId) {
  workerId = String(workerId);

  const workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (!workerPanel) return;

  // 이미 diff 패널이 열려 있으면 토글 (닫기)
  if (workerPanel.querySelector('.split-diff')) {
    closeGitDiff(workerId);
    return;
  }

  // preview가 열려 있으면 먼저 닫기 (한 번에 하나만)
  const existingPreview = workerPanel.querySelector('.split-preview');
  if (existingPreview) {
    const previewId = existingPreview.dataset.previewId;
    if (previewId) closeSplitPreview(workerId, previewId);
  }

  // 리사이즈 핸들
  const handle = document.createElement('div');
  handle.className = 'split-resize-handle';

  // diff 패널 컨테이너
  const container = document.createElement('div');
  container.className = 'split-diff';
  container.dataset.workerId = workerId;

  container.innerHTML =
    '<div class="diff-toolbar">' +
      '<button class="diff-refresh-btn" title="새로고침">↺</button>' +
      '<span class="diff-stat"></span>' +
      '<button class="diff-close-btn" title="닫기">✕</button>' +
    '</div>' +
    '<div class="diff-body">' +
      '<div class="diff-file-sidebar">' +
        '<div class="diff-file-list"></div>' +
      '</div>' +
      '<div class="diff-sidebar-toggle">◀</div>' +
      '<div class="diff-content">' +
        '<div class="diff-placeholder">파일을 선택하세요</div>' +
      '</div>' +
    '</div>';

  // 버튼 이벤트 바인딩
  container.querySelector('.diff-close-btn').addEventListener('click', function() {
    closeGitDiff(workerId);
  });

  container.querySelector('.diff-refresh-btn').addEventListener('click', function() {
    refreshGitDiff(workerId);
  });

  // 사이드바 토글
  var sidebar = container.querySelector('.diff-file-sidebar');
  var toggleBtn = container.querySelector('.diff-sidebar-toggle');
  toggleBtn.addEventListener('click', function() {
    var isCollapsed = sidebar.classList.toggle('collapsed');
    toggleBtn.textContent = isCollapsed ? '▶' : '◀';
  });

  workerPanel.classList.add('has-preview');
  workerPanel.appendChild(handle);
  workerPanel.appendChild(container);

  // 드래그 리사이즈
  if (typeof initSplitResize === 'function') {
    initSplitResize(handle, workerPanel);
  }

  diffPanels.set(workerId, { open: true, selectedFile: null });

  // 파일 목록 자동 로드
  loadFileList(workerId);

  setTimeout(sendResize, 100);
}

function loadFileList(workerId) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  if (!container) return;

  var fileList = container.querySelector('.diff-file-list');
  var statEl = container.querySelector('.diff-stat');

  fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#484f58">로딩 중...</div>';

  fetch('/api/git-diff?id=' + encodeURIComponent(workerId), { credentials: 'include' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      if (data.error) {
        fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#f85149">' + data.error + '</div>';
        return;
      }

      statEl.textContent = data.stat || '';

      if (!data.files || data.files.length === 0) {
        fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#484f58">변경 사항 없음</div>';
        return;
      }

      fileList.innerHTML = '';
      data.files.forEach(function(f) {
        var item = document.createElement('div');
        item.className = 'diff-file-item';
        item.dataset.path = f.path;

        var trimmed = f.path.replace(/\/+$/, '');
        var filename = trimmed.split('/').pop() || f.path;
        item.title = f.path;
        item.innerHTML =
          '<span class="diff-file-status ' + f.status + '">' + f.status + '</span> ' +
          filename;

        item.addEventListener('click', function() {
          loadFileDiff(workerId, f.path);
        });

        fileList.appendChild(item);
      });
    })
    .catch(function(err) {
      fileList.innerHTML = '<div style="padding:8px;font-size:11px;color:#f85149">로드 실패: ' + err.message + '</div>';
    });
}

function loadFileDiff(workerId, filePath) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  if (!container) return;

  var diffContent = container.querySelector('.diff-content');

  // 선택 상태 표시
  container.querySelectorAll('.diff-file-item').forEach(function(item) {
    item.classList.toggle('active', item.dataset.path === filePath);
  });

  var state = diffPanels.get(workerId);
  if (state) state.selectedFile = filePath;

  diffContent.innerHTML = '<div class="diff-placeholder">로딩 중...</div>';

  fetch('/api/git-diff?id=' + encodeURIComponent(workerId) + '&file=' + encodeURIComponent(filePath), { credentials: 'include' })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      diffContent.innerHTML = '';

      if (!data.diff) {
        diffContent.innerHTML = '<div class="diff-placeholder">변경 사항 없음</div>';
        return;
      }

      if (typeof Diff2HtmlUI === 'undefined') {
        diffContent.innerHTML = '<div class="diff-placeholder" style="color:#f85149">diff2html 라이브러리 로드 실패</div>';
        return;
      }
      var ui = new Diff2HtmlUI(diffContent, data.diff, {
        outputFormat: 'line-by-line',
        matching: 'lines',
        highlight: true,
        drawFileList: false,
        synchronisedScroll: true,
      });
      ui.draw();
      ui.highlightCode();
    })
    .catch(function(err) {
      diffContent.innerHTML = '<div class="diff-placeholder" style="color:#f85149">로드 실패: ' + err.message + '</div>';
    });
}

function closeGitDiff(workerId) {
  workerId = String(workerId);
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');

  if (container) {
    // 리사이즈 핸들 제거
    var prev = container.previousElementSibling;
    if (prev && prev.classList.contains('split-resize-handle')) {
      prev.remove();
    }
    container.remove();
  }

  var workerPanel = document.querySelector('.tab-panel[data-id="' + workerId + '"]');
  if (workerPanel) {
    // preview가 없을 때만 has-preview 제거
    if (!workerPanel.querySelector('.split-preview')) {
      workerPanel.classList.remove('has-preview');
    }
    var card = workerPanel.querySelector('.card');
    if (card) card.style.width = '';
  }

  diffPanels.delete(workerId);
  setTimeout(sendResize, 100);
}

function refreshGitDiff(workerId) {
  workerId = String(workerId);
  var state = diffPanels.get(workerId);
  if (!state) return;

  var selectedFile = state.selectedFile;
  loadFileList(workerId);
  if (selectedFile) {
    // 파일 목록 로드 후 선택 파일 diff도 갱신
    setTimeout(function() { loadFileDiff(workerId, selectedFile); }, 300);
  }
}
