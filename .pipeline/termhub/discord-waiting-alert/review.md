# Code Review: Discord Waiting Alert + Resize 정확도 개선

## 작업 내용 요약
> Worker가 "waiting" 상태에 진입했을 때 Discord Webhook을 통해 알림을 전송하는 기능 추가 및 터미널 리사이즈 계산 정확도 개선

- **Discord 대기 알림 기능 추가**: Worker가 사용자 입력 대기 상태(`waiting`)에 진입하면 `DISCORD_ALERT_WEBHOOK` 환경변수로 설정된 Discord 채널에 Embed 메시지를 전송
- **워커별 60초 쿨다운**: 동일 Worker에 대해 반복 알림을 방지하기 위한 `ALERT_COOLDOWN_MS` (60초) 적용
- **tmux resize-pane 명령 추가**: 기존 `resize-window`만 수행하던 것에 `resize-pane`도 함께 수행하여 pane 크기 동기화 보장
- **클라이언트 리사이즈 계산 개선**: 하드코딩된 padding 값(16px) 대신 `getComputedStyle`을 사용하여 실제 CSS padding을 동적으로 계산

## 변경 상세

### Server - Discord Waiting Alert (`server.js`)
| 파일 | 변경 내용 | 비고 |
|------|-----------|------|
| `server.js:11` | `DISCORD_ALERT_WEBHOOK` 환경변수 읽기 추가 | `.env` 설정 필요 |
| `server.js:24-25` | `ALERT_COOLDOWN_MS` (60초) 상수 및 `lastAlertTime` Map 추가 | 워커별 쿨다운 관리 |
| `server.js:121-152` | `sendWaitingAlert(id)` 함수 신규 추가 | Discord Embed 형식으로 Worker 정보 전송 |
| `server.js:172` | `tmux resize-pane` 명령 추가 | `resize-window` 직전에 실행 |
| `server.js:208` | idle threshold 감지 후 waiting 상태 시 알림 호출 | `pollOutput` 내부 |
| `server.js:227` | output 변경 직후 waiting 감지 시 알림 호출 | `pollOutput` 내부 |
| `server.js:411` | `lastAlertTime.delete(id)` — Worker 제거 시 쿨다운 정보도 삭제 | 메모리 정리 |

### Client - Resize 계산 개선 (`public/js/ws.js`)
| 파일 | 변경 내용 | 비고 |
|------|-----------|------|
| `public/js/ws.js:68-74` | 하드코딩된 `16`px 대신 `getComputedStyle`로 실제 padding 동적 계산 | X/Y 양방향 모두 적용 |

### 주의사항
- **환경변수 추가 필요**: `DISCORD_ALERT_WEBHOOK`를 `.env`에 설정해야 Discord 알림이 동작함. 미설정 시 기능은 조용히 비활성화됨 (`if (!DISCORD_ALERT_WEBHOOK) return;`)
- **기존 `DISCORD_WEBHOOK`과 별도**: 터널 URL 알림용 기존 웹훅과 대기 알림용 웹훅이 분리되어 있어, 채널을 달리 설정할 수 있음
- **`resize-pane` 추가로 인한 tmux 호출 증가**: 매 poll 주기(1초)마다 `resize-pane` + `resize-window` 두 번 호출됨. 성능 영향은 미미하나, Worker 수가 많을 경우 `execSync` 호출이 증가할 수 있음
- **`fetch`는 Node.js 18+ 필요**: `sendWaitingAlert` 함수에서 전역 `fetch`를 사용함. Node.js 18 미만에서는 런타임 에러 발생 (단, 기존 `startTunnel`의 Discord 웹훅 전송에서도 이미 `fetch`를 사용 중이므로 기존 환경과 동일)

## 빌드 & 테스트 결과
| 항목 | 결과 | 상세 |
|------|------|------|
| Syntax Check (server.js) | PASS | `node -c server.js` 통과 |
| Syntax Check (ws.js) | PASS | `node -c public/js/ws.js` 통과 |
| npm test | N/A | "no test specified" — 테스트 스크립트 미정의 |

## 코드 리뷰 소견

### 잠재적 이슈

1. **`sendWaitingAlert`에서 `workers.get(id)` 호출 위치 (server.js:129)**
   - `lastAlertTime.set(id, now)`을 먼저 수행한 후 `workers.get(id)`로 Worker 존재를 확인함. Worker가 없으면 `return`하지만, 이미 쿨다운 타임스탬프가 설정된 상태. 실질적 문제는 아니나(존재하지 않는 Worker에 대해 호출될 가능성이 낮음), 방어적 코딩을 위해 Worker 존재 확인을 쿨다운 갱신 전으로 이동하는 것이 바람직함.

2. **`resize-pane` 호출 시 세션 이름 사용 (server.js:172)**
   - `tmux resize-pane -t ${w.sessionName}` — 세션에 여러 pane이 있을 경우 어떤 pane이 리사이즈될지 불확실할 수 있음. 현재 TermHub는 세션당 단일 pane 구조이므로 문제없으나, 향후 멀티 pane 지원 시 주의 필요.

3. **Discord 알림 실패 시 에러 처리 (server.js:149)**
   - `fetch(...).catch((err) => console.error(...))` — 적절한 에러 처리. 다만 네트워크 장애 시 매 60초마다 에러 로그가 쌓일 수 있음. 반복 실패 시 백오프 로직이 없음.

### 긍정적 사항
- 쿨다운 메커니즘이 잘 구현되어 알림 폭주를 방지함
- Worker 제거 시 `lastAlertTime` 정리하여 메모리 누수 방지
- 클라이언트 리사이즈 계산이 동적 padding으로 개선되어 CSS 변경에 유연하게 대응

## 테스트 방식 추천

### 자동 테스트
- `sendWaitingAlert` 함수의 단위 테스트: 쿨다운 로직 검증 (60초 이내 재호출 시 전송하지 않는지)
- `sendResize` 함수의 padding 계산 로직 테스트: 다양한 padding 값에 대한 cols/rows 계산 검증
- Discord Webhook 모킹을 통한 Embed 포맷 검증

### 수동 테스트
1. **Discord 알림 동작 확인**
   - `.env`에 `DISCORD_ALERT_WEBHOOK` 설정 후 서버 시작
   - Worker를 spawn하고 AI CLI가 권한 승인 대기 상태에 진입하도록 유도
   - Discord 채널에 Embed 메시지가 수신되는지 확인
   - 60초 이내에 동일 Worker가 다시 waiting 상태가 되었을 때 알림이 전송되지 않는지 확인

2. **`DISCORD_ALERT_WEBHOOK` 미설정 시**
   - 환경변수 미설정 상태에서 서버 시작, waiting 상태 진입 시 에러 없이 무시되는지 확인

3. **터미널 리사이즈 확인**
   - 브라우저 창 크기를 변경하면서 tmux pane 크기가 정확히 동기화되는지 확인
   - 특히 padding이 있는 레이아웃(탭 모드, 분할 모드)에서 콘텐츠가 잘리지 않는지 확인

4. **resize-pane 추가 확인**
   - `tmux list-panes -t term-{id}` 명령으로 pane 크기가 `resize-window` 크기와 일치하는지 확인

### 엣지 케이스
- Worker가 매우 빠르게 waiting/working 상태를 왔다 갔다 할 때 쿨다운이 정상 동작하는지
- 여러 Worker가 동시에 waiting 상태에 진입할 때 각각 별도 알림이 전송되는지
- Discord Webhook URL이 잘못된 형식일 때 서버가 크래시하지 않는지
- `getComputedStyle`이 hidden 상태의 `.logs` 요소에서 올바르게 동작하는지 (이미 `clientWidth > 0` 체크로 필터링됨)
- `box.clientWidth`가 padding보다 작은 극단적 경우 (`innerW = Math.max(0, ...)` 으로 처리됨)
