# TermHub

A web dashboard for managing multiple terminal sessions via tmux. Run any command — Claude CLI, bash, python, or anything else — and monitor them all from one place.

## Features

- **Run any command** — spawn sessions with any CLI tool (default: `claude`)
- **Manage multiple terminal sessions** — each runs as an independent worker in a tmux session
- **Real-time logs** — captures and displays tmux session output in real time
- **Two-way mirroring** — view the same session from both the dashboard and your local terminal
- **Tab / Split layout** — switch between views as needed
  - Tab mode: focus on one worker at a time
  - Split mode: view multiple workers side by side (up to 3 columns, grid for 4+)
- **Favorites & recent paths** — quick access to frequently used project directories
- **tmux session scanning** — auto-detect and attach to existing tmux sessions
- **Live status** — running / stopped status updated in real time
- **Password authentication** — protect external access
- **ngrok support** — access from mobile or other external devices
- **Adaptive terminal size** — tmux resizes to match your device's screen
- **Multiline input** — Shift+Enter for newlines, Enter to send
- **Keyboard shortcuts** — Esc, Shift+Tab, Ctrl+C, arrow keys forwarded to active worker

## Prerequisites

- [Node.js](https://nodejs.org)
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- [ngrok](https://ngrok.com) (optional, for external access — `brew install ngrok`)

## Installation

```bash
git clone https://github.com/yourname/termhub.git
cd termhub
npm install
```

## Configuration

```bash
cp config.example.json config.json
```

Edit `config.json` to match your environment:

```json
{
  "basePath": "/Users/yourname/Desktop/",
  "favorites": [
    "/Users/yourname/Desktop/my-project-1",
    "/Users/yourname/Desktop/my-project-2"
  ],
  "defaultCommand": "claude"
}
```

Create a `.env` file to set your password and port:

```bash
PORT=8080
DASHBOARD_PASSWORD=your-password-here
```

## Running

```bash
node server.js
```

## External Access (ngrok)

```bash
ngrok http 8080
```

Open the `https://xxxx.ngrok-free.app` URL in your phone's browser.

## Usage

### Start a new session
1. Click 📁 to select a project path (favorites and recent paths supported)
2. Optionally change the command in the command input (default: `claude`)
3. Click **+ New** — a session starts in a new tmux session

### Attach existing tmux sessions
1. Click 🔍 to scan for running tmux sessions
2. Confirm to add them to the dashboard

### View sessions from your local terminal
```bash
tmux attach -t term-1   # Worker #1
tmux attach -t term-2   # Worker #2
```

### Switch layouts
Use the **Tab / Split** buttons in the top-right corner. Your choice is saved in the browser.

### Stop and remove workers
- Running: **Stop** button — terminates the tmux session
- Stopped: **Remove** button — removes from the dashboard

## File Structure

```
termhub/
├── server.js              # Node.js server (tmux management, WebSocket)
├── index.html             # Web UI entry point
├── public/
│   ├── style.css          # Styles
│   └── js/
│       ├── layout.js      # Layout & tab management
│       ├── favorites.js   # Favorites & path management
│       ├── ws.js          # WebSocket & API communication
│       ├── workers.js     # Worker card UI & actions
│       └── app.js         # Init & event binding
├── config.json            # User config (gitignored)
├── config.example.json    # Config template
├── .env                   # Environment variables (gitignored)
├── .gitignore
├── package.json
└── README.md
```

## License

MIT
