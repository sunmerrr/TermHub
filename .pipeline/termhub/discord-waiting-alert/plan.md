# Plan: Waiting 상태 감지 시 Discord 알림 발송

워커가 waiting 상태로 전환되면 Discord 웹훅으로 알림을 보내, 모바일에서 즉시 확인하고 대응할 수 있게 한다. 중복/과다 알림을 방지하기 위해 워커별 쿨다운을 적용한다.

## Task 1: .env에 DISCORD_ALERT_WEBHOOK 환경변수 추가
- depends: none
- files: .env

`.env` 파일에 `DISCORD_ALERT_WEBHOOK` 환경변수를 추가한다. 값은 사용자가 제공한 Discord alert 채널 웹훅 URL이다:
```
DISCORD_ALERT_WEBHOOK=https://discord.com/api/webhooks/1482981560579002462/mVVaUpn5d3Ivh9Bdwes8o_skPuaE0xTi1fdYC7yUU6BP4jifrrSGzlQmRiAXbDr1xxyd
```
기존 `DISCORD_WEBHOOK`(터널 알림용)은 그대로 유지하고, 새 변수를 별도 줄에 추가한다.

## Task 2: server.js에 Discord 알림 로직 구현
- depends: 1
- files: server.js

server.js에 다음 변경을 적용한다:

### 2-1. 환경변수 읽기
파일 상단 `DISCORD_WEBHOOK` 선언 바로 아래에 다음을 추가:
```js
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;
```

### 2-2. 쿨다운 관리용 Map 추가
상단 상수 영역(`ACTION_WINDOW_MS` 근처)에 추가:
```js
const ALERT_COOLDOWN_MS = 60000; // 같은 워커에 대해 60초 쿨다운
const lastAlertTime = new Map(); // key: worker id, value: timestamp
```

### 2-3. Discord 알림 발송 함수 추가
`detectWaiting` 함수 아래(또는 적절한 위치)에 `sendWaitingAlert(id)` 함수를 새로 정의:

```js
function sendWaitingAlert(id) {
  if (!DISCORD_ALERT_WEBHOOK) return;

  const now = Date.now();
  const lastTime = lastAlertTime.get(id) || 0;
  if (now - lastTime < ALERT_COOLDOWN_MS) return; // 쿨다운 중이면 무시
  lastAlertTime.set(id, now);

  const w = workers.get(id);
  if (!w) return;

  const embed = {
    embeds: [{
      title: "⏳ Waiting — Worker #" + id,
      color: 0xf0ad4e, // 주황색 (경고)
      fields: [
        { name: "Command", value: w.cmd || "unknown", inline: true },
        { name: "Directory", value: w.cwd || "unknown", inline: true },
        { name: "Session", value: w.sessionName || "unknown", inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  };

  fetch(DISCORD_ALERT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  }).catch((err) => {
    console.error("Discord alert failed:", err.message);
  });
}
```

핵심 설계 포인트:
- `DISCORD_ALERT_WEBHOOK`이 설정되지 않으면 아무 것도 하지 않음 (옵트인 방식)
- `lastAlertTime` Map으로 워커 ID별 마지막 알림 시각을 추적하여 60초 쿨다운 보장
- Discord Embed 형식으로 워커 ID, 실행 명령, 작업 디렉토리, 세션명 등을 포함
- `fetch(...).catch()`로 실패 시 서버 크래시 방지

### 2-4. pollOutput에서 waiting 전환 시 알림 호출
`pollOutput` 함수 내에서 `aiState`가 `'waiting'`으로 변경되는 두 곳에 `sendWaitingAlert(id)` 호출을 추가한다.

**첫 번째 위치** — 출력이 변하지 않아 idle threshold에 도달한 경우 (162~175행 부근):
현재 코드:
```js
if (newState !== w.aiState) {
  w.aiState = newState;
  broadcast({ type: "aiState", id, state: newState });
}
```
변경 후:
```js
if (newState !== w.aiState) {
  w.aiState = newState;
  broadcast({ type: "aiState", id, state: newState });
  if (newState === 'waiting') sendWaitingAlert(id);
}
```

**두 번째 위치** — 출력이 방금 변경된 직후 waiting을 감지한 경우 (186~190행 부근):
현재 코드:
```js
if (aiState !== w.aiState) {
  w.aiState = aiState;
  broadcast({ type: "aiState", id, state: aiState });
}
```
변경 후:
```js
if (aiState !== w.aiState) {
  w.aiState = aiState;
  broadcast({ type: "aiState", id, state: aiState });
  if (aiState === 'waiting') sendWaitingAlert(id);
}
```

두 곳 모두 `aiState`가 **이전과 다를 때만** (`!== w.aiState`) 실행되므로, 이미 waiting 상태에서 중복 호출되지 않는다. 추가로 `sendWaitingAlert` 내부의 쿨다운이 이중 안전장치 역할을 한다.

### 2-5. 워커 제거 시 쿨다운 정리 (선택적 개선)
`/api/remove` 핸들러에서 `workers.delete(id)` 직후에 `lastAlertTime.delete(id)`를 추가하여 메모리 누수를 방지한다.
