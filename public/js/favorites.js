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

function renderDropdown() {
  const fl = document.getElementById('fav-list');
  const rl = document.getElementById('recent-list');
  if (!fl) return;

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
