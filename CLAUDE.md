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

**Server (`server.js`):** Single-file Node.js HTTP + WebSocket server. In-memory Maps for session/worker state. Calls tmux via `execSync` to create, control, and monitor terminal sessions. Polls terminal output every 1s and broadcasts via WebSocket.

**Client (`index.html` + `public/`):** CSS and JS separated into `public/style.css` and `public/js/`. Tab/Split dual layout modes. Real-time updates via WebSocket. localStorage for user preferences (layout, favorites, recents).

**JS modules (`public/js/`):**
- `layout.js` — Layout switching & tab management
- `favorites.js` — Favorites & path management
- `ws.js` — WebSocket connection, API helpers, terminal resize
- `workers.js` — Worker card UI, log display, worker actions
- `app.js` — Init, login, event binding, keyboard shortcuts

**Communication flow:**
- REST API (`/api/*`): login, worker spawn/remove/input commands
- WebSocket: server→client real-time broadcast (spawned, status, snapshot, log, cwd message types)
- Auth: password login → random token → HttpOnly cookie

**tmux integration pattern:**
- Session name: `term-{id}`
- Create: `tmux new-session -d -s {name} -c {cwd} "{cmd}"`
- Capture output: `tmux capture-pane -p -S -500 -J` (500 lines, 1s interval)
- Input: `tmux send-keys` for commands/special keys
- Status: `tmux has-session` for liveness check
- CWD tracking: `tmux display-message -p "#{pane_current_path}"` for real-time path updates

## Key Conventions

- Minimal dependencies (only dotenv, ws)
- Native APIs, no frameworks
- Worker IDs are auto-incrementing integers, session names follow `term-{id}` pattern
- API endpoints use `/api/{resource}` format
- Frontend DOM element IDs follow `{type}-{id}` pattern (card-1, logs-1, inp-1, etc.)
- Static files served from `public/` directory
- GitHub dark theme colors (#0d1117, #161b22, #e6edf3)
