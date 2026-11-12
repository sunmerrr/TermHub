# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TermHub is a web dashboard for managing multiple terminal sessions via tmux. Supports any command (default: `claude`). Built with native Node.js HTTP server + vanilla JS frontend — no frameworks.

## Commands

```bash
npm install          # Install dependencies
node server.js       # Start server (default port: 8080)

# System dependencies (macOS)
brew install tmux
```

Config files: `.env` (PORT, DASHBOARD_PASSWORD), `config.json` (basePath, favorites, defaultCommand) — both gitignored. Copy `config.example.json` to create `config.json`.

## Architecture

**Server (`server.js`):** Single-file Node.js HTTP + WebSocket server. In-memory Maps for session/worker state. Calls tmux via `execSync` to create, control, and monitor terminal sessions. Each running worker gets a tmux control-mode client (`tmux -C attach`); its `%output` bytes stream over WebSocket to the viewers of that worker and are drawn with xterm.js. A 1s `capture-pane` poll remains for state detection (waiting/idle, ports).

**Client (`index.html` + `public/`):** CSS and JS separated into `public/style.css` and `public/js/`. Tab/Split dual layout modes. Real-time updates via WebSocket. localStorage for user preferences (layout, favorites, recents).

**JS modules (`public/js/`):**
- `layout.js` — Layout switching & tab management
- `favorites.js` — Favorites & path management
- `ws.js` — WebSocket connection, API helpers, terminal resize
- `workers.js` — Worker card UI, log display, worker actions
- `app.js` — Init, login, event binding, keyboard shortcuts

**Communication flow:**
- REST API (`/api/*`): login, worker spawn/remove/input commands
- WebSocket: server→client real-time broadcast (spawned, status, log, cwd, …); terminal stream `term` (initial screen, sent on view and after resize) and `out` (raw pane bytes, base64); client→server `view`, `resize`, `input` (keystrokes typed into xterm.js, sent with `send-keys -H`)
- Auth: password login → random token → HttpOnly cookie

**tmux integration pattern:**
- Session name: `term-{id}`
- Create: `tmux new-session -d -s {name} -c {cwd} "{cmd}"`
- Stream output: control mode `%output`; initial screen via `capture-pane -p -e -S -2000` on the same control connection (ordered with the stream)
- Pane size = the viewing browser's xterm.js size; the device that opens or types into a worker owns its size
- Input: `tmux send-keys` for commands/special keys
- Status: `tmux has-session` for liveness check
- CWD tracking: `tmux display-message -p "#{pane_current_path}"` for real-time path updates

**Usage tracking (`refreshWorkerUsage`, every 10s):** per-worker tokens / estimated API-rate cost / context % from Claude transcripts (`~/.claude/projects/*/<sessionId>.jsonl`, deduped by message id + request id) and Codex rollouts (`~/.codex/sessions/**/rollout-*.jsonl`, matched by cwd + mtime). Account limits: Claude via the OAuth usage endpoint with the Keychain token (every 15 min while a dashboard is open, honoring 429 retry-after); Codex from the newest rollout's `rate_limits`. Pricing tables follow Orca (stablyai/orca).

## Key Conventions

- Minimal dependencies (only dotenv, ws, web-push)
- Native APIs, no frameworks
- Worker IDs are auto-incrementing integers, session names follow `term-{id}` pattern
- API endpoints use `/api/{resource}` format
- Frontend DOM element IDs follow `{type}-{id}` pattern (card-1, logs-1, inp-1, etc.)
- Static files served from `public/` directory
- GitHub dark theme colors (#0d1117, #161b22, #e6edf3)
