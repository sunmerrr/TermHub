#!/bin/bash
# 실서버와 완전히 분리된 테스트 서버를 띄운다.
# - 포트 6081 (셸에 PORT=8081이 export돼 있어도 덮어쓴다)
# - 별도 tmux 서버: tmux는 TMUX_TMPDIR의 실제 경로로 소켓을 만들고, 소켓 경로는 ~100자 제한이 있어 짧은 /tmp 경로를 쓴다
# - 상태 파일(.termhub-state.json)이 __dirname 기준이라 server.js를 작업 폴더로 복사해 실행한다
# - DISABLE_AUTO_UPDATE: oh-my-zsh 업데이트 질문이 워커 명령을 삼키지 않게 한다
# - cloudflared가 없는 PATH + 빈 웹훅: 터널·Discord 알림이 나가지 않는다
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${MTEST_DIR:-/tmp/termhub-mtest}"
mkdir -p "$WORK/app" "$WORK/bin" "$WORK/tmux"
cp "$ROOT/server.js" "$ROOT/index.html" "$WORK/app/"
ln -sfn "$ROOT/public" "$WORK/app/public"
ln -sfn "$ROOT/node_modules" "$WORK/app/node_modules"
ln -sf "$(command -v tmux)" "$WORK/bin/tmux"
ln -sf "$(command -v node)" "$WORK/bin/node"
ln -sf "$(command -v python3)" "$WORK/bin/python3"
rm -f "$WORK/app/.termhub-state.json"
cd "$WORK/app"
unset TMUX TMUX_PANE
export PORT="${MTEST_PORT:-6081}" DASHBOARD_PASSWORD=mtest TERMHUB_NAME=mobile-test \
  TMUX_TMPDIR="$WORK/tmux" PATH="$WORK/bin:/usr/bin:/bin" \
  DISCORD_WEBHOOK= DISCORD_ALERT_WEBHOOK= ENABLE_TUNNEL_HEALTHCHECK=0 ENABLE_PREVIEW=0 DISABLE_AUTO_UPDATE=true
exec node server.js
