// ── Favorites & Path Management ──

let favorites = JSON.parse(localStorage.getItem('fav') || 'null') || [];
let recents = JSON.parse(localStorage.getItem('recent') || '[]');

function displayPath(p) {
  const base = window._basePath || '';
  return (base && p.startsWith(base)) ? '📂 ' + p.slice(base.length) : p;
}

function saveFavs() {
  localStorage.setItem('fav', JSON.stringify(favorites));
}

function saveRecents() {
  localStorage.setItem('recent', JSON.stringify(recents));
}

function addRecent(p) {
  recents = [p, ...recents.filter(r => r !== p)].slice(0, 10);
  saveRecents();
  renderDropdown();
}

function addFavorite() {
  const p = document.getElementById('cwd-input').value.trim();
  if (!p || favorites.includes(p)) return;
  favorites.push(p);
  saveFavs();
  renderDropdown();
  closeDropdown();
}

function removeFavorite(p) {
  favorites = favorites.filter(f => f !== p);
  saveFavs();
  renderDropdown();
}

function selectPath(p) {
  document.getElementById('cwd-input').value = p;
  closeDropdown();
}

function toggleDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('dir-dropdown');
  dd.classList.toggle('open');
  if (dd.classList.contains('open')) renderDropdown();
}

function closeDropdown() {
  document.getElementById('dir-dropdown').classList.remove('open');
}

// ── Templates (경로 + 명령 + 환경변수 묶음, 서버 저장) ──

let templates = [];

function loadTemplates() {
  apiGet('/api/templates').then(d => {
    if (!d || !Array.isArray(d.templates)) return;
    templates = d.templates;
    renderDropdown();
  }).catch(() => {});
}

function saveTemplates(next) {
  templates = next;
  renderDropdown();
  apiPost('/api/templates', { templates: next });
}

function parseEnvInput(text) {
  const env = {};
  for (const m of (text || '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(\S*)/g)) env[m[1]] = m[2];
  return env;
}

function saveCurrentAsTemplate() {
  const raw = document.getElementById('cwd-input').value.trim();
  const base = window._basePath || '/tmp';
  const cwd = raw ? (raw.startsWith('/') ? raw : base + '/' + raw) : base;
  const cmd = document.getElementById('cmd-input').value.trim() || 'claude';
  const folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;
  const name = prompt('Template name', folder);
  if (name === null || !name.trim()) return;
  const envText = prompt('환경변수 (KEY=VAL, 공백으로 구분 · 없으면 비워두기)', '');
  if (envText === null) return;
  saveTemplates(templates.filter(t => t.name !== name.trim()).concat([{ name: name.trim(), cwd, cmd, env: parseEnvInput(envText) }]));
  closeDropdown();
}

function removeTemplate(idx) {
  const t = templates[idx];
  if (!t || !confirm('Delete template "' + t.name + '"?')) return;
  saveTemplates(templates.filter((_, i) => i !== idx));
}

function spawnFromTemplate(idx) {
  const t = templates[idx];
  if (!t) return;
  closeDropdown();
  document.getElementById('spawn-toolbar').style.display = 'none';
  spawnWorkerRequest({ cwd: t.cwd, cmd: t.cmd, env: t.env || {} });
}

function renderDropdown() {
  const fl = document.getElementById('fav-list');
  const rl = document.getElementById('recent-list');
  const tl = document.getElementById('tpl-list');
  if (!fl) return;

  if (tl) {
    tl.innerHTML = '';
    if (!templates.length) {
      tl.innerHTML = '<div style="padding:8px 10px;font-size:12px;color:#8b949e">None</div>';
    }
    templates.forEach((t, idx) => {
      const item = document.createElement('div');
      item.className = 'dir-item tpl-item';
      const envKeys = Object.keys(t.env || {});
      const main = document.createElement('span');
      main.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      main.innerHTML = '<span class="tpl-name"></span><span class="tpl-detail"></span>';
      main.querySelector('.tpl-name').textContent = t.name;
      main.querySelector('.tpl-detail').textContent = ' ' + (t.cmd || 'claude') + ' · ' + displayPath(t.cwd) + (envKeys.length ? ' · env ' + envKeys.length : '');
      main.title = (t.cmd || 'claude') + '\n' + t.cwd + (envKeys.length ? '\n' + envKeys.map(k => k + '=' + t.env[k]).join('\n') : '');
      main.addEventListener('click', () => spawnFromTemplate(idx));
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); removeTemplate(idx); });
      item.appendChild(document.createTextNode('▶'));
      item.appendChild(main);
      item.appendChild(del);
      tl.appendChild(item);
    });
  }

  fl.innerHTML = favorites.length
    ? favorites.map(p =>
        '<div class="dir-item"><span>⭐</span>' +
        '<span onclick="selectPath(\'' + p + '\')" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + displayPath(p) + '</span>' +
        '<span class="del" onclick="removeFavorite(\'' + p + '\')">✕</span></div>'
      ).join('')
    : '<div style="padding:8px 10px;font-size:12px;color:#8b949e">None</div>';

  rl.innerHTML = recents.length
    ? recents.map(p =>
        '<div class="dir-item" onclick="selectPath(\'' + p + '\')"><span>🕐</span><span>' + displayPath(p) + '</span></div>'
      ).join('')
    : '<div style="padding:8px 10px;font-size:12px;color:#8b949e">None</div>';
}
