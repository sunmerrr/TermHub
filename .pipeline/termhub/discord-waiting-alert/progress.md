# Progress: discord-waiting-alert

## Task 1: .env에 DISCORD_ALERT_WEBHOOK 환경변수 추가
- Status: COMPLETED
- Added `DISCORD_ALERT_WEBHOOK` on a new line after `DISCORD_WEBHOOK` in `/Users/natrissummer/termhub/.env`.

## Task 2: server.js에 Discord 알림 로직 구현
- Status: COMPLETED

### 2-1. 환경변수 읽기
- Added `const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;` on line 11, directly below `DISCORD_WEBHOOK`.

### 2-2. 쿨다운 관리용 Map 추가
- Added `ALERT_COOLDOWN_MS = 60000` and `lastAlertTime = new Map()` on lines 24-25, adjacent to `ACTION_WINDOW_MS`.

### 2-3. Discord 알림 발송 함수 추가
- Added `sendWaitingAlert(id)` function (lines 121-152) between `detectWaiting` and `IDLE_THRESHOLD` constant. Implements opt-in guard, 60s per-worker cooldown, and Discord Embed POST with error handling.

### 2-4. pollOutput에서 waiting 전환 시 알림 호출
- First call site (idle threshold path, line 208): `if (newState === 'waiting') sendWaitingAlert(id);`
- Second call site (output-changed path, line 227): `if (aiState === 'waiting') sendWaitingAlert(id);`
- Both fire only on state transitions (guarded by `!== w.aiState`).

### 2-5. 워커 제거 시 쿨다운 정리
- Added `lastAlertTime.delete(id)` in `/api/remove` handler after `workers.delete(id)` to prevent memory leaks.
