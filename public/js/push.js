// ── Web Push Notifications ──
// 워커가 입력/승인 대기 상태가 되면 서버가 푸시를 보낸다.
// iOS는 홈 화면에 추가(PWA)한 상태에서만 푸시가 동작한다.

let pushRegistration = null;

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function setPushButtonState(state) {
  const btn = document.getElementById('push-btn');
  if (!btn) return;
  btn.style.display = state === 'hidden' ? 'none' : '';
  btn.classList.toggle('layout-active', state === 'on');
  btn.title = state === 'on' ? '푸시 알림 켜짐 — 누르면 끔'
    : state === 'denied' ? '브라우저에서 알림이 차단됨'
    : '대기 알림을 이 기기로 받기';
  btn.textContent = state === 'on' ? '🔔' : '🔕';
}

function initPush() {
  if (!pushSupported() || isScopedMode()) { setPushButtonState('hidden'); return; }
  navigator.serviceWorker.register('/sw.js').then(reg => {
    pushRegistration = reg;
    return reg.pushManager.getSubscription();
  }).then(sub => {
    if (Notification.permission === 'denied') setPushButtonState('denied');
    else setPushButtonState(sub ? 'on' : 'off');
  }).catch(() => setPushButtonState('hidden'));

  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.type === 'focus-worker' && e.data.workerId) focusWorker(e.data.workerId);
  });
}

function togglePush() {
  if (!pushRegistration) return;
  pushRegistration.pushManager.getSubscription().then(sub => {
    if (sub) return disablePush(sub);
    return enablePush();
  }).catch(err => alert('알림 설정 실패: ' + (err && err.message ? err.message : err)));
}

function enablePush() {
  return Notification.requestPermission().then(permission => {
    if (permission !== 'granted') { setPushButtonState(permission === 'denied' ? 'denied' : 'off'); return; }
    return apiGet('/api/push/public-key').then(info => {
      if (!info || !info.enabled) { alert('서버에 web-push가 설치되어 있지 않습니다.'); return; }
      return pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(info.publicKey)
      });
    }).then(sub => {
      if (!sub) return;
      return apiPost('/api/push/subscribe', { subscription: sub.toJSON() }).then(r => {
        if (!r.ok) throw new Error('subscribe failed');
        setPushButtonState('on');
      });
    });
  });
}

function disablePush(sub) {
  return apiPost('/api/push/unsubscribe', { endpoint: sub.endpoint })
    .then(() => sub.unsubscribe())
    .then(() => setPushButtonState('off'));
}

// 알림 클릭 → 해당 워커 탭으로. 카드가 아직 로드 전이면 잠시 재시도.
function focusWorker(workerId, attempt) {
  const id = String(workerId);
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) { selectTab(id); return; }
  if ((attempt || 0) < 20) setTimeout(() => focusWorker(id, (attempt || 0) + 1), 250);
}
