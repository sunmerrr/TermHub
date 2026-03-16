# Retrospective: termhub / discord-waiting-alert

## Execution Summary

| Agent | Status | Notes |
|-------|--------|-------|
| Planner | 완료 | 5개 세부 태스크로 분리, 의존관계 명시, 코드 스니펫까지 포함한 상세 계획 작성 |
| Implementer | 완료 | 계획의 모든 항목(2-1 ~ 2-5) 누락 없이 구현. 라인 번호까지 progress.md에 기록 |
| Reviewer | 완료 | 변경 전 범위(Discord 알림)에서 리사이즈 개선까지 스코프 확장 포함, 잠재 이슈 3건 식별 |

## Pipeline Health

| 항목 | 결과 | 상세 |
|------|------|------|
| Syntax Check (server.js) | PASS | `node -c` 통과 |
| Syntax Check (ws.js) | PASS | `node -c` 통과 |
| 자동 테스트 | N/A | 프로젝트에 테스트 스크립트 없음 (`npm test` → "no test specified") |
| 실제 Discord 전송 검증 | 미실시 | 수동 테스트 가이드만 제시됨 |

## Issues Found

1. **`sendWaitingAlert` 내 쿨다운 타임스탬프 순서 문제** (review.md §잠재적 이슈 1)
   - `lastAlertTime.set(id, now)` 이후에 `workers.get(id)` 존재 확인을 수행.
   - Worker가 없을 경우 쿨다운 타임스탬프만 설정된 채 반환되므로 이후 60초간 실제 Worker가 생겨도 알림이 전송되지 않을 수 있음.
   - 현재 코드상 `pollOutput`에서만 호출되므로 실제 발생 가능성은 낮으나, 방어적 순서 교정이 권장됨.

2. **Discord Webhook 네트워크 실패 시 백오프 없음** (review.md §잠재적 이슈 3)
   - 네트워크 장애 지속 시 60초마다 에러 로그가 반복 출력됨.
   - 현재 단계에서 과도한 복잡도를 추가하지 않기 위해 의도적으로 생략된 것으로 보임.

3. **research.md 없음**
   - 아티팩트 디렉토리에 research.md가 존재하지 않음.
   - 이번 작업은 기존 코드(`DISCORD_WEBHOOK` 패턴, `pollOutput` 구조)를 파악하면 충분히 계획 가능한 범위였으므로 별도 리서치 단계 없이 진행된 것으로 보임. 문제는 아니지만, 파이프라인 관례 상 파일이 없으면 추적이 어려울 수 있음.

## Patterns & Observations

1. **스코프 확장이 리뷰 단계에서 발견됨**
   - plan.md는 Discord 알림 기능만 다루고 있으나, review.md를 보면 `tmux resize-pane` 추가 및 `getComputedStyle` 리사이즈 개선도 함께 구현된 것을 알 수 있음.
   - 관련 개선이라 품질에는 긍정적이나, 계획에 없던 변경이 구현 단계에서 추가되어 플래너-구현자 간 범위 불일치가 발생했음.
   - 추가 변경 자체는 유익하나, plan.md가 이를 반영하지 않아 추적성이 낮아짐.

2. **계획의 정밀도가 높아 구현 품질이 안정적**
   - plan.md에 코드 스니펫, 삽입 위치(기존 코드 → 변경 후 코드), 설계 포인트가 모두 포함되어 있어 구현 오류가 없었음.
   - progress.md의 라인 번호 기록이 리뷰 단계와 정확히 일치하는 것으로 보아 구현 충실도가 높음.

3. **자동 테스트 인프라 부재가 반복적으로 노출됨**
   - 이번 파이프라인 포함, 프로젝트 전반에 `npm test`가 정의되지 않아 모든 검증이 syntax check와 수동 테스트에 의존하고 있음.
   - Discord 쿨다운 로직, resize 계산 등은 단위 테스트로 자동화하기 적합한 대상임에도 테스트가 작성되지 않음.

4. **Embed 필드 값에 빈값 방어 처리가 충분함**
   - `w.cmd || "unknown"`, `w.cwd || "unknown"`, `w.sessionName || "unknown"` 패턴으로 누락된 필드를 안전하게 처리함.
   - 서버 크래시 방지를 위한 `.catch()` 처리도 일관성 있음.

5. **워커 제거 시 메모리 정리가 plan 단계부터 고려됨**
   - `lastAlertTime.delete(id)` 는 계획(Task 2-5)에서 "선택적 개선"으로 명시됐으나 실제로 구현까지 완료됨.
   - 이런 작은 메모리 안전성 항목을 계획 단계부터 포함시키는 습관이 긍정적임.

## Skill Improvements Made

변경 불필요. 이번 파이프라인에서 식별된 패턴(스코프 확장 추적, 자동 테스트 부재)은 프로젝트 수준의 구조적 이슈로, SKILL.md 수정보다는 아래 권고사항으로 전달하는 것이 적절함.

## Recommendations for Next Run

1. **plan.md와 구현 간 스코프 동기화**
   - 구현 도중 계획에 없는 개선을 추가할 경우, progress.md 또는 plan.md에 "추가 변경" 섹션을 만들어 명시적으로 기록할 것. 이번처럼 review.md에서 처음 드러나면 추적성이 떨어짐.

2. **`sendWaitingAlert` 내 Worker 존재 확인 순서 교정**
   - `workers.get(id)` 확인을 `lastAlertTime.set(id, now)` 이전으로 이동하여 방어적 코딩 완성.
   - 간단한 수정이므로 다음 관련 작업 시 함께 처리 권장.

3. **자동 테스트 도입 검토**
   - Discord 알림 쿨다운 로직, resize 계산 등 순수 함수에 대한 단위 테스트를 `test/` 디렉토리에 도입할 것. Node.js 내장 `node:test` 모듈 또는 최소 의존성의 테스트 라이브러리를 활용하면 프레임워크 없이도 가능.

4. **research.md 관례 통일**
   - 외부 API, 미지의 라이브러리, 레거시 코드 분석이 필요한 경우 research.md를 남기는 관례를 명확히 정의. 이번처럼 기존 패턴 파악만으로 충분한 경우는 "research.md 생략 사유"를 plan.md 서두에 한 줄 기재하는 방식도 유효함.

5. **Discord 알림 실패 백오프 (장기 개선)**
   - 현재는 매 쿨다운 주기마다 재시도하는 구조. 연속 실패 횟수를 추적하여 지수 백오프 또는 최대 재시도 횟수 제한을 추가하면 네트워크 장애 시 로그 노이즈를 줄일 수 있음.
