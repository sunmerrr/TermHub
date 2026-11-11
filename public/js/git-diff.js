// ── Git Diff Panel Module ──
// 워커 탭 내 좌우 분할로 git diff 결과를 diff2html로 렌더링한다.

// workerId → { open: boolean, selectedFile: string|null }
const diffPanels = new Map();
// workerId → [{ file, line, side, code, text }] — 아직 워커에 보내지 않은 리뷰 메모
const diffNotes = new Map();

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
      '<button class="diff-notes-send" title="줄 번호를 눌러 단 메모를 이 워커에게 한 번에 보냅니다" disabled>메모 보내기</button>' +
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

  container.querySelector('.diff-notes-send').addEventListener('click', function() {
    sendDiffNotes(workerId);
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
  updateNotesButton(workerId);

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
      bindDiffNotes(workerId, filePath, diffContent);
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

// ── 리뷰 메모 ──
// diff 줄 번호를 누르면 그 줄 아래에 메모 입력칸이 열린다. 모은 메모는 "메모 보내기"로 한 메시지에 묶어 워커에 붙여넣는다.

function notesFor(workerId) {
  if (!diffNotes.has(workerId)) diffNotes.set(workerId, []);
  return diffNotes.get(workerId);
}

// diff2html line-by-line 행: 첫 칸에 이전/새 줄 번호(line-num1/2), 둘째 칸에 코드
function diffRowInfo(tr) {
  var numCell = tr.querySelector('.d2h-code-linenumber');
  var codeEl = tr.querySelector('.d2h-code-line-ctn');
  if (!numCell || !codeEl) return null;
  var newNum = (numCell.querySelector('.line-num2') || {}).textContent || '';
  var oldNum = (numCell.querySelector('.line-num1') || {}).textContent || '';
  newNum = newNum.trim();
  oldNum = oldNum.trim();
  if (!newNum && !oldNum) return null;
  return {
    numCell: numCell,
    line: newNum || oldNum,
    // 삭제된 줄은 새 파일에 없으므로 이전 줄 번호임을 표시한다
    side: newNum ? 'new' : 'old',
    code: codeEl.textContent.replace(/\s+$/, '')
  };
}

function bindDiffNotes(workerId, filePath, diffContent) {
  diffContent.querySelectorAll('.d2h-diff-tbody tr').forEach(function(tr) {
    var info = diffRowInfo(tr);
    if (!info) return;
    info.numCell.classList.add('note-target');
    info.numCell.title = '메모 달기';
    info.numCell.addEventListener('click', function() {
      openNoteEditor(workerId, filePath, tr, info);
    });
  });
  renderNoteRows(workerId, filePath, diffContent);
}

function noteKey(n) {
  return n.file + ':' + n.side + ':' + n.line;
}

function openNoteEditor(workerId, filePath, tr, info) {
  var next = tr.nextElementSibling;
  if (next && next.classList.contains('diff-note-row')) {
    var existing = next.querySelector('textarea');
    if (existing) { existing.focus(); return; }
  }
  var current = notesFor(workerId).find(function(n) { return noteKey(n) === noteKey({ file: filePath, side: info.side, line: info.line }); });
  var row = document.createElement('tr');
  row.className = 'diff-note-row editing';
  row.innerHTML = '<td colspan="2"><div class="diff-note-editor">' +
    '<textarea rows="2" placeholder="이 줄에 대한 수정 요청이나 질문"></textarea>' +
    '<div class="diff-note-actions"><button class="diff-note-save">저장</button><button class="diff-note-cancel">취소</button></div>' +
    '</div></td>';
  var ta = row.querySelector('textarea');
  ta.value = current ? current.text : '';
  var close = function() {
    row.remove();
    renderNoteRows(workerId, filePath, tr.closest('.diff-content'));
  };
  var save = function() {
    var text = ta.value.trim();
    var list = notesFor(workerId).filter(function(n) { return noteKey(n) !== noteKey({ file: filePath, side: info.side, line: info.line }); });
    if (text) list.push({ file: filePath, line: info.line, side: info.side, code: info.code, text: text });
    diffNotes.set(workerId, list);
    updateNotesButton(workerId);
    close();
  };
  row.querySelector('.diff-note-save').addEventListener('click', save);
  row.querySelector('.diff-note-cancel').addEventListener('click', close);
  ta.addEventListener('keydown', function(e) {
    // 터미널 단축키 처리(app.js)로 새지 않게 막는다
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  tr.parentNode.insertBefore(row, tr.nextSibling);
  ta.focus();
}

// 저장된 메모를 해당 줄 아래에 표시한다 (diff를 다시 그리면 행이 새로 만들어지므로 매번 다시 붙인다)
function renderNoteRows(workerId, filePath, diffContent) {
  if (!diffContent) return;
  diffContent.querySelectorAll('.diff-note-row:not(.editing)').forEach(function(r) { r.remove(); });
  var byKey = {};
  notesFor(workerId).forEach(function(n) { if (n.file === filePath) byKey[noteKey(n)] = n; });
  diffContent.querySelectorAll('.d2h-diff-tbody tr').forEach(function(tr) {
    if (tr.classList.contains('diff-note-row')) return;
    var info = diffRowInfo(tr);
    if (!info) return;
    var note = byKey[noteKey({ file: filePath, side: info.side, line: info.line })];
    info.numCell.classList.toggle('has-note', !!note);
    if (!note) return;
    var row = document.createElement('tr');
    row.className = 'diff-note-row';
    var cell = document.createElement('td');
    cell.colSpan = 2;
    var box = document.createElement('div');
    box.className = 'diff-note-saved';
    box.textContent = '💬 ' + note.text;
    box.title = '눌러서 고치기';
    box.addEventListener('click', function() {
      row.remove();
      openNoteEditor(workerId, filePath, tr, info);
    });
    cell.appendChild(box);
    row.appendChild(cell);
    tr.parentNode.insertBefore(row, tr.nextSibling);
  });
}

function updateNotesButton(workerId) {
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  if (!container) return;
  var btn = container.querySelector('.diff-notes-send');
  var count = notesFor(workerId).length;
  btn.disabled = count === 0;
  btn.textContent = count ? '메모 보내기 (' + count + ')' : '메모 보내기';
}

function formatDiffNotes(notes) {
  var lines = ['코드 리뷰 메모입니다. 각 위치를 확인하고 반영해 주세요.', ''];
  notes.forEach(function(n, i) {
    var where = n.file + ':' + n.line + (n.side === 'old' ? ' (삭제된 줄, 이전 줄 번호)' : '');
    lines.push((i + 1) + '. ' + where);
    if (n.code.trim()) lines.push('   코드: ' + n.code.trim().slice(0, 200));
    lines.push('   메모: ' + n.text.replace(/\n/g, '\n         '));
  });
  return lines.join('\n');
}

function sendDiffNotes(workerId) {
  var notes = notesFor(workerId);
  if (!notes.length) return;
  var container = document.querySelector('.split-diff[data-worker-id="' + workerId + '"]');
  var btn = container && container.querySelector('.diff-notes-send');
  if (btn) btn.disabled = true;
  notifyActive(workerId);
  apiPost('/api/input', { id: workerId, text: formatDiffNotes(notes), mode: 'paste' })
    .then(function(r) { return r.json().catch(function() { return {}; }); })
    .then(function(d) {
      if (!d.ok) throw new Error('워커가 실행 중이 아닙니다');
      diffNotes.set(workerId, []);
      updateNotesButton(workerId);
      if (container) renderNoteRows(workerId, (diffPanels.get(workerId) || {}).selectedFile, container.querySelector('.diff-content'));
    })
    .catch(function(err) {
      alert('메모 전송 실패: ' + err.message);
      updateNotesButton(workerId);
    });
}
