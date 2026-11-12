require("dotenv").config();
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { execSync, execFileSync, execFile, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8081;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const DISCORD_USERNAME = "lulu";
const DISCORD_AVATAR_URL = "https://api.dicebear.com/9.x/bottts/png?seed=lulu";
const ENABLE_TUNNEL_HEALTHCHECK = process.env.ENABLE_TUNNEL_HEALTHCHECK === "1";
const TUNNEL_HEALTHCHECK_INTERVAL_MS = Number(process.env.TUNNEL_HEALTHCHECK_INTERVAL_MS || 30000);
const TUNNEL_HEALTHCHECK_FAILURE_LIMIT = Number(process.env.TUNNEL_HEALTHCHECK_FAILURE_LIMIT || 2);
const DISCORD_ALERT_WEBHOOK = process.env.DISCORD_ALERT_WEBHOOK;
const ALERT_WEBHOOK = DISCORD_ALERT_WEBHOOK || DISCORD_WEBHOOK;
const ENABLE_PREVIEW = process.env.ENABLE_PREVIEW === "1";
const PREVIEW_TUNNEL = process.env.PREVIEW_TUNNEL === "1";
const PREVIEW_HEALTH_INTERVAL_MS = Math.max(
  60000,
  Number(process.env.PREVIEW_HEALTH_INTERVAL_MS || 60 * 60 * 1000)
);
const PREVIEW_CLOSE_FAILURES = Math.max(1, Number(process.env.PREVIEW_CLOSE_FAILURES || 1));
// 리사이즈 후 TUI가 화면을 다시 그리는 동안 빈 캡처를 무시하는 시간 (1초 폴링 두 번 분량)
const RESIZE_SETTLE_MS = 2500;
const STATE_PATH = path.join(__dirname, ".termhub-state.json");
// Claude Code가 실행 중인 세션마다 남기는 레지스트리 (<pid>.json: sessionId, tmux 위치, 세션 간 메시징 이름)
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const CLAUDE_SESSION_SYNC_MS = 5000;
// 대시보드에서 올린 첨부 파일은 워커와 같은 머신(이 서버)에 저장되므로 Claude/Codex가 경로로 바로 읽는다
const UPLOAD_DIR = path.join(os.homedir(), ".termhub", "uploads");
const UPLOAD_MAX_BYTES = Math.max(1, Number(process.env.UPLOAD_MAX_MB || 20)) * 1024 * 1024;
const UPLOAD_RETENTION_DAYS = Math.max(1, Number(process.env.UPLOAD_RETENTION_DAYS || 7));
const UPLOAD_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ENABLE_PREVIEW_PORT_SCAN = process.env.ENABLE_PREVIEW_PORT_SCAN === "1";

// workerId(문자열) → Set<number> : 워커별 감지된 포트 목록
const detectedPorts = new Map();
// port(number) → { process, url } : 포트별 cloudflared 터널 상태
const previewTunnels = new Map();
// localhost 포트 감지 정규식: common dev-server output formats.
const PORT_PATTERNS = [
  /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3}|\[?::1\]?|\[?::\]?|host\.docker\.internal|\S+\.local):(\d{2,5})(?=\b|[/?#])/gim,
  /\b(?:port|listening|server)\b[^\n\d]{0,40}(\d{2,5})(?=\b|[/?#])/gim,
];
const PREVIEW_IGNORE_OUTPUT_PATTERN = /\b(mcp|model context protocol|cloudflared|trycloudflare\.com|debugger|inspector|devtools)\b/i;
const PREVIEW_IGNORE_PROCESS_PATTERN = /\b(mcp|mcp-server|cloudflared|rapportd|discord|figma|code helper|limactl|ssh)\b/i;
const PREVIEW_ALLOWED_PORTS = new Set(
  (process.env.PREVIEW_ALLOWED_PORTS || "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
);
const PORT_SCAN_INTERVAL_MS = Number(process.env.PORT_SCAN_INTERVAL_MS || 3000);
const IGNORED_PREVIEW_PORT_TTL_MS = Number(process.env.IGNORED_PREVIEW_PORT_TTL_MS || 60000);
let lastPortScanAt = 0;
let cachedListeningPortsByPid = new Map();
const ignoredPreviewPorts = new Map();

if (PASSWORD === "changeme") {
  console.warn("⚠️  Using default password. Please set DASHBOARD_PASSWORD environment variable.");
}

const workers = new Map();
const workerResizeOwners = new Map();
let nextId = 1;
let tunnelUrl = null;
let tunnelProcess = null;
let tunnelHealthFailures = 0;
let cachedTunnelUrl = null;
const ACTION_WINDOW_MS = 7000;
const INPUT_ENTER_DELAY_MS = Number(process.env.INPUT_ENTER_DELAY_MS || 150);
const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish"]);
const issueAlertTime = new Map(); // key: alert key, value: timestamp
const ISSUE_ALERT_COOLDOWN_MS = 120000; // 120s cooldown per issue key

// Deterministic token derived from password — survives server restarts.
// Rotating PASSWORD invalidates all existing cookies.
function expectedToken() {
  return crypto.createHmac("sha256", PASSWORD).update("termhub-session-v1").digest("hex");
}

function workerScopeToken(workerId) {
  return crypto.createHmac("sha256", PASSWORD).update(`termhub-worker-scope-v1:${workerId}`).digest("hex");
}

const SESSION_MAX_AGE = 60 * 60 * 24; // 1 day

function isAlive(sessionName) {
  try {
    execSync(`tmux has-session -t ${sessionName}`, { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch (e) {
    return false;
  }
}

function tmux(cmd) {
  try { return execSync("tmux " + cmd, { encoding: "utf8", stdio: "pipe" }); }
  catch (e) { return ""; }
}

function tmuxExec(args) {
  try {
    return execFileSync("tmux", args.map(String), { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    return "";
  }
}

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  return fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
}

function loadState() {
  try {
    return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : {};
  } catch (e) {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function getSessionTitle(sessionName) {
  return loadState().titles?.[sessionName] || "";
}

function setSessionTitle(sessionName, title) {
  const state = loadState();
  state.titles = state.titles || {};
  const trimmed = String(title || "").trim().slice(0, 80);
  if (trimmed) state.titles[sessionName] = trimmed;
  else delete state.titles[sessionName];
  saveState(state);
  return trimmed;
}

// ── 워커 영속화 — 재부팅으로 tmux가 통째로 사라져도 어떤 폴더에서 어떤 Claude 세션이 돌고 있었는지 남긴다 ──
// tmux 서버 식별자(pid:시작 시각). 저장해 두면 재시작 때 "tmux 서버는 그대로인데 세션만 없어졌다"(사용자가 끈 것)와
// "재부팅·tmux 재시작으로 전부 사라졌다"를 구분할 수 있다
const TMUX_SERVER_ID_TTL_MS = 60000;
let tmuxServerIdCache = { id: null, at: 0 };
function tmuxServerId() {
  if (Date.now() - tmuxServerIdCache.at > TMUX_SERVER_ID_TTL_MS) {
    tmuxServerIdCache = { id: tmuxExec(["display-message", "-p", "#{pid}:#{start_time}"]).trim() || null, at: Date.now() };
  }
  return tmuxServerIdCache.id;
}

function persistWorker(id) {
  const w = workers.get(String(id));
  if (!w) return;
  const state = loadState();
  state.workers = state.workers || {};
  state.workers[String(id)] = {
    sessionName: w.sessionName,
    cwd: w.cwd,
    cmd: w.cmd || "",
    env: w.env || {},
    claudeSessionId: w.claudeSessionId || null,
    claudeName: w.claudeName || null,
    status: w.status,
    startedAt: w.startedAt || null,
    tmuxServer: tmuxServerId(),
  };
  saveState(state);
}

function forgetPersistedWorker(id) {
  const state = loadState();
  if (!state.workers || !state.workers[String(id)]) return;
  delete state.workers[String(id)];
  saveState(state);
}

// tmux 세션 이름("term-3") → 그 안에서 살아 있는 Claude 세션 정보. 레지스트리의 tmux 필드("term-3:@2.%2")로 짝을 맞춘다.
function readClaudeSessionRegistry() {
  const byTmuxSession = new Map();
  let files = [];
  try { files = fs.readdirSync(CLAUDE_SESSIONS_DIR); } catch { return byTmuxSession; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let info;
    try { info = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, file), "utf8")); } catch { continue; }
    if (!info || !info.sessionId || typeof info.tmux !== "string") continue;
    // 비정상 종료 후 남은 파일은 pid가 죽어 있다
    try { process.kill(info.pid, 0); } catch { continue; }
    const tmuxSession = info.tmux.split(":")[0];
    const prev = byTmuxSession.get(tmuxSession);
    if (!prev || (info.startedAt || 0) > prev.startedAt) {
      byTmuxSession.set(tmuxSession, {
        sessionId: info.sessionId,
        name: info.name || null,
        startedAt: info.startedAt || 0,
        status: typeof info.status === "string" ? info.status : null,
      });
    }
  }
  return byTmuxSession;
}

// 워커마다 매초 레지스트리를 읽으면 파일 수 × 워커 수만큼 읽게 되므로 1초 동안은 같은 결과를 나눠 쓴다
let claudeRegistryCache = { at: 0, map: new Map() };
function claudeRegistryEntry(w) {
  if (Date.now() - claudeRegistryCache.at > 900) {
    claudeRegistryCache = { at: Date.now(), map: readClaudeSessionRegistry() };
  }
  const found = claudeRegistryCache.map.get(w.sessionName);
  if (!found) return null;
  // 재부팅 전 파일의 pid가 다른 프로세스에 재사용됐을 수 있다 — 워커(tmux 세션)보다 먼저 시작된 기록은 믿지 않는다
  if (found.startedAt && w.startedAt && found.startedAt < w.startedAt - 60000) return null;
  return found;
}

function syncClaudeSessions() {
  for (const [id, w] of workers) {
    if (w.status !== "running") continue;
    const found = claudeRegistryEntry(w);
    if (!found) continue;
    if (found.sessionId === w.claudeSessionId && found.name === w.claudeName) continue;
    w.claudeSessionId = found.sessionId;
    w.claudeName = found.name;
    persistWorker(id);
    broadcast({ type: "claude", id, claudeSessionId: w.claudeSessionId, claudeName: w.claudeName });
  }
}

// Claude는 첫 메시지를 보내기 전까지 대화 기록(jsonl)을 만들지 않는다 — 기록이 없는 세션을 --resume 하면 에러만 남기고 셸로 떨어진다
function claudeTranscriptExists(sessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return false; }
  return dirs.some((d) => fs.existsSync(path.join(projectsDir, d, `${sessionId}.jsonl`)));
}

// 저장된 명령에 --resume <id> 를 붙인다. 이전 --resume/--continue 는 떼어내 중복을 막는다.
// sessionId가 null이면 resume 없이 원래 명령만 돌려준다.
function buildResumeCommand(cmd, sessionId) {
  const tokens = String(cmd || "").trim().split(/\s+/).filter(Boolean);
  const base = tokens[0] || "";
  if (!(base === "claude" || base.endsWith("/claude"))) return sessionId ? `claude --resume ${sessionId}` : "claude";
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--resume" || t === "-r") {
      if (tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
      continue;
    }
    if (t === "--continue" || t === "-c") continue;
    kept.push(t);
  }
  if (!sessionId) return kept.join(" ") || "claude";
  return [...kept, "--resume", sessionId].join(" ");
}

const DEFAULT_PRESETS = ["계속해", "/compact"];

function getPresets() {
  const saved = loadState().presets;
  return Array.isArray(saved) ? saved : DEFAULT_PRESETS;
}

// ── UI state (탭 순서·핀·마지막 활성 탭) — 어느 기기에서 열어도 같은 화면이 되도록 서버에 저장 ──
function getUiState() {
  const ui = loadState().ui || {};
  return {
    tabOrder: Array.isArray(ui.tabOrder) ? ui.tabOrder : [],
    pinned: Array.isArray(ui.pinned) ? ui.pinned : [],
    activeTab: typeof ui.activeTab === "string" ? ui.activeTab : null,
  };
}

function updateUiState(partial) {
  const state = loadState();
  const ui = getUiState();
  const idList = (v) => Array.isArray(v) ? [...new Set(v.map(String).filter((id) => /^\d+$/.test(id)))].slice(0, 200) : null;
  if (idList(partial.tabOrder)) ui.tabOrder = idList(partial.tabOrder);
  if (idList(partial.pinned)) ui.pinned = idList(partial.pinned);
  if (partial.activeTab !== undefined) ui.activeTab = /^\d+$/.test(String(partial.activeTab)) ? String(partial.activeTab) : null;
  state.ui = ui;
  saveState(state);
  return ui;
}

function forgetWorkerUiState(id) {
  const ui = getUiState();
  const sid = String(id);
  if (!ui.tabOrder.includes(sid) && !ui.pinned.includes(sid) && ui.activeTab !== sid) return;
  const state = loadState();
  state.ui = {
    tabOrder: ui.tabOrder.filter((t) => t !== sid),
    pinned: ui.pinned.filter((t) => t !== sid),
    activeTab: ui.activeTab === sid ? null : ui.activeTab,
  };
  saveState(state);
}

// 즐겨찾기·최근 경로 — localStorage는 터널 URL(origin)이 바뀌면 사라지므로 서버에 보관
function getPaths() {
  const state = loadState();
  return {
    favorites: Array.isArray(state.favorites) ? state.favorites : null,
    recents: Array.isArray(state.recents) ? state.recents : [],
  };
}

function updatePaths(partial) {
  const state = loadState();
  const clean = (v, max) => Array.isArray(v)
    ? [...new Set(v.map((x) => String(x).trim().slice(0, 500)).filter(Boolean))].slice(0, max)
    : null;
  const favorites = clean(partial.favorites, 50);
  const recents = clean(partial.recents, 10);
  if (favorites) state.favorites = favorites;
  if (recents) state.recents = recents;
  saveState(state);
  return getPaths();
}

function sessionCreatedAt(sessionName) {
  const sec = Number(tmux(`display-message -t ${sessionName} -p "#{session_created}"`).trim());
  return sec > 0 ? sec * 1000 : Date.now();
}

function getBaseCommand(cmd) {
  if (!cmd) return "";
  return String(cmd).trim().split(/\s+/)[0] || "";
}

// pane 크기는 브라우저 터미널(xterm.js) 크기와 같아야 한다 — 출력 바이트를 그대로 그리므로 크기가 다르면 줄이 어긋난다
function terminalRowsForWorker(w) {
  return w.rows || 50;
}

function isClaudeWorker(w) {
  // 재시작 후 tmux에서 복구된 워커는 cmd가 pane 명령(claude.exe)이라 이름으로는 못 알아본다 — 레지스트리에서 세션이 잡혔으면 Claude다
  if (w?.claudeSessionId) return true;
  const baseCommand = getBaseCommand(w?.cmd || w?.expectedCmd);
  return baseCommand === "claude" || baseCommand.endsWith("/claude");
}

function displayOutputForWorker(w, output) {
  if (!isClaudeWorker(w) && !w.alternateScreen) return output;
  let lines = output.split("\n");
  if (w.alternateScreen) {
    // 전체 화면 TUI는 입력창을 pane 맨 아래(500행)에 그려 대화와 입력창 사이에 빈 줄이 수백 개 생긴다 — 3줄 이상 이어지는 빈 줄은 2줄로 줄인다
    const collapsed = [];
    let blankRun = 0;
    for (const line of lines) {
      blankRun = line.trim() === "" ? blankRun + 1 : 0;
      if (blankRun > 2) continue;
      collapsed.push(line);
    }
    lines = collapsed;
  }
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function countNonBlankLines(output) {
  let n = 0;
  for (const line of output.split("\n")) if (line.trim() !== "") n++;
  return n;
}

function rememberAction(w, type, detail) {
  w.lastAction = { type, detail, ts: Date.now() };
}

function recentAction(w) {
  if (!w || !w.lastAction) return null;
  if (Date.now() - w.lastAction.ts > ACTION_WINDOW_MS) return null;
  return w.lastAction;
}

function inferExitReason(w, fallback) {
  const action = recentAction(w);
  if (action?.type === "stop_button") return "Stopped from dashboard (Stop button).";
  if (action?.type === "special_key" && action.detail === "C-c") return "Interrupted by Ctrl+C sent from dashboard.";
  if (action?.type === "special_key") return `Exited after key input from dashboard (${action.detail}).`;
  if (w?.status === "completed" && w?.lastPaneCommand && w?.expectedCmd && w.lastPaneCommand !== w.expectedCmd) {
    return `Command '${w.expectedCmd}' is no longer active (pane now '${w.lastPaneCommand}').`;
  }
  return fallback || "Session exited (reason unknown).";
}

// DB·인프라 서비스의 대표 포트 — 미리보기 대상에서 제외 (false positive 방지)
const EXCLUDED_PORTS = new Set([
  3306,  // MySQL
  5432,  // PostgreSQL
  5433,  // PostgreSQL (alt)
  27017, // MongoDB
  27018, 27019,
  6379,  // Redis
  6380,
  5672,  // RabbitMQ
  15672, // RabbitMQ management
  9200,  // Elasticsearch
  9300,
  2181,  // ZooKeeper
  2375,  // Docker daemon
  2376,
]);

function checkPortListening(port) {
  function tryConnect(host) {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(500);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, host);
    });
  }
  // IPv4 먼저, 실패하면 IPv6
  return tryConnect("127.0.0.1").then((ok) => ok ? true : tryConnect("::1"));
}

function requestContentType(port, hostname) {
  return new Promise((resolve) => {
    const req = http.get({ hostname, port, path: "/", timeout: 2000 }, (res) => {
      const ct = (res.headers["content-type"] || "").toLowerCase();
      res.resume(); // 응답 body 소비 (메모리 누수 방지)
      resolve(ct.includes("text/html") ? "html" : ct || "unknown");
    });
    req.on("error", () => resolve("error"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  });
}

// Content-Type 체크: HTML이면 프론트엔드로 판단
async function checkContentType(port) {
  const ipv4 = await requestContentType(port, "127.0.0.1");
  if (ipv4 !== "error" && ipv4 !== "timeout") return ipv4;
  return requestContentType(port, "::1");
}

function isPreviewPort(port) {
  return Number.isInteger(port) &&
    port >= 1024 &&
    port <= 65535 &&
    port !== Number(PORT) &&
    (PREVIEW_ALLOWED_PORTS.has(port) || !EXCLUDED_PORTS.has(port));
}

function isExplicitlyAllowedPreviewPort(port) {
  return PREVIEW_ALLOWED_PORTS.has(port);
}

function isRecentlyIgnoredPreviewPort(port) {
  const ignoredAt = ignoredPreviewPorts.get(port);
  if (!ignoredAt) return false;
  if (Date.now() - ignoredAt <= IGNORED_PREVIEW_PORT_TTL_MS) return true;
  ignoredPreviewPorts.delete(port);
  return false;
}

function rememberIgnoredPreviewPort(port) {
  ignoredPreviewPorts.set(port, Date.now());
}

// lsof/ps는 macOS에서 1초 이상 걸릴 수 있어 동기 호출 시 이벤트 루프가 멈춘다 → 반드시 비동기로
function execFileAsync(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

async function getCommandLine(pid) {
  return (await execFileAsync("ps", ["-p", String(pid), "-o", "command="])).trim();
}

async function isIgnoredPreviewPortOwner(port) {
  const raw = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (!raw) return false;

  let current = { pid: null, command: "" };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      current = { pid: line.slice(1), command: "" };
      if (PREVIEW_IGNORE_PROCESS_PATTERN.test(await getCommandLine(current.pid))) {
        return true;
      }
      continue;
    }
    if (line[0] !== "c") continue;
    current.command = line.slice(1);
    if (PREVIEW_IGNORE_PROCESS_PATTERN.test(current.command)) {
      return true;
    }
  }
  return false;
}

function getProcessChildrenByPpid() {
  const children = new Map();
  let raw = "";
  try {
    raw = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    return children;
  }

  for (const line of raw.trim().split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return children;
}

function collectDescendantPids(rootPid) {
  const root = Number(rootPid);
  if (!Number.isInteger(root) || root <= 0) return new Set();

  const children = getProcessChildrenByPpid();
  const pids = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop();
    for (const child of children.get(pid) || []) {
      if (pids.has(child)) continue;
      pids.add(child);
      stack.push(child);
    }
  }
  return pids;
}

function getListeningPortsByPid() {
  const now = Date.now();
  if (now - lastPortScanAt < PORT_SCAN_INTERVAL_MS) return cachedListeningPortsByPid;
  lastPortScanAt = now;
  const byPid = new Map();

  let raw = "";
  try {
    raw = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FnP"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: "pipe",
    });
  } catch (e) {
    cachedListeningPortsByPid = byPid;
    return byPid;
  }

  let currentPid = null;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (line[0] !== "n" || !currentPid) continue;
    const match = line.match(/:(\d+)(?:\s|\(|$)/);
    if (!match) continue;
    const port = Number(match[1]);
    if (!isPreviewPort(port)) continue;
    if (!byPid.has(currentPid)) byPid.set(currentPid, new Set());
    byPid.get(currentPid).add(port);
  }

  cachedListeningPortsByPid = byPid;
  return byPid;
}

function addPendingPort(id, port) {
  if (!isPreviewPort(port)) return;
  if (!isExplicitlyAllowedPreviewPort(port) && isRecentlyIgnoredPreviewPort(port)) return;
  if (!detectedPorts.has(id)) detectedPorts.set(id, new Set());
  if (!pendingPorts.has(id)) pendingPorts.set(id, new Set());
  const portSet = detectedPorts.get(id);
  if (portSet.has(port)) return;
  pendingPorts.get(id).add(port);
}

function scanWorkerListeningPorts(id) {
  const w = workers.get(id);
  if (!ENABLE_PREVIEW || !ENABLE_PREVIEW_PORT_SCAN || !w) return;

  const panePid = Number(tmux(`display-message -t ${w.sessionName} -p "#{pane_pid}"`).trim());
  const workerPids = collectDescendantPids(panePid);
  if (!workerPids.size) return;

  const listeningPorts = getListeningPortsByPid();
  for (const pid of workerPids) {
    for (const port of listeningPorts.get(pid) || []) {
      addPendingPort(id, port);
    }
  }
}

function extractPortsFromOutput(output) {
  const ports = new Set();
  for (const line of output.split("\n")) {
    if (PREVIEW_IGNORE_OUTPUT_PATTERN.test(line)) continue;
    for (const pattern of PORT_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const port = Number(match[1]);
        if (isPreviewPort(port)) ports.add(port);
      }
    }
  }
  return ports;
}

// 포트 감지됐지만 아직 리스닝 확인 안 된 포트 (워커별)
const pendingPorts = new Map(); // id → Set<port>
const previewHealthFailures = new Map(); // "workerId:port" → consecutive failure count

async function isCloudflaredPort(port) {
  const out = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return /\bcloudflar(?:ed)?\b/i.test(out);
}

// 비동기 검사 중인 포트 — 다음 폴링에서 같은 포트를 중복 처리하지 않도록
const portChecksInFlight = new Set();

function portCameFromIgnoredLine(output, index) {
  const lineStart = output.lastIndexOf("\n", index) + 1;
  const nextBreak = output.indexOf("\n", index);
  const lineEnd = nextBreak === -1 ? output.length : nextBreak;
  const line = output.slice(lineStart, lineEnd);
  return /\bcloudflared\b/i.test(line) || /trycloudflare\.com/i.test(line);
}

function detectPorts(id, output) {
  if (!ENABLE_PREVIEW) return;
  const outputPorts = extractPortsFromOutput(output);
  scanWorkerListeningPorts(id);
  if (!outputPorts.size && (!pendingPorts.has(id) || !pendingPorts.get(id).size)) return;

  if (!detectedPorts.has(id)) detectedPorts.set(id, new Set());
  if (!pendingPorts.has(id)) pendingPorts.set(id, new Set());
  const portSet = detectedPorts.get(id);
  const pending = pendingPorts.get(id);

  // 새로 감지된 포트를 pending에 추가
  for (const port of outputPorts) {
    addPendingPort(id, port);
  }

  // pending 포트들의 리스닝 여부 확인
  for (const port of [...pending]) {
    pending.delete(port);
    const flightKey = `${id}:${port}`;
    if (portChecksInFlight.has(flightKey)) continue;
    portChecksInFlight.add(flightKey);
    checkPortListening(port).then(async (listening) => {
      if (!listening) {
        pending.add(port);
        return;
      }
      if (portSet.has(port)) return;
      if (await isCloudflaredPort(port)) return;
      if (!isExplicitlyAllowedPreviewPort(port) && await isIgnoredPreviewPortOwner(port)) {
        rememberIgnoredPreviewPort(port);
        return;
      }
      if (portSet.has(port)) return;
      portSet.add(port);
      previewHealthFailures.delete(`${id}:${port}`);

      // 다른 워커에서 이미 감지·브로드캐스트된 포트면 중복 전송하지 않음
      for (const [wid, pset] of detectedPorts) {
        if (wid !== id && pset.has(port)) return;
      }

      // Content-Type 체크: HTML이면 자동 미리보기, 아니면 사용자 선택
      checkContentType(port).then((ct) => {
        if (ct === "html") {
          broadcast({ type: "preview_detected", workerId: id, port });
          if (PREVIEW_TUNNEL) startPreviewTunnel(port);
        } else {
          // HTML이 아니면 사용자가 "미리보기"를 눌렀을 때(/api/preview/open) 터널을 연다
          broadcast({ type: "preview_prompt", workerId: id, port, contentType: ct });
        }
      });
    }).finally(() => portChecksInFlight.delete(flightKey));
  }
}

function stopPreviewTunnelIfUnused(port) {
  for (const portSet of detectedPorts.values()) {
    if (portSet.has(port)) return;
  }
  const tunnel = previewTunnels.get(port);
  if (tunnel) {
    tunnel.process.kill();
    previewTunnels.delete(port);
  }
}

function closeDetectedPreview(workerId, port) {
  const portSet = detectedPorts.get(workerId);
  if (portSet) {
    portSet.delete(port);
    if (!portSet.size) detectedPorts.delete(workerId);
  }
  const pending = pendingPorts.get(workerId);
  if (pending) {
    pending.delete(port);
    if (!pending.size) pendingPorts.delete(workerId);
  }
  previewHealthFailures.delete(`${workerId}:${port}`);
  stopPreviewTunnelIfUnused(port);
  broadcast({ type: "preview_closed", workerId, port });
}

function checkPreviewPorts() {
  if (!ENABLE_PREVIEW) return;
  for (const [workerId, portSet] of detectedPorts) {
    for (const port of [...portSet]) {
      checkPortListening(port).then((listening) => {
        const key = `${workerId}:${port}`;
        if (listening) {
          previewHealthFailures.delete(key);
          return;
        }
        const failures = (previewHealthFailures.get(key) || 0) + 1;
        if (failures >= PREVIEW_CLOSE_FAILURES) {
          closeDetectedPreview(workerId, port);
        } else {
          previewHealthFailures.set(key, failures);
        }
      });
    }
  }
}

function startPolling(id) {
  const w = workers.get(id);
  if (!w) return;
  if (w.pollTimer) clearInterval(w.pollTimer);
  w.pollTimer = setInterval(() => pollOutput(id), 1000);
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 템플릿/스폰 요청의 env 객체를 검증해 {KEY: value} 로 정리. 잘못된 키는 버린다.
function sanitizeEnv(env) {
  const out = {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return out;
  for (const [key, value] of Object.entries(env).slice(0, 20)) {
    if (!ENV_KEY_PATTERN.test(key)) continue;
    out[key] = String(value ?? "").slice(0, 1000);
  }
  return out;
}

function getTemplates() {
  const saved = loadState().templates;
  return Array.isArray(saved) ? saved : [];
}

function sanitizeTemplates(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 30).map((t) => ({
    name: String(t?.name || "").trim().slice(0, 60),
    cwd: String(t?.cwd || "").trim().slice(0, 500),
    cmd: String(t?.cmd || "").trim().slice(0, 500),
    env: sanitizeEnv(t?.env),
  })).filter((t) => t.name && t.cwd);
}

// zsh는 초기화 중 입력 큐를 비우므로 프롬프트가 준비되기 전에 보낸 글자는 앞부분이 잘린다
// ("claude" → "laude"). 화면이 그려진 것만으로는 부족하다(p10k instant prompt는 초기화 전에 먼저 그린다).
// 빈 Enter를 보내 프롬프트 줄이 실제로 하나 늘어나는지(입력이 처리되는지) 확인한 뒤 명령을 보낸다.
function promptLineCount(sessionName) {
  return tmux(`capture-pane -t ${sessionName} -p`).split("\n").filter((l) => l.trim() !== "").length;
}

function sendCommandWhenShellReady(sessionName, cmd, attempt = 0) {
  const before = promptLineCount(sessionName);
  tmuxExec(["send-keys", "-t", sessionName, "Enter"]);
  setTimeout(() => {
    const accepted = before > 0 && promptLineCount(sessionName) > before;
    if (accepted || attempt >= 25) {
      tmuxExec(["send-keys", "-t", sessionName, "-l", "--", cmd]);
      tmuxExec(["send-keys", "-t", sessionName, "Enter"]);
      return;
    }
    sendCommandWhenShellReady(sessionName, cmd, attempt + 1);
  }, 200);
}

// 첫 프롬프트는 실행 인자로 넘긴다 — 띄운 뒤 입력창에 보내면 TUI가 뜨기 전에 도착해 일부가 사라질 수 있다.
// 개행·따옴표가 들어 있어도 한 인자로 넘어가도록 $'...'(zsh·bash) 인용을 쓴다.
const PROMPT_ARG_COMMANDS = new Set(["claude", "codex"]);
function supportsInitialPrompt(cmd) {
  return PROMPT_ARG_COMMANDS.has(path.basename(getBaseCommand(cmd)));
}

function withInitialPrompt(cmd, prompt) {
  const quoted = String(prompt)
    .replace(/\r/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return `${cmd} $'${quoted}'`;
}

// opts.id: 재시작 복원 시 기존 탭 번호를 그대로 쓴다(탭 순서·핀·제목이 id 기준이라 바뀌면 전부 어긋난다)
function spawnWorker(cwd, cmd, env, opts = {}) {
  const config = loadConfig();
  cmd = cmd || config.defaultCommand || "claude";
  const id = opts.id ? String(opts.id) : String(nextId++);
  if (Number(id) >= nextId) nextId = Number(id) + 1;
  const sessionName = "term-" + id;
  const cleanEnv = sanitizeEnv(env);
  const envArgs = Object.entries(cleanEnv).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  tmuxExec(["new-session", "-d", "-s", sessionName, "-c", cwd, "-e", "CLAUDECODE=", ...envArgs]);
  // 저장·재개용 cmd에는 프롬프트를 넣지 않는다 — 넣으면 재부팅 후 resume 때 같은 지시를 다시 보낸다
  sendCommandWhenShellReady(sessionName, opts.prompt ? withInitialPrompt(cmd, opts.prompt) : cmd);
  if (!opts.keepTitle) setSessionTitle(sessionName, "");
  const title = opts.keepTitle ? getSessionTitle(sessionName) : "";
  const logs = [];
  workers.set(id, {
    sessionName,
    cwd,
    cmd,
    env: cleanEnv,
    logs,
    status: "running",
    expectedCmd: getBaseCommand(cmd),
    seenExpectedCmd: false,
    exitReason: null,
    lastPaneCommand: null,
    lastAction: null,
    title,
    startedAt: Date.now(),
    claudeSessionId: opts.claudeSessionId || null,
    claudeName: null,
  });
  startPolling(id);
  persistWorker(id);
  broadcast({ type: "spawned", id, cwd, cmd, status: "running", sessionName, title, startedAt: Date.now(), claudeName: null });
  return id;
}

function detectWaiting(output) {
  // 패널 하단의 빈 줄은 무시 — 키 큰 패널에서 프롬프트가 위쪽에 있어도 잡히도록
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const recent = lines.slice(-10).join("\n");
  // Common permission/decision patterns across AI CLIs
  if (/Esc to cancel/.test(recent)) return true;
  if (/Do you want to proceed\?/.test(recent)) return true;
  if (/❯\s*\d+\.\s*(Yes|No)/.test(recent)) return true;
  if (/Allow/.test(recent) && /\?/.test(recent)) return true;
  if (/\([Yy]\/[Nn]\)/.test(recent) || /\[[Yy]\/[Nn]\]/.test(recent) || /\[[yY]\/[nN]\]/.test(recent)) return true;
  if (/approve|confirm|accept/i.test(recent) && /\?/.test(recent)) return true;
  return false;
}

function sendIssueAlert({ key, title, description, color = 0xf0ad4e, fields = [] }) {
  if (!ALERT_WEBHOOK) return;
  const now = Date.now();
  const lastTime = issueAlertTime.get(key) || 0;
  if (now - lastTime < ISSUE_ALERT_COOLDOWN_MS) return;
  issueAlertTime.set(key, now);

  const embed = {
    embeds: [{
      title,
      description,
      color,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };

  fetch(ALERT_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(embed),
  }).catch((err) => {
    console.error("Discord alert failed:", err.message);
  });
}

// ── Web Push ──
// web-push가 설치되지 않은 환경에서도 서버는 떠야 하므로 선택적 로드
let webpush = null;
try {
  webpush = require("web-push");
} catch (e) {
  console.warn("🔕 web-push not installed — push notifications disabled (run npm install)");
}
const PUSH_CONTACT = process.env.PUSH_CONTACT || "mailto:admin@localhost";
const PUSH_COOLDOWN_MS = Number(process.env.PUSH_COOLDOWN_MS || 60000);
const PUSH_MAX_SUBSCRIPTIONS = 20;
const pushAlertTime = new Map(); // "workerId:kind" → timestamp (대기·완료 쿨다운을 따로 둬 완료 직후의 대기 알림이 묻히지 않게)
// 이보다 짧게 일한 뒤 멈춘 건 알리지 않는다 — 짧은 답변마다 폰이 울리지 않도록
const DONE_PUSH_MIN_MS = Number(process.env.DONE_PUSH_MIN_MS || 20000);
// 그 워커를 띄워 둔 기기에서 이 시간 안에 조작이 있었으면 사용자가 보고 있다고 보고 알리지 않는다
const PRESENCE_WINDOW_MS = 120000;

function initPush() {
  if (!webpush) return;
  const state = loadState();
  if (!state.vapid) {
    state.vapid = webpush.generateVAPIDKeys();
    saveState(state);
    console.log("🔔 Generated VAPID keys for Web Push");
  }
  webpush.setVapidDetails(PUSH_CONTACT, state.vapid.publicKey, state.vapid.privateKey);
}

function getPushPublicKey() {
  return loadState().vapid?.publicKey || null;
}

function addPushSubscription(subscription) {
  const state = loadState();
  const list = (state.pushSubscriptions || []).filter((s) => s.endpoint !== subscription.endpoint);
  list.push(subscription);
  state.pushSubscriptions = list.slice(-PUSH_MAX_SUBSCRIPTIONS);
  saveState(state);
  return state.pushSubscriptions.length;
}

function removePushSubscription(endpoint) {
  const state = loadState();
  state.pushSubscriptions = (state.pushSubscriptions || []).filter((s) => s.endpoint !== endpoint);
  saveState(state);
}

function sendPushToAll(payload) {
  if (!webpush) return;
  const subs = loadState().pushSubscriptions || [];
  const body = JSON.stringify(payload);
  for (const sub of subs) {
    webpush.sendNotification(sub, body, { TTL: 600 }).catch((err) => {
      // 404/410: 구독이 만료되었거나 사용자가 해제함 → 목록에서 제거
      if (err.statusCode === 404 || err.statusCode === 410) {
        removePushSubscription(sub.endpoint);
      } else {
        console.error("Push failed:", err.statusCode || "", err.message);
      }
    });
  }
}

function waitingQuestion(w) {
  const lines = (w.logs || []).slice(-10).map((l) => l.text.trim()).filter(Boolean);
  const question = [...lines].reverse().find((l) => /\?/.test(l) && !/^[❯›>\d]/.test(l));
  return (question || "입력/승인이 필요합니다.").slice(0, 120);
}

function isWatched(id) {
  if (!wss) return false;
  const now = Date.now();
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.viewing || !c.viewing.has(String(id))) continue;
    if (c.lastPresence && now - c.lastPresence < PRESENCE_WINDOW_MS) return true;
  }
  return false;
}

function workerPush(id, kind, suffix, body) {
  const w = workers.get(id);
  if (!w || !webpush || isWatched(id)) return;
  const key = `${id}:${kind}`;
  const now = Date.now();
  if (now - (pushAlertTime.get(key) || 0) < PUSH_COOLDOWN_MS) return;
  pushAlertTime.set(key, now);
  const label = w.title || w.claudeName || `${w.cmd || "claude"} · ${path.basename(w.cwd || "")}`;
  sendPushToAll({
    title: `#${id} ${label} — ${suffix}`,
    body,
    // 같은 워커의 알림은 tag가 같아 이전 것을 대체한다
    tag: `worker-${id}`,
    data: { workerId: id, url: `/?focus=${encodeURIComponent(id)}` },
  });
}

function sendWaitingPush(id) {
  const w = workers.get(id);
  if (!w) return;
  workerPush(id, "waiting", "대기 중", waitingQuestion(w));
}

function sendDonePush(id) {
  const w = workers.get(id);
  if (!w) return;
  workerPush(id, "done", "완료", w.task || "작업이 끝났습니다.");
}

function sendWaitingAlert(id) {
  const w = workers.get(id);
  if (!w) return;
  sendWaitingPush(id);

  // 쿨다운은 sendIssueAlert의 ISSUE_ALERT_COOLDOWN_MS(120초)에서 일괄 관리
  sendIssueAlert({
    key: `worker-waiting-${id}`,
    title: `⏳ Waiting — Worker #${id}`,
    description: "Worker requires user action/approval.",
    color: 0xf0ad4e,
    fields: [
      { name: "Issue", value: "AI session is waiting for input/approval.", inline: false },
      { name: "Command", value: w.cmd || "unknown", inline: true },
      { name: "Directory", value: w.cwd || "unknown", inline: true },
      { name: "Session", value: w.sessionName || "unknown", inline: true },
    ],
  });
}

const IDLE_THRESHOLD = 5000; // 5 seconds of no output change → idle

// ── 워커별 git 브랜치·변경 파일 수 ──
// 여러 세션이 같은 저장소를 건드리는지 탭에서 바로 보이게 한다. 같은 폴더의 워커끼리는 한 번만 조회하고,
// 폴링 루프(execSync)를 막지 않도록 비동기로 돌린다.
const GIT_INFO_INTERVAL_MS = 15000;
const gitInfoInFlight = new Set();

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function readGitInfo(cwd) {
  const branch = await execFileText("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return null;
  const status = await execFileText("git", ["-C", cwd, "status", "--porcelain"]);
  return {
    branch: branch.trim(),
    changes: status === null ? null : status.split("\n").filter(Boolean).length,
  };
}

// ── 커밋 (Diff 패널) ──
const COMMIT_MESSAGE_TIMEOUT_MS = 90000;
const COMMIT_DIFF_MAX_CHARS = 60000;
const COMMIT_MESSAGE_MAX_CHARS = 10000;
const COMMIT_MESSAGE_MODEL = process.env.COMMIT_MESSAGE_MODEL || "haiku";
const commitMessageInFlight = new Set();

// --porcelain -z는 경로를 따옴표·8진수 이스케이프 없이 그대로 준다(한글 파일명). 이름 변경·복사는 "새 경로\0옛 경로" 두 칸이다
function parsePorcelainZ(text) {
  const tokens = text.split("\0");
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.length < 4) continue;
    const xy = tok.slice(0, 2);
    const entry = { xy, path: tok.slice(3), oldPath: null };
    if (xy.includes("R") || xy.includes("C")) entry.oldPath = tokens[++i] || null;
    entries.push(entry);
  }
  return entries;
}

function porcelainStatusLetter(xy) {
  if (xy === "??") return "A";
  if (xy.includes("D")) return "D";
  if (xy.includes("A")) return "A";
  if (xy.includes("R")) return "R";
  return "M";
}

function gitRun(cwd, args, opts = {}) {
  // 파일 이름이 ':'로 시작해도 pathspec 매직으로 읽지 않게 한다
  return new Promise(resolve => {
    execFile("git", ["--literal-pathspecs", "-C", cwd, ...args], { encoding: "utf8", timeout: opts.timeout || 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout: stdout || "", stderr: stderr || (err && !stderr ? err.message : "") });
    });
  });
}

// 요청한 파일 중 지금 실제로 바뀐 것만 고른다 — 브라우저 목록이 오래됐거나 엉뚱한 경로가 와도 그 밖은 건드리지 않는다
async function selectChangedEntries(cwd, files) {
  const status = await gitRun(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (!status.ok) return { error: status.stderr.trim() || "not a git repo" };
  const wanted = new Set((Array.isArray(files) ? files : []).map(String));
  const entries = parsePorcelainZ(status.stdout).filter(e => wanted.has(e.path));
  if (!entries.length) return { error: "선택한 파일에 커밋할 변경이 없어요." };
  return { entries };
}

async function buildCommitDiff(cwd, entries) {
  const tracked = entries.filter(e => e.xy !== "??");
  const untracked = entries.filter(e => e.xy === "??");
  let diff = "";
  if (tracked.length) {
    const paths = tracked.flatMap(e => e.oldPath ? [e.path, e.oldPath] : [e.path]);
    const head = await gitRun(cwd, ["diff", "--no-color", "HEAD", "--", ...paths]);
    // 첫 커밋 전(HEAD 없음)이면 스테이징·워킹트리 기준으로 본다
    diff += head.ok ? head.stdout : (await gitRun(cwd, ["diff", "--no-color", "--", ...paths])).stdout;
  }
  for (const e of untracked) {
    if (diff.length > COMMIT_DIFF_MAX_CHARS) break;
    // 차이가 있으면 종료 코드 1이라 ok가 false여도 stdout을 쓴다
    diff += (await gitRun(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", e.path])).stdout;
  }
  if (diff.length > COMMIT_DIFF_MAX_CHARS) diff = diff.slice(0, COMMIT_DIFF_MAX_CHARS) + "\n[diff truncated]\n";
  return diff;
}

// 터미널에서 쓰는 claude CLI로 메시지를 만든다 — 로그인된 구독을 그대로 쓰므로 API 키가 필요 없다.
// 저장소 밖(임시 폴더)에서 user 설정 없이 돌려 프로젝트 훅·MCP 서버·도구가 끼어들지 않게 한다
function generateCommitMessage(diff, recentSubjects) {
  const prompt = [
    "Write a git commit message for the diff on stdin.",
    "Use Conventional Commits (feat:, fix:, refactor:, docs:, chore:). Subject line under 72 characters, then a blank line and a short body only if it helps.",
    "Match the language and tone of these recent commit subjects:",
    recentSubjects || "(no commits yet)",
    "Do not mention Claude, Anthropic or AI. Do not add trailers such as Co-Authored-By. Output only the message, no code fences.",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", "--model", COMMIT_MESSAGE_MODEL, "--setting-sources", "local", "--tools", "",
      "--strict-mcp-config", "--no-session-persistence", prompt,
    ], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let errText = "";
    const timer = setTimeout(() => proc.kill("SIGTERM"), COMMIT_MESSAGE_TIMEOUT_MS);
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { errText += d; });
    proc.on("error", e => { clearTimeout(timer); reject(e); });
    proc.on("close", code => {
      clearTimeout(timer);
      const message = out.trim().replace(/^```[a-z]*\n?|\n?```$/g, "").trim();
      if (code === 0 && message) resolve(message);
      else reject(new Error((errText || out).trim() || `claude exited with ${code}`));
    });
    proc.stdin.on("error", e => console.error(`⚠️  commit message stdin: ${e.message}`));
    proc.stdin.end(diff);
  });
}

// ── 사용량: 워커별 토큰·추정 비용·컨텍스트, 계정 한도 ──
// Orca(stablyai/orca, MIT)와 같은 방식이다.
// - Claude: 대화 기록(~/.claude/projects/*/<세션>.jsonl)의 assistant 행 usage를 합산하고, 한도는 OAuth 사용량 API로 조회한다.
// - Codex: 기록(~/.codex/sessions/**/rollout-*.jsonl)의 token_count 이벤트에 누적 토큰·컨텍스트 창·한도가 함께 들어 있다.
// 비용은 "API로 썼다면" 기준의 추정치다(구독 요금제에서는 실제 청구액이 아니다). 단가는 Orca 단가표를 옮겼다.
const USAGE_SCAN_MS = 10000;
const CODEX_FILE_LIST_MS = 30000;
const CLAUDE_LIMITS_POLL_MS = 15 * 60 * 1000;
const CLAUDE_LIMITS_MIN_REFETCH_MS = 5 * 60 * 1000;
const CLAUDE_LIMITS_TIMEOUT_MS = 10000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const CODEX_LONG_CONTEXT_TOKENS = 272000;
const CODEX_LIMITS_TAIL_BYTES = 512 * 1024;

// USD / 1M tokens. cacheWrite는 5분 캐시, cacheWrite1h는 1시간 캐시 쓰기 단가
const CLAUDE_PRICING = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, cacheWrite1h: 16 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, cacheWrite1h: 4 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, longContext: { thresholdTokens: 200000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12 } },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, longContext: { thresholdTokens: 200000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5, cacheWrite1h: 12 } },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2, longContext: { thresholdTokens: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625, cacheWrite1h: 1 } },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
};
// 1M 컨텍스트가 기본이 아닌(200K) 모델
const CLAUDE_200K_CONTEXT = new Set(["claude-haiku-4-5", "claude-haiku-3-5", "claude-sonnet-4-5", "claude-sonnet-4", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4"]);

const CODEX_PRICING = {
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.1-codex-max": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-pro": { input: 21, cachedInput: 21, output: 168 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.3": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.3-codex-spark": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.4-pro": { input: 30, cachedInput: 30, output: 180, longContext: { input: 60, cachedInput: 60, output: 270 } },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15, longContext: { input: 5, cachedInput: 0.5, output: 22.5 } },
  "gpt-5.5-pro": { input: 30, cachedInput: 30, output: 180, longContext: { input: 60, cachedInput: 60, output: 270 } },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30, longContext: { input: 10, cachedInput: 1, output: 45 } },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20, longContext: { input: 8, cachedInput: 0.8, output: 30 } },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12, longContext: { input: 4, cachedInput: 0.4, output: 18 } },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2, longContext: { input: 0.4, cachedInput: 0.04, output: 1.8 } },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50, longContext: { input: 20, cachedInput: 2, output: 75 } },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10, longContext: { input: 4, cachedInput: 0.4, output: 15 } },
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10, longContext: { input: 4, cachedInput: 0.2, output: 15 } },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5, longContext: { input: 0.2, cachedInput: 0.02, output: 0.75 } },
};
const CODEX_PRICING_KEYS = Object.keys(CODEX_PRICING).sort((a, b) => b.length - a.length);
const CODEX_REASONING_SUFFIXES = ["minimal", "low", "medium", "high", "xhigh", "auto", "none"];

// claude-opus-5-5-20260401, claude-3-5-sonnet-20241022, opus[1m] 같은 ID를 단가표 키로 맞춘다
function claudeModelKey(model) {
  if (!model) return null;
  const lower = String(model).toLowerCase().replace(/\./g, "-");
  const familyFirst = /(?:^|[^a-z])(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2})(?![0-9a-z]))?(?![0-9])/.exec(lower);
  const versionFirst = /(?:^|[^0-9a-z])(\d{1,2})(?:-(\d{1,2}))?-(fable|mythos|opus|sonnet|haiku)(?![a-z])/.exec(lower);
  let key = null;
  if (familyFirst) key = `claude-${familyFirst[1]}-${familyFirst[2]}${familyFirst[3] !== undefined ? "-" + familyFirst[3] : ""}`;
  else if (versionFirst) key = `claude-${versionFirst[3]}-${versionFirst[1]}${versionFirst[2] !== undefined ? "-" + versionFirst[2] : ""}`;
  return key && CLAUDE_PRICING[key] ? key : null;
}

function claudeTurnCost(model, t) {
  const key = claudeModelKey(model);
  if (!key) return null;
  const pricing = CLAUDE_PRICING[key];
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  // 긴 컨텍스트 할증은 그 요청 전체에 붙는다
  const r = pricing.longContext && prompt > pricing.longContext.thresholdTokens ? pricing.longContext : pricing;
  const write1h = Math.min(t.write1h, t.cacheWrite);
  return (t.input * r.input + t.output * r.output + t.cacheRead * r.cacheRead + (t.cacheWrite - write1h) * r.cacheWrite + write1h * r.cacheWrite1h) / 1e6;
}

function codexModelKey(model) {
  if (!model) return null;
  let m = String(model).toLowerCase().trim().replace(/\((minimal|low|medium|high|xhigh|auto|none|max|ultra)\)$/, "");
  for (let i = 0; i < 4; i++) {
    const suffix = CODEX_REASONING_SUFFIXES.find(s => m.endsWith("-" + s));
    if (!suffix) break;
    m = m.slice(0, -suffix.length - 1);
  }
  if (m === "gpt-5-codex") return "gpt-5";
  return CODEX_PRICING_KEYS.find(k => m === k || m.startsWith(k + "-")) || null;
}

function codexTurnCost(model, input, cached, output, longContext) {
  const key = codexModelKey(model);
  if (!key) return null;
  const pricing = CODEX_PRICING[key];
  const r = longContext && pricing.longContext ? pricing.longContext : pricing;
  // 캐시된 입력은 input에 포함돼 있다 — 빼고 캐시 단가로 따로 매긴다
  const c = Math.min(Math.max(cached, 0), Math.max(input, 0));
  return ((Math.max(input - c, 0)) * r.input + c * r.cachedInput + Math.max(output, 0) * r.output) / 1e6;
}

// 기록 파일을 앞에서부터 한 번 읽고, 이후에는 늘어난 부분만 읽는다
const usageScans = new Map();

async function readAppendedLines(file) {
  let scan = usageScans.get(file);
  const st = await fs.promises.stat(file);
  if (!scan || st.size < scan.offset) {
    scan = { offset: 0, rest: "", state: null };
    usageScans.set(file, scan);
  }
  if (st.size === scan.offset) return { scan, lines: [] };
  const fh = await fs.promises.open(file, "r");
  try {
    const length = st.size - scan.offset;
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, scan.offset);
    scan.offset = st.size;
    const text = scan.rest + buf.toString("utf8");
    const lines = text.split("\n");
    scan.rest = lines.pop();
    return { scan, lines };
  } finally {
    await fh.close();
  }
}

function claudeTranscriptPath(sessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch (e) { return null; }
  for (const d of dirs) {
    const p = path.join(projectsDir, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function scanClaudeUsage(file) {
  const { scan, lines } = await readAppendedLines(file);
  if (!scan.state) scan.state = { turns: new Map(), last: null };
  const st = scan.state;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    const m = d && d.type === "assistant" && d.message;
    const u = m && m.usage;
    if (!u || m.model === "<synthetic>") continue;
    const t = {
      model: m.model || null,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      write1h: (u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens) || 0,
    };
    if (!t.input && !t.output && !t.cacheRead && !t.cacheWrite) continue;
    // 스트리밍 중 같은 응답이 여러 행으로 남는다 — 뒤 행일수록 값이 완전하므로 항목별 최댓값을 쓴다
    const key = m.id && d.requestId ? `${m.id}:${d.requestId}` : (m.id ? `msg:${m.id}` : `uuid:${d.uuid}`);
    const prev = st.turns.get(key);
    const merged = prev ? {
      model: t.model || prev.model,
      input: Math.max(prev.input, t.input), output: Math.max(prev.output, t.output),
      cacheRead: Math.max(prev.cacheRead, t.cacheRead), cacheWrite: Math.max(prev.cacheWrite, t.cacheWrite),
      write1h: Math.max(prev.write1h, t.write1h),
    } : t;
    st.turns.set(key, merged);
    st.last = merged;
  }
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0, priced = false;
  for (const t of st.turns.values()) {
    input += t.input; output += t.output; cacheRead += t.cacheRead; cacheWrite += t.cacheWrite;
    const c = claudeTurnCost(t.model, t);
    if (c !== null) { cost += c; priced = true; }
  }
  const last = st.last;
  const key = last ? claudeModelKey(last.model) : null;
  const ctxTokens = last ? last.input + last.cacheRead + last.cacheWrite + last.output : 0;
  const ctxWindow = key && CLAUDE_200K_CONTEXT.has(key) ? 200000 : 1000000;
  return {
    provider: "claude",
    model: last ? last.model : null,
    tokens: input + output + cacheRead + cacheWrite,
    input, output, cacheRead, cacheWrite,
    costUsd: priced ? cost : null,
    ctxTokens,
    ctxWindow,
    ctxPercent: last ? Math.min(100, Math.round(ctxTokens / ctxWindow * 100)) : null,
  };
}

// Codex 기록 파일 목록과 첫 줄(session_meta: cwd)을 캐시한다
let codexFiles = { at: 0, list: [] };
const codexMetaCwd = new Map();

async function listCodexRollouts() {
  if (Date.now() - codexFiles.at < CODEX_FILE_LIST_MS) return codexFiles.list;
  const out = [];
  const walk = async (dir, depth) => {
    let entries = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) await walk(p, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  await walk(CODEX_SESSIONS_DIR, 0);
  codexFiles = { at: Date.now(), list: out };
  return out;
}

async function codexRolloutCwd(file) {
  if (codexMetaCwd.has(file)) return codexMetaCwd.get(file);
  let cwd = null;
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const first = buf.toString("utf8", 0, bytesRead).split("\n")[0];
    try { cwd = JSON.parse(first).payload.cwd || null; } catch (e) { cwd = null; }
  } finally {
    await fh.close();
  }
  codexMetaCwd.set(file, cwd);
  return cwd;
}

// TUI가 아니라 app-server 데몬이 기록을 쓰므로 프로세스로는 파일을 찾을 수 없다 —
// 워커가 시작된 뒤 갱신됐고 같은 폴더에서 시작된 기록 중 가장 최근 것을 그 워커의 세션으로 본다
async function findCodexRollout(w) {
  const since = (w.startedAt || 0) - 60000;
  let best = null;
  for (const file of await listCodexRollouts()) {
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { continue; }
    if (st.mtimeMs < since || (best && st.mtimeMs <= best.mtime)) continue;
    if (await codexRolloutCwd(file) !== w.cwd) continue;
    best = { file, mtime: st.mtimeMs };
  }
  return best ? best.file : null;
}

const CODEX_PROCESS_CHECK_MS = 60000;

// codex는 node 래퍼로 떠서 pane 명령이 "node"로 보이고, tmux에서 복구된 워커는 저장된 명령도 믿을 수 없다 —
// pane 아래 프로세스 중에 codex 실행 파일이 있는지 본다 (1분 캐시)
function isCodexWorker(w) {
  const base = getBaseCommand(w.cmd || w.expectedCmd);
  if (base === "codex" || base.endsWith("/codex")) return true;
  if (w.codexCheck && Date.now() - w.codexCheck.at < CODEX_PROCESS_CHECK_MS) return w.codexCheck.value;
  let value = false;
  const panePid = tmuxExec(["display-message", "-p", "-t", w.sessionName, "#{pane_pid}"]).trim();
  const pids = [...collectDescendantPids(panePid)];
  if (pids.length) {
    let comms = "";
    try {
      comms = execFileSync("ps", ["-o", "comm=", "-p", pids.join(",")], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      comms = e.stdout || "";
    }
    value = comms.split("\n").some(c => path.basename(c.trim()) === "codex");
  }
  w.codexCheck = { at: Date.now(), value };
  return value;
}

async function scanCodexUsage(file) {
  const { scan, lines } = await readAppendedLines(file);
  if (!scan.state) scan.state = { model: null, prevTotal: null, cost: 0, priced: false, total: null, last: null, window: null };
  const st = scan.state;
  for (const line of lines) {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    const p = d && d.payload;
    if (!p) continue;
    if (d.type === "turn_context" && p.model) { st.model = p.model; continue; }
    if (p.type !== "token_count" || !p.info || !p.info.total_token_usage) continue;
    const total = p.info.total_token_usage;
    const last = p.info.last_token_usage || null;
    // 누적값의 증가분이 이번 요청 몫이다 (같은 값이 반복 기록되면 증가분 0)
    const prev = st.prevTotal || { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    const dIn = Math.max(0, (total.input_tokens || 0) - (prev.input_tokens || 0));
    const dCached = Math.max(0, (total.cached_input_tokens || 0) - (prev.cached_input_tokens || 0));
    const dOut = Math.max(0, (total.output_tokens || 0) - (prev.output_tokens || 0));
    if (dIn || dOut) {
      const long = !!(last && last.input_tokens > CODEX_LONG_CONTEXT_TOKENS);
      const c = codexTurnCost(st.model, dIn, dCached, dOut, long);
      if (c !== null) { st.cost += c; st.priced = true; }
    }
    st.prevTotal = total;
    st.total = total;
    st.last = last;
    if (p.info.model_context_window) st.window = p.info.model_context_window;
  }
  const total = st.total || {};
  const ctxTokens = st.last ? (st.last.input_tokens || 0) : 0;
  return {
    provider: "codex",
    model: st.model,
    tokens: total.total_tokens || ((total.input_tokens || 0) + (total.output_tokens || 0)),
    input: total.input_tokens || 0,
    output: total.output_tokens || 0,
    cacheRead: total.cached_input_tokens || 0,
    cacheWrite: 0,
    costUsd: st.priced ? st.cost : null,
    ctxTokens,
    ctxWindow: st.window,
    ctxPercent: st.window && st.last ? Math.min(100, Math.round(ctxTokens / st.window * 100)) : null,
  };
}

let usageScanInFlight = false;
async function refreshWorkerUsage() {
  if (usageScanInFlight) return;
  usageScanInFlight = true;
  try {
    for (const [id, w] of workers) {
      if (w.status !== "running") continue;
      let usage = null;
      try {
        if (w.claudeSessionId) {
          if (!w.usageFile || w.usageFileFor !== w.claudeSessionId) {
            w.usageFile = claudeTranscriptPath(w.claudeSessionId);
            w.usageFileFor = w.claudeSessionId;
          }
          if (w.usageFile) usage = await scanClaudeUsage(w.usageFile);
        } else if (isCodexWorker(w)) {
          const file = await findCodexRollout(w);
          if (file) usage = await scanCodexUsage(file);
        }
      } catch (e) {
        console.error(`⚠️  Usage scan for #${id} failed: ${e.message}`);
        continue;
      }
      if (!usage) continue;
      const key = JSON.stringify(usage);
      if (key === w.usageKey) continue;
      w.usageKey = key;
      w.usage = usage;
      broadcast({ type: "usage", id, usage });
    }
  } finally {
    usageScanInFlight = false;
  }
}

// ── 계정 한도 ──
let accountLimits = { claude: null, codex: null };
let claudeLimitsState = { fetchedAt: 0, retryAt: 0, inFlight: false };

function readClaudeOAuthToken() {
  // 키체인(서비스 "Claude Code-credentials", 계정 = 로그인 사용자) → 없으면 ~/.claude/.credentials.json
  const account = /^[a-zA-Z0-9._-]+$/.test(os.userInfo().username) ? os.userInfo().username : "claude-code-user";
  let raw = null;
  try {
    raw = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-a", account, "-w"], { encoding: "utf8", stdio: "pipe", timeout: 5000 });
  } catch (e) {
    const file = path.join(os.homedir(), ".claude", ".credentials.json");
    if (fs.existsSync(file)) raw = fs.readFileSync(file, "utf8");
  }
  if (!raw) return null;
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    return oauth && oauth.accessToken ? oauth.accessToken : null;
  } catch (e) {
    console.error(`⚠️  Claude credentials are not JSON: ${e.message}`);
    return null;
  }
}

function usageResetMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value > 1e10 ? value : value * 1000;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function claudeLimitWindow(win) {
  if (!win) return null;
  const pct = typeof win.utilization === "number" ? win.utilization : (typeof win.used_percentage === "number" ? win.used_percentage : null);
  if (pct === null) return null;
  return { percent: Math.max(0, Math.min(100, Math.round(pct))), resetsAt: usageResetMs(win.resets_at) };
}

async function fetchClaudeLimits() {
  const st = claudeLimitsState;
  if (st.inFlight || Date.now() < st.retryAt) return;
  st.inFlight = true;
  st.fetchedAt = Date.now();
  try {
    const token = readClaudeOAuthToken();
    if (!token) {
      accountLimits.claude = { error: "Claude 로그인 정보를 찾지 못했어요." };
      return;
    }
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0" },
      signal: AbortSignal.timeout(CLAUDE_LIMITS_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || CLAUDE_LIMITS_POLL_MS / 1000;
      st.retryAt = Date.now() + wait * 1000;
      console.error(`⚠️  Claude usage API rate-limited, retrying in ${wait}s`);
      return;
    }
    if (res.status === 401 || res.status === 403) {
      // 토큰은 Claude CLI가 실행될 때 갱신된다 — 여기서 갱신하지 않는다
      accountLimits.claude = { error: "로그인 토큰이 만료됐어요. Claude를 한 번 실행하면 갱신돼요." };
      return;
    }
    if (!res.ok) {
      console.error(`⚠️  Claude usage API returned ${res.status}`);
      return;
    }
    const data = await res.json();
    const scoped = (Array.isArray(data.limits) ? data.limits : [])
      .filter(l => l && l.kind === "weekly_scoped" && typeof l.percent === "number")
      .map(l => ({ label: (l.scope && l.scope.model && l.scope.model.display_name) || "model", percent: Math.round(l.percent), resetsAt: usageResetMs(l.resets_at) }));
    accountLimits.claude = {
      session: claudeLimitWindow(data.five_hour),
      weekly: claudeLimitWindow(data.seven_day),
      scoped,
      updatedAt: Date.now(),
    };
  } catch (e) {
    console.error(`⚠️  Claude usage fetch failed: ${e.message}`);
  } finally {
    st.inFlight = false;
    broadcast({ type: "limits", limits: accountLimits });
  }
}

// Codex는 가장 최근 기록 파일 끝부분의 마지막 token_count에 한도가 들어 있다 — API 호출이 필요 없다
async function refreshCodexLimits() {
  let newest = null;
  for (const file of await listCodexRollouts()) {
    let st;
    try { st = await fs.promises.stat(file); } catch (e) { continue; }
    if (!newest || st.mtimeMs > newest.mtime) newest = { file, mtime: st.mtimeMs, size: st.size };
  }
  if (!newest) return;
  const fh = await fs.promises.open(newest.file, "r");
  let text;
  try {
    const start = Math.max(0, newest.size - CODEX_LIMITS_TAIL_BYTES);
    const buf = Buffer.alloc(newest.size - start);
    await fh.read(buf, 0, buf.length, start);
    text = buf.toString("utf8");
  } finally {
    await fh.close();
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    let d;
    try { d = JSON.parse(lines[i]); } catch (e) { continue; }
    const rl = d && d.payload && d.payload.rate_limits;
    if (!rl) continue;
    const win = w => w && typeof w.used_percent === "number"
      ? { percent: Math.round(w.used_percent), windowMinutes: w.window_minutes || null, resetsAt: usageResetMs(w.resets_at) }
      : null;
    const next = { primary: win(rl.primary), secondary: win(rl.secondary), plan: rl.plan_type || null, updatedAt: Date.parse(d.timestamp) || newest.mtime };
    if (JSON.stringify(next) !== JSON.stringify(accountLimits.codex)) {
      accountLimits.codex = next;
      broadcast({ type: "limits", limits: accountLimits });
    }
    return;
  }
}

// 대시보드를 보는 사람이 있을 때만 Claude 한도를 조회한다 (Orca: 15분 주기, 다시 볼 때 5분 넘었으면 갱신)
function maybeFetchClaudeLimits(onConnect) {
  if (!wss || !wss.clients.size) return;
  const age = Date.now() - claudeLimitsState.fetchedAt;
  if (age >= (onConnect ? CLAUDE_LIMITS_MIN_REFETCH_MS : CLAUDE_LIMITS_POLL_MS)) fetchClaudeLimits();
}

function startUsageTracking() {
  const tick = () => {
    refreshWorkerUsage().catch(e => console.error(`⚠️  Usage refresh failed: ${e.message}`));
    refreshCodexLimits().catch(e => console.error(`⚠️  Codex limits refresh failed: ${e.message}`));
    maybeFetchClaudeLimits(false);
  };
  tick();
  setInterval(tick, USAGE_SCAN_MS);
}

function refreshGitInfo() {
  const byCwd = new Map();
  for (const [id, w] of workers) {
    if (w.status !== "running" || !w.cwd) continue;
    if (!byCwd.has(w.cwd)) byCwd.set(w.cwd, []);
    byCwd.get(w.cwd).push(id);
  }
  for (const [cwd, ids] of byCwd) {
    if (gitInfoInFlight.has(cwd)) continue;
    gitInfoInFlight.add(cwd);
    readGitInfo(cwd).then((info) => {
      gitInfoInFlight.delete(cwd);
      for (const id of ids) {
        const w = workers.get(id);
        if (!w || w.cwd !== cwd) continue;
        const prev = w.git || null;
        if (prev === info || (prev && info && prev.branch === info.branch && prev.changes === info.changes)) continue;
        w.git = info;
        broadcast({ type: "git", id, git: info });
      }
    });
  }
}

// Claude Code는 pane 제목을 "<상태 글리프> <작업 요약>"으로 바꾼다(예: "✳ 시리즈 업데이트 확인").
// 글리프는 실제 상태와 어긋나는 경우가 있어(busy인데 ✳) 상태 판정에는 쓰지 않고 요약 문구만 표시용으로 쓴다.
function claudeTaskFromTitle(title) {
  const text = String(title || "").replace(/^[\u2800-\u28FF✳✻✽✶✢·*]+\s*/u, "").trim();
  // Claude가 제목을 바꾸기 전에는 셸이 쓴 실행 명령("claude --resume …")이 남아 있다
  if (!text || text === "Claude Code" || /^(claude|codex)(\s|$)/.test(text)) return "";
  return text.slice(0, 120);
}

// 레지스트리 status는 Claude가 직접 기록하므로 화면으로 추측하는 것보다 정확하다(2.1.322 실측):
// 작업 중 busy, 권한 확인·AskUserQuestion 질문 중 waiting, 끝나거나 Esc로 취소하면 idle.
// 화면 패턴(detectWaiting)은 대화 내용의 "approve …?" 같은 문장에도 걸리므로 레지스트리가 있으면 쓰지 않는다.
const REGISTRY_AI_STATES = { busy: "working", waiting: "waiting", idle: "idle" };
function registryAiState(reg) {
  return (reg && REGISTRY_AI_STATES[reg.status]) || null;
}

function applyAiState(id, w, state) {
  if (!state || state === w.aiState) return;
  const prev = w.aiState;
  const workedMs = prev === "working" && w.aiStateAt ? Date.now() - w.aiStateAt : 0;
  w.aiState = state;
  w.aiStateAt = Date.now();
  broadcast({ type: "aiState", id, state, since: w.aiStateAt });
  if (state === "waiting") sendWaitingAlert(id);
  else if (state === "idle" && workedMs >= DONE_PUSH_MIN_MS) sendDonePush(id);
}

let lastCapture = {};

function applyWorkerSize(id) {
  const w = workers.get(id);
  if (!w || w.status !== "running") return;
  const cols = w.cols || 80;
  const rows = terminalRowsForWorker(w);
  // 매초 2개의 resize 프로세스를 띄우지 않도록 크기가 바뀌었을 때만 적용 (외부 attach 대비 30초마다 재적용)
  const sizeKey = `${cols}x${rows}`;
  if (w.appliedSize === sizeKey && Date.now() - (w.appliedSizeAt || 0) <= 30000) return;
  const changed = w.appliedSize !== sizeKey;
  // 같은 크기 재적용은 TUI가 다시 그리지 않으므로 크기가 실제로 바뀐 때만 기록한다
  if (changed) w.sizeChangedAt = Date.now();
  tmux(`resize-pane -t ${w.sessionName} -x ${cols} -y ${rows}`);
  tmux(`resize-window -t ${w.sessionName} -x ${cols} -y ${rows}`);
  w.appliedSize = sizeKey;
  w.appliedSizeAt = Date.now();
  if (changed) scheduleTermReseed(id);
}

function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;
  if (!isAlive(w.sessionName)) {
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    w.status = 'completed';
    w.aiState = null;
    w.exitReason = w.exitReason || inferExitReason(w, "tmux session ended or was killed externally.");
    persistWorker(id);
    broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
    return;
  }
  // 경로·명령·제목·alternate screen 여부를 한 번에 조회. 제목과 경로에는 '|'가 들어갈 수 있어 구분자로 US(0x1f)를 쓴다.
  // launchd 환경엔 UTF-8 로캘이 없어 tmux가 한글·제어 문자를 '_'로 바꾼다 — -u로 UTF-8 출력을 강제한다
  const [altFlag, currentPaneCmd, paneTitle = "", currentCwd = ""] = tmuxExec([
    "-u", "display-message", "-t", w.sessionName, "-p",
    "#{alternate_on}\x1f#{pane_current_command}\x1f#{pane_title}\x1f#{pane_current_path}",
  ]).replace(/\n$/, "").split("\x1f");
  w.alternateScreen = altFlag === "1";
  applyWorkerSize(id);
  // 제어 클라이언트는 창 크기를 정한(resize-window → window-size manual) 뒤에 붙인다 — 먼저 붙으면 기본 80x24로 창을 줄인다
  if (!termClients.has(id) && Date.now() - (w.termStartAt || 0) > TERM_RESTART_DELAY_MS) {
    w.termStartAt = Date.now();
    startTermClient(id);
  }
  const output = displayOutputForWorker(w, tmux(`capture-pane -t ${w.sessionName} -p -S -500 -J`));

  // 크기가 바뀌면 전체 화면 TUI(codex 등)는 화면을 지우고 다시 그리는데, 그 사이 캡처하면 거의 빈 화면이 잡힌다.
  // 이 프레임을 방송하면 대시보드가 비었다 다시 차며 깜박이므로, 리사이즈 직후 내용이 절반 이하로 줄어든 캡처는 건너뛴다.
  if (w.sizeChangedAt && Date.now() - w.sizeChangedAt < RESIZE_SETTLE_MS && lastCapture[id] !== undefined) {
    const before = countNonBlankLines(lastCapture[id]);
    if (before >= 10 && countNonBlankLines(output) < before / 2) return;
  }

  const task = w.claudeSessionId ? claudeTaskFromTitle(paneTitle) : "";
  if (task !== (w.task || "")) {
    w.task = task;
    broadcast({ type: "task", id, task });
  }

  // Track actual working directory
  if (currentCwd && currentCwd !== w.cwd) {
    w.cwd = currentCwd;
    persistWorker(id);
    broadcast({ type: "cwd", id, cwd: currentCwd });
    setTimeout(refreshGitInfo, 0);
  }
  if (currentPaneCmd) {
    w.lastPaneCommand = currentPaneCmd;
    if (w.expectedCmd && currentPaneCmd === w.expectedCmd) w.seenExpectedCmd = true;
    const switchedToShell = w.seenExpectedCmd && currentPaneCmd !== w.expectedCmd && SHELL_COMMANDS.has(currentPaneCmd);
    if (switchedToShell && w.status !== "completed") {
      if (w.pollTimer) clearInterval(w.pollTimer);
      w.pollTimer = null;
      w.status = "completed";
      w.aiState = null;
      w.exitReason = inferExitReason(w, `Command '${w.expectedCmd}' exited and returned to shell '${currentPaneCmd}'.`);
      persistWorker(id);
      broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
      return;
    }
  }

  const fromRegistry = registryAiState(claudeRegistryEntry(w));

  if (output === lastCapture[id]) {
    // Output unchanged — 대기 중인 포트 재시도
    detectPorts(id, output);
    if (fromRegistry) {
      applyAiState(id, w, fromRegistry);
    } else if (w.aiState !== 'idle' && w.aiState !== 'waiting' && w.lastChangeTime) {
      // 레지스트리가 없는 명령(codex 등)은 출력이 멈춘 시간으로 추측한다
      if (Date.now() - w.lastChangeTime >= IDLE_THRESHOLD) applyAiState(id, w, detectWaiting(output) ? 'waiting' : 'idle');
    }
    return;
  }

  lastCapture[id] = output;
  detectPorts(id, output);
  w.lastChangeTime = Date.now();
  const lines = output.split("\n");
  w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));

  // Output just changed — check for waiting, otherwise working
  applyAiState(id, w, fromRegistry || (detectWaiting(output) ? 'waiting' : 'working'));
}

function sendInput(id, text) {
  const w = workers.get(id);
  if (!w) return false;
  if (w.status === "completed") {
    w.status = "running";
    w.aiState = null;
    w.exitReason = null;
    startPolling(id);
    broadcast({ type: "status", id, status: "running", reason: null });
  }
  // 텍스트와 Enter를 붙여 보내면 바쁜 TUI(Claude Code)가 한 덩어리의 붙여넣기로 읽어
  // Enter를 줄바꿈으로 삼키는 경우가 있다 → 줄마다 잠깐 간격을 두고 Enter를 보낸다
  const lines = text.split("\n");
  const sessionName = w.sessionName;
  let delay = 0;
  for (const line of lines) {
    if (line) {
      setTimeout(() => tmuxExec(["send-keys", "-t", sessionName, "-l", "--", line]), delay);
      delay += INPUT_ENTER_DELAY_MS;
    }
    setTimeout(() => tmuxExec(["send-keys", "-t", sessionName, "Enter"]), delay);
    delay += INPUT_ENTER_DELAY_MS;
  }
  rememberAction(w, "input", "text");
  broadcast({ type: "log", id, src: "stdin", text, ts: Date.now() });
  return true;
}

// 여러 줄을 한 메시지로 보낸다 — sendInput은 줄마다 Enter를 쳐서 Claude가 줄마다 따로 제출한다.
// tmux 버퍼에 올려 bracketed paste(-p)로 붙여넣으면 TUI가 한 덩어리 입력으로 받는다.
function pasteInput(id, text) {
  const w = workers.get(id);
  if (!w || w.status !== "running") return false;
  const buffer = `termhub-paste-${id}`;
  try {
    execFileSync("tmux", ["load-buffer", "-b", buffer, "-"], { input: text, stdio: ["pipe", "pipe", "pipe"] });
    execFileSync("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", w.sessionName], { stdio: "pipe" });
  } catch (e) {
    console.error(`⚠️  Paste to #${id} failed: ${e.message}`);
    return false;
  }
  // 붙여넣기와 Enter를 붙여 보내면 Enter가 붙여넣기 안의 줄바꿈으로 삼켜질 수 있다
  setTimeout(() => tmuxExec(["send-keys", "-t", w.sessionName, "Enter"]), 400);
  rememberAction(w, "input", "paste");
  broadcast({ type: "log", id, src: "stdin", text, ts: Date.now() });
  return true;
}

function killWorker(id, reason) {
  const w = workers.get(id);
  if (!w) return false;
  if (w.pollTimer) clearInterval(w.pollTimer);
  w.pollTimer = null;
  rememberAction(w, "stop_button", "kill-session");
  tmux(`kill-session -t ${w.sessionName}`);
  w.status = 'stopped';
  w.aiState = null;
  w.exitReason = reason || "Stopped from dashboard.";
  persistWorker(id);
  broadcast({ type: "status", id, status: "stopped", reason: w.exitReason });
  return true;
}

let wss;
function broadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === 1 && canReceiveMessage(c.authContext, obj)) c.send(msg);
  });
}

// ── 터미널 스트리밍 (tmux 제어 모드 → xterm.js) ──
// capture-pane 폴링은 1초 늦고 색·커서가 없다. 워커마다 제어 모드 클라이언트(tmux -C)를 붙여
// 앱이 pane에 쓴 바이트(%output)를 그대로 받아, 그 워커를 보고 있는 브라우저로 보낸다.
// 새로 보기 시작한 브라우저에는 같은 제어 연결로 capture-pane을 보내 시작 화면을 만든다 —
// 제어 모드는 명령 응답(%begin…%end)과 출력을 한 줄기로 순서대로 보내므로, 응답 앞의 출력은 캡처에 들어 있고
// 뒤의 출력만 이어 보내면 빠지거나 겹치는 구간이 없다.
const TERM_SEED_HISTORY = 2000;
const TERM_FLUSH_MS = 16;
const TERM_RESTART_DELAY_MS = 5000;
// 리사이즈 직후 TUI가 화면을 다시 그릴 시간을 준 뒤 시작 화면을 다시 보낸다 (xterm.js와 tmux의 줄 재배치 방식이 달라 어긋나므로)
const TERM_RESEED_DELAY_MS = 400;
const TERM_INPUT_MAX_CHARS = 64 * 1024;
const TERM_INPUT_CHUNK_BYTES = 512;
// 시작 화면만으로는 앱이 켜 둔 bracketed paste 모드를 알 수 없다(tmux 포맷에 없음) — 켜는 것으로 알려진 TUI는 켠 상태로 시작한다
const BRACKETED_PASTE_COMMANDS = new Set(["claude", "codex"]);
const termClients = new Map();

// %output 데이터는 0x20 미만 문자와 '\'를 \ooo(8진수)로 이스케이프한다. 나머지 바이트는 그대로 온다.
function decodeControlOutput(line, start) {
  const out = Buffer.allocUnsafe(line.length - start);
  let n = 0;
  for (let i = start; i < line.length; i++) {
    if (line[i] === 0x5c && i + 3 < line.length) {
      const a = line[i + 1] - 0x30, b = line[i + 2] - 0x30, c = line[i + 3] - 0x30;
      if (a >= 0 && a < 8 && b >= 0 && b < 8 && c >= 0 && c < 8) {
        out[n++] = a * 64 + b * 8 + c;
        i += 3;
        continue;
      }
    }
    out[n++] = line[i];
  }
  return out.subarray(0, n);
}

function sendCtl(ctl, command, onReply) {
  if (!ctl.proc.stdin.writable) return;
  ctl.replies.push(onReply || null);
  ctl.proc.stdin.write(command + "\n");
}

function startTermClient(id) {
  const w = workers.get(id);
  if (!w) return;
  const proc = spawn("tmux", ["-u", "-C", "attach-session", "-t", w.sessionName], { stdio: ["pipe", "pipe", "pipe"] });
  // replies[0]은 attach 명령 자체의 %begin/%end 응답 자리다
  const ctl = { proc, replies: [null], block: null, rest: null, out: [], flushTimer: null, live: new Set(), waiting: new Set(), seedQueued: false, reseedTimer: null };
  termClients.set(id, ctl);
  proc.stdout.on("data", chunk => onCtlData(id, ctl, chunk));
  proc.stderr.on("data", d => console.error(`⚠️  tmux control #${id}: ${d.toString().trim()}`));
  proc.stdin.on("error", e => console.error(`⚠️  tmux control #${id} stdin: ${e.message}`));
  proc.on("error", e => console.error(`⚠️  tmux control #${id} failed: ${e.message}`));
  proc.on("exit", () => {
    flushTermOutput(id, ctl);
    clearTimeout(ctl.reseedTimer);
    if (termClients.get(id) === ctl) termClients.delete(id);
  });
  // 서버 재시작 직후처럼 제어 연결보다 먼저 보고 있던 브라우저도 붙인다
  if (wss) wss.clients.forEach(c => {
    if (c.readyState === 1 && c.viewing && c.viewing.has(id)) ctl.waiting.add(c);
  });
  if (ctl.waiting.size) requestTermSeed(id, ctl);
}

function onCtlData(id, ctl, chunk) {
  const data = ctl.rest ? Buffer.concat([ctl.rest, chunk]) : chunk;
  let pos = 0;
  let nl;
  while ((nl = data.indexOf(0x0a, pos)) !== -1) {
    onCtlLine(id, ctl, data.subarray(pos, nl));
    pos = nl + 1;
  }
  ctl.rest = pos < data.length ? Buffer.from(data.subarray(pos)) : null;
}

function startsWith(buf, prefix) {
  return buf.length >= prefix.length && buf.toString("latin1", 0, prefix.length) === prefix;
}

function onCtlLine(id, ctl, line) {
  if (ctl.block) {
    if (startsWith(line, "%end ") || startsWith(line, "%error ")) {
      const lines = ctl.block;
      ctl.block = null;
      const onReply = ctl.replies.shift();
      if (onReply) onReply(lines, startsWith(line, "%error "));
    } else {
      ctl.block.push(Buffer.from(line));
    }
    return;
  }
  if (startsWith(line, "%begin ")) {
    ctl.block = [];
  } else if (startsWith(line, "%output ")) {
    // %output %<pane> <data>
    const sp = line.indexOf(0x20, 8);
    if (sp === -1) return;
    ctl.out.push(decodeControlOutput(line, sp + 1));
    if (!ctl.flushTimer) ctl.flushTimer = setTimeout(() => flushTermOutput(id, ctl), TERM_FLUSH_MS);
  }
}

function flushTermOutput(id, ctl) {
  clearTimeout(ctl.flushTimer);
  ctl.flushTimer = null;
  if (!ctl.out.length) return;
  const buf = Buffer.concat(ctl.out);
  ctl.out = [];
  if (!ctl.live.size) return;
  const msg = JSON.stringify({ type: "out", id, d: buf.toString("base64") });
  ctl.live.forEach(c => {
    if (c.readyState === 1) c.send(msg);
    else ctl.live.delete(c);
  });
}

function requestTermSeed(id, ctl) {
  const w = workers.get(id);
  if (!w || ctl.seedQueued) return;
  ctl.seedQueued = true;
  let info = null;
  sendCtl(ctl, `display-message -p -t ${w.sessionName} '#{cursor_x},#{cursor_y},#{cursor_flag},#{alternate_on},#{pane_width},#{pane_height}'`, lines => {
    info = lines[0] ? lines[0].toString("latin1") : null;
  });
  sendCtl(ctl, `capture-pane -p -e -t ${w.sessionName} -S -${TERM_SEED_HISTORY}`, (lines, failed) => {
    ctl.seedQueued = false;
    // 응답 앞의 출력은 캡처에 들어 있다 — 이미 보고 있던 브라우저에 먼저 보내고 나서 시작 화면을 보낸다
    flushTermOutput(id, ctl);
    if (failed || !info) {
      console.error(`⚠️  Terminal seed for #${id} failed`);
      return;
    }
    const [cx, cy, cursorOn, alt, cols, rows] = info.split(",");
    const rowCount = Number(rows) || lines.length;
    const screen = alt === "1" ? lines.slice(-rowCount) : lines;
    const parts = [];
    if (alt === "1") parts.push(Buffer.from("\x1b[?1049h\x1b[H"));
    screen.forEach((l, i) => {
      if (i) parts.push(Buffer.from("\r\n"));
      parts.push(l);
    });
    let tail = `\x1b[0m\x1b[${Number(cy) + 1};${Number(cx) + 1}H`;
    if (cursorOn === "0") tail += "\x1b[?25l";
    if (BRACKETED_PASTE_COMMANDS.has(isClaudeWorker(w) ? "claude" : w.expectedCmd)) tail += "\x1b[?2004h";
    parts.push(Buffer.from(tail));
    const msg = JSON.stringify({ type: "term", id, cols: Number(cols), rows: rowCount, d: Buffer.concat(parts).toString("base64") });
    ctl.waiting.forEach(c => {
      if (c.readyState !== 1) return;
      c.send(msg);
      ctl.live.add(c);
    });
    ctl.waiting.clear();
  });
}

function scheduleTermReseed(id) {
  const ctl = termClients.get(id);
  if (!ctl) return;
  clearTimeout(ctl.reseedTimer);
  ctl.reseedTimer = setTimeout(() => {
    // 다시 보낼 때까지의 출력은 새 시작 화면에 들어가므로 보고 있던 브라우저를 대기열로 옮긴다
    ctl.live.forEach(c => ctl.waiting.add(c));
    ctl.live.clear();
    if (ctl.waiting.size) requestTermSeed(id, ctl);
  }, TERM_RESEED_DELAY_MS);
}

function attachTermViewer(ws, id) {
  const w = workers.get(id);
  if (!w) return;
  const ctl = termClients.get(id);
  if (ctl) {
    ctl.waiting.add(ws);
    requestTermSeed(id, ctl);
    return;
  }
  // 세션이 끝난(제어 연결이 없는) 워커는 마지막 캡처를 글자 그대로 보여 준다
  const text = lastCapture[id] !== undefined ? lastCapture[id] : (w.logs || []).map(l => l.text).join("\n");
  const lines = text.split("\n");
  ws.send(JSON.stringify({
    type: "term", id, cols: w.cols || 80, rows: w.rows || 50,
    d: Buffer.from(lines.join("\r\n") + "\x1b[?25l").toString("base64"),
  }));
}

function detachTermViewer(ws, id) {
  const ctl = termClients.get(id);
  if (!ctl) return;
  ctl.live.delete(ws);
  ctl.waiting.delete(ws);
}

// 키 입력은 바이트 그대로 보낸다(send-keys -H) — 방향키·Ctrl 조합·한글이 브라우저에서 만든 그대로 앱에 간다
function sendTermInput(id, data) {
  const w = workers.get(id);
  if (!w) return;
  const bytes = Buffer.from(data, "utf8");
  const ctl = termClients.get(id);
  for (let i = 0; i < bytes.length; i += TERM_INPUT_CHUNK_BYTES) {
    const hex = Array.from(bytes.subarray(i, i + TERM_INPUT_CHUNK_BYTES), b => b.toString(16).padStart(2, "0"));
    if (ctl) sendCtl(ctl, `send-keys -t ${w.sessionName} -H ${hex.join(" ")}`);
    else tmuxExec(["send-keys", "-t", w.sessionName, "-H", ...hex]);
  }
  rememberAction(w, "input", "terminal");
}

function readBody(req) {
  return new Promise(res => {
    let buf = "";
    req.on("data", c => (buf += c));
    req.on("end", () => res(buf));
  });
}

// 바이너리 본문을 상한까지만 읽는다 — 상한을 넘으면 연결을 끊어 메모리에 쌓이지 않게 한다
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeUploadName(name) {
  const base = path.basename(String(name || ""))
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^[._]+/, "")
    .slice(0, 80);
  return base || "file";
}

function saveUpload(workerId, name, buf) {
  const dir = path.join(UPLOAD_DIR, String(workerId));
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // 파일명에 로컬 시각을 넣어 목록에서 언제 올린 건지 바로 보이게 한다
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeName = sanitizeUploadName(name);
  let file = path.join(dir, `${stamp}-${safeName}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stamp}-${n}-${safeName}`);
  fs.writeFileSync(file, buf);
  return file;
}

function cleanupUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return;
  const cutoff = Date.now() - UPLOAD_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const sub of fs.readdirSync(UPLOAD_DIR)) {
    const dir = path.join(UPLOAD_DIR, sub);
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of entries) {
      const file = path.join(dir, f);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (e) {
        console.error(`⚠️  Failed to clean upload ${file}: ${e.message}`);
      }
    }
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (e) { /* 다른 업로드가 동시에 들어오면 비어 있지 않을 수 있다 */ }
  }
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const cookie = req.headers.cookie || "";
  const out = {};
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function parseWorkerScopeCookie(req) {
  const raw = parseCookies(req).worker_scope;
  if (!raw) return null;
  const [workerId, token] = raw.split(".");
  if (!workerId || !token || !workers.has(workerId)) return null;
  if (!safeEqual(token, workerScopeToken(workerId))) return null;
  return workerId;
}

function requestedWorkerScope(req) {
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    return params.get("worker") || params.get("scope") || params.get("worker_scope");
  } catch {
    return null;
  }
}

function authContext(req) {
  const cookies = parseCookies(req);
  const scopedWorkerId = parseWorkerScopeCookie(req);
  const requestedScope = requestedWorkerScope(req);
  if (requestedScope && scopedWorkerId && requestedScope === scopedWorkerId) {
    return { kind: "worker", workerId: scopedWorkerId };
  }

  if (safeEqual(cookies.token || "", expectedToken())) {
    return { kind: "full" };
  }

  if (scopedWorkerId) {
    return { kind: "worker", workerId: scopedWorkerId };
  }

  return null;
}

function auth(req) {
  return !!authContext(req);
}

function isFullAuth(req) {
  return authContext(req)?.kind === "full";
}

function workerSummary(id, w) {
  return {
    id,
    cwd: w.cwd,
    cmd: w.cmd || "claude",
    status: (w.status === "completed" || w.status === "stopped") ? w.status : (isAlive(w.sessionName) ? "running" : (w.status || "stopped")),
    sessionName: w.sessionName,
    title: w.title || getSessionTitle(w.sessionName),
    claudeSessionId: w.claudeSessionId || null,
    claudeName: w.claudeName || null,
    logs: w.logs,
    aiState: w.aiState || null,
    aiStateAt: w.aiStateAt || null,
    task: w.task || "",
    git: w.git || null,
    usage: w.usage || null,
    exitReason: w.exitReason || null,
    startedAt: w.startedAt || null,
    lastOutputAt: w.lastChangeTime || null
  };
}

function scopedUrlFor(req, workerId) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  const token = workerScopeToken(workerId);
  return `${proto}://${host}/?worker=${encodeURIComponent(workerId)}&token=${encodeURIComponent(token)}`;
}

function withPathname(rawUrl, pathname) {
  try {
    const url = new URL(rawUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function canReceiveMessage(ctx, obj) {
  if (!ctx) return false;
  if (ctx.kind === "full") return true;

  const workerId = String(ctx.workerId);
  if (obj.id && String(obj.id) !== workerId) return false;
  if (obj.workerId && String(obj.workerId) !== workerId) return false;
  if (obj.type === "preview_tunnel") {
    return detectedPorts.get(workerId)?.has(Number(obj.port)) || false;
  }
  return ["spawned", "log", "status", "cwd", "aiState", "task", "git", "usage", "title", "presets", "preview_detected", "preview_prompt", "preview_closed"].includes(obj.type);
}

function canAccessWorker(ctx, workerId) {
  if (!ctx) return false;
  if (ctx.kind === "full") return true;
  return String(ctx.workerId) === String(workerId);
}

// 워커 크기의 주인은 하나의 소켓이다. 주인이 없으면 처음 크기를 보낸 소켓이 주인이 되고,
// 'active'(입력)로만 주인이 바뀐다. 여러 기기가 서로 크기를 덮어써서 TUI가 계속 다시 그리는 것을 막는다.
// 주인이 끊긴 뒤(잠자기·재연결) 폭이 다른 기기가 접속만 해도 크기를 가져가면 Codex 같은 전체 화면 TUI가
// 500줄을 처음부터 다시 그려 깜박인다 — 이미 크기가 잡힌 워커는 같은 크기(같은 기기의 재연결)일 때만
// 접속으로 주인이 되고, 다른 크기는 그 기기에서 실제로 입력('active')해야 넘어간다.
function setWorkerSize(workerId, size, owner) {
  const w = workers.get(String(workerId));
  if (!w) return;
  const currentOwner = workerResizeOwners.get(String(workerId));
  if (currentOwner && currentOwner !== owner) return;
  if (!currentOwner) {
    const hasSize = w.cols && w.rows;
    const sameSize = w.cols === size.cols && w.rows === size.rows;
    if (hasSize && !sameSize) return;
    workerResizeOwners.set(String(workerId), owner);
  }
  w.cols = size.cols;
  w.rows = size.rows;
}

function claimWorkerSize(workerId, size, owner) {
  workerResizeOwners.set(String(workerId), owner);
  if (size) setWorkerSize(workerId, size, owner);
}

function setAllUnownedWorkerSizes(size, owner) {
  workers.forEach((_, workerId) => {
    const currentOwner = workerResizeOwners.get(workerId);
    if (currentOwner && currentOwner !== owner) return;
    setWorkerSize(workerId, size, owner);
  });
}

function releaseResizeOwnership(owner) {
  for (const [workerId, currentOwner] of workerResizeOwners) {
    if (currentOwner === owner) workerResizeOwners.delete(workerId);
  }
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const parsedUrl = new URL(req.url, "http://localhost");
  const url = parsedUrl.pathname;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (method === "GET" && url === "/healthz") {
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/login") {
    const body = JSON.parse(await readBody(req));
    if (body.pw === PASSWORD) {
      const token = expectedToken();
      const cookie = `token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
      res.writeHead(200, { "Set-Cookie": cookie, "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    return json(res, 401, { ok: false });
  }

  if (method === "GET" && url === "/") {
    const scopedWorkerId = parsedUrl.searchParams.get("worker");
    const scopedToken = parsedUrl.searchParams.get("token") || parsedUrl.searchParams.get("access");
    if (scopedWorkerId && scopedToken) {
      if (!workers.has(scopedWorkerId) || !safeEqual(scopedToken, workerScopeToken(scopedWorkerId))) {
        return json(res, 401, { error: "unauthorized" });
      }
      const cookieValue = encodeURIComponent(`${scopedWorkerId}.${scopedToken}`);
      const cookie = `worker_scope=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`;
      res.writeHead(302, { "Set-Cookie": cookie, "Location": `/?worker=${encodeURIComponent(scopedWorkerId)}` });
      return res.end();
    }

    const html = fs.readFileSync(path.join(__dirname, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  const MIME = { ".css": "text/css", ".js": "application/javascript", ".json": "application/json", ".png": "image/png" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    if (filePath.startsWith(path.join(__dirname, "public")) && fs.existsSync(filePath)) {
      const headers = { "Content-Type": ext === ".png" ? MIME[ext] : MIME[ext] + "; charset=utf-8" };
      // 서비스 워커는 루트 스코프 허용 + 항상 최신 버전 사용
      if (url === "/sw.js") { headers["Service-Worker-Allowed"] = "/"; headers["Cache-Control"] = "no-cache"; }
      res.writeHead(200, headers);
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (method === "GET" && url === "/api/config") {
    const ctx = authContext(req);
    if (!ctx) return json(res, 401, { error: "unauthorized" });
    if (ctx.kind === "worker") return json(res, 200, { scopedWorkerId: ctx.workerId });
    const configPath = path.join(__dirname, "config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    return json(res, 200, config);
  }

  const ctx = authContext(req);
  if (!ctx) return json(res, 401, { error: "unauthorized" });

  if (method === "GET" && url === "/api/workers") {
    const list = ctx.kind === "worker"
      ? (workers.has(ctx.workerId) ? [workerSummary(ctx.workerId, workers.get(ctx.workerId))] : [])
      : [...workers.entries()].map(([id, w]) => workerSummary(id, w));
    return json(res, 200, list);
  }

  if (method === "GET" && url === "/api/scan") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const raw = tmux("ls -F '#{session_name}|#{pane_current_path}'");
    const existingNames = new Set([...workers.values()].map(w => w.sessionName));
    const found = [];
    for (const line of raw.trim().split("\n")) {
      if (!line) continue;
      const [sessionName, cwd] = line.split("|");
      if (existingNames.has(sessionName)) continue;
      found.push({ sessionName, cwd: cwd || "unknown" });
    }
    return json(res, 200, found);
  }

  if (method === "POST" && url === "/api/attach") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { sessionName, cwd } = JSON.parse(await readBody(req));
    const id = String(nextId++);
    workers.set(id, {
      sessionName,
      cwd,
      logs: [],
      status: "running",
      exitReason: null,
      expectedCmd: "",
      seenExpectedCmd: false,
      lastPaneCommand: null,
      lastAction: null,
      title: getSessionTitle(sessionName),
      startedAt: sessionCreatedAt(sessionName),
      claudeSessionId: null,
      claudeName: null,
    });
    startPolling(id);
    persistWorker(id);
    broadcast({ type: "spawned", id, cwd, status: "running", sessionName, title: getSessionTitle(sessionName), startedAt: workers.get(id).startedAt, claudeName: null });
    return json(res, 200, { id });
  }

  if (method === "POST" && url === "/api/spawn") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const body = JSON.parse(await readBody(req));
    const rawCwd = body.cwd || process.cwd();
    const resolvedCwd = path.resolve(rawCwd);
    try {
      const stat = fs.statSync(resolvedCwd);
      if (!stat.isDirectory()) {
        return json(res, 400, { ok: false, error: "Invalid path: not a directory." });
      }
    } catch (e) {
      return json(res, 400, { ok: false, error: "Invalid path: does not exist or not accessible." });
    }
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 8000) : "";
    if (prompt && !supportsInitialPrompt(body.cmd || loadConfig().defaultCommand || "claude")) {
      return json(res, 400, { ok: false, error: "First prompt works only with claude or codex." });
    }
    const id = spawnWorker(resolvedCwd, body.cmd, body.env, { prompt });
    return json(res, 200, { ok: true, id });
  }

  if (method === "GET" && url === "/api/templates") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    return json(res, 200, { templates: getTemplates() });
  }

  if (method === "POST" && url === "/api/templates") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const body = JSON.parse(await readBody(req));
    const cleaned = sanitizeTemplates(body.templates);
    if (!cleaned) return json(res, 400, { ok: false, error: "templates must be an array" });
    const state = loadState();
    state.templates = cleaned;
    saveState(state);
    broadcast({ type: "templates", templates: cleaned });
    return json(res, 200, { ok: true, templates: cleaned });
  }

  if (method === "POST" && url === "/api/title") {
    const { id, title } = JSON.parse(await readBody(req));
    if (!canAccessWorker(ctx, id)) return json(res, 403, { ok: false, error: "forbidden" });
    const w = workers.get(String(id));
    if (!w) return json(res, 404, { ok: false });
    w.title = setSessionTitle(w.sessionName, title);
    broadcast({ type: "title", id: String(id), title: w.title });
    return json(res, 200, { ok: true, title: w.title });
  }

  if (method === "POST" && url === "/api/input") {
    const { id, text, mode } = JSON.parse(await readBody(req));
    if (!canAccessWorker(ctx, id)) return json(res, 403, { ok: false, error: "forbidden" });
    const ok = mode === "paste" ? pasteInput(id, String(text || "")) : sendInput(id, text);
    return json(res, 200, { ok });
  }

  // 본문은 파일 바이트 그대로, 파일명은 헤더로 — multipart 파서 없이 처리
  if (method === "POST" && url === "/api/upload") {
    const id = parsedUrl.searchParams.get("id");
    if (!canAccessWorker(ctx, id)) return json(res, 403, { ok: false, error: "forbidden" });
    if (!workers.has(String(id))) return json(res, 404, { ok: false, error: "no such worker" });
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > UPLOAD_MAX_BYTES) return json(res, 413, { ok: false, error: `file exceeds ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` });
    let buf;
    try {
      buf = await readRawBody(req, UPLOAD_MAX_BYTES);
    } catch (e) {
      return json(res, 413, { ok: false, error: `file exceeds ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` });
    }
    if (!buf.length) return json(res, 400, { ok: false, error: "empty file" });
    let name = "file";
    try { name = decodeURIComponent(String(req.headers["x-file-name"] || "")); } catch (e) { /* 잘못된 인코딩이면 기본 이름 사용 */ }
    try {
      const file = saveUpload(id, name, buf);
      return json(res, 200, { ok: true, path: file, name: path.basename(file), size: buf.length });
    } catch (e) {
      console.error(`⚠️  Upload failed: ${e.message}`);
      return json(res, 500, { ok: false, error: "failed to save file" });
    }
  }

  if (method === "POST" && url === "/api/remove") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (w) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      cleanupPreviewPorts(id);
      if (!isAlive(w.sessionName)) setSessionTitle(w.sessionName, "");
      workerResizeOwners.delete(String(id));
      forgetWorkerUiState(id);
      forgetPersistedWorker(id);
      // 워커 관련 alert 쿨다운 키 정리 (issueAlertTime 무한 누적 방지)
      issueAlertTime.delete(`worker-waiting-${id}`);
      pushAlertTime.delete(`${id}:waiting`);
      pushAlertTime.delete(`${id}:done`);
      workers.delete(id);
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/key") {
    const { id, key, keys } = JSON.parse(await readBody(req));
    if (!canAccessWorker(ctx, id)) return json(res, 403, { ok: false, error: "forbidden" });
    const keySequence = Array.isArray(keys) ? keys.map(String).filter(Boolean).slice(0, 30) : null;
    if (keySequence !== null && !keySequence.length) return json(res, 400, { ok: false, error: "empty keys" });
    const w = workers.get(id);
    if (w) {
      if (w.status === "completed") {
        w.status = "running";
        w.aiState = null;
        w.exitReason = null;
        startPolling(id);
        broadcast({ type: "status", id, status: "running", reason: null });
      }
      if (keySequence) {
        rememberAction(w, "special_key", keySequence.join(" "));
        tmuxExec(["send-keys", "-t", w.sessionName, ...keySequence]);
      } else {
        rememberAction(w, "special_key", key);
        tmux(`send-keys -t ${w.sessionName} ${key}`);
      }
    }
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/reconnect") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id } = JSON.parse(await readBody(req));
    const w = workers.get(id);
    if (!w) return json(res, 404, { ok: false });
    if (isAlive(w.sessionName)) {
      if (w.pollTimer) clearInterval(w.pollTimer);
      w.status = "running";
      w.aiState = null;
      w.exitReason = null;
      w.seenExpectedCmd = false;
      startPolling(id);
      persistWorker(id);
      broadcast({ type: "status", id, status: "running", reason: null });
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false });
  }

  if (method === "POST" && url === "/api/git-commit-message") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id, files } = JSON.parse(await readBody(req));
    const w = workers.get(String(id));
    if (!w) return json(res, 404, { error: "worker not found" });
    if (commitMessageInFlight.has(String(id))) return json(res, 409, { error: "이미 메시지를 만들고 있어요." });
    const picked = await selectChangedEntries(w.cwd, files);
    if (picked.error) return json(res, 400, { error: picked.error });
    commitMessageInFlight.add(String(id));
    try {
      const diff = await buildCommitDiff(w.cwd, picked.entries);
      const log = await gitRun(w.cwd, ["log", "-10", "--format=%s"]);
      const message = await generateCommitMessage(diff, log.ok ? log.stdout.trim() : "");
      return json(res, 200, { message });
    } catch (e) {
      console.error(`⚠️  Commit message for #${id} failed: ${e.message}`);
      return json(res, 500, { error: "메시지 생성 실패: " + e.message.slice(0, 300) });
    } finally {
      commitMessageInFlight.delete(String(id));
    }
  }

  if (method === "POST" && url === "/api/git-commit") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id, files, message } = JSON.parse(await readBody(req));
    const w = workers.get(String(id));
    if (!w) return json(res, 404, { error: "worker not found" });
    const text = typeof message === "string" ? message.trim() : "";
    if (!text || text.length > COMMIT_MESSAGE_MAX_CHARS) return json(res, 400, { error: "커밋 메시지를 입력하세요." });
    const picked = await selectChangedEntries(w.cwd, files);
    if (picked.error) return json(res, 400, { error: picked.error });
    const paths = picked.entries.flatMap(e => e.oldPath ? [e.path, e.oldPath] : [e.path]);
    // 경로를 주면 git commit은 그 경로만 커밋한다(--only) — 다른 세션이 스테이징해 둔 파일은 섞이지 않는다
    const add = await gitRun(w.cwd, ["add", "-A", "--", ...paths]);
    if (!add.ok) return json(res, 400, { error: add.stderr.trim() || "git add failed" });
    // pre-commit 훅이 오래 걸릴 수 있어 넉넉히 기다린다
    const commit = await gitRun(w.cwd, ["commit", "-m", text, "--", ...paths], { timeout: 120000 });
    if (!commit.ok) return json(res, 400, { error: (commit.stderr || commit.stdout).trim().slice(0, 2000) || "git commit failed" });
    const head = await gitRun(w.cwd, ["log", "-1", "--format=%h %s"]);
    rememberAction(w, "git_commit", head.stdout.trim());
    setTimeout(refreshGitInfo, 0);
    return json(res, 200, { ok: true, commit: head.stdout.trim() });
  }

  if (method === "GET" && url === "/api/git-diff") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const params = new URL(req.url, 'http://localhost').searchParams;
    const workerId = params.get('id');
    const file = params.get('file');

    const w = workers.get(workerId);
    if (!w) return json(res, 404, { error: 'worker not found' });

    // path traversal 방지
    if (file && file.includes('..')) return json(res, 400, { error: 'invalid file path' });

    const cwd = w.cwd;

    const execOpts = { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: 'pipe' };
    try {
      // git repo 확인
      execFileSync('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], execOpts);

      if (file) {
        // 특정 파일의 diff — HEAD가 있으면 HEAD 대비, 없으면 워킹트리
        // --no-color는 diff 하위 명령의 옵션이다 — git 바로 뒤에 두면 git이 명령 전체를 거부한다
        let diff = '';
        try {
          diff = execFileSync('git', ['-C', cwd, 'diff', '--no-color', 'HEAD', '--', file], execOpts);
        } catch (_) {
          diff = execFileSync('git', ['-C', cwd, 'diff', '--no-color', '--', file], execOpts);
        }
        // 아직 추적되지 않는 새 파일은 위 diff에 나오지 않으므로 빈 파일과 비교한다 (차이가 있으면 종료 코드 1)
        if (!diff && execFileSync('git', ['-C', cwd, 'ls-files', '--others', '--exclude-standard', '--', file], execOpts).trim()) {
          try {
            diff = execFileSync('git', ['-C', cwd, 'diff', '--no-color', '--no-index', '--', '/dev/null', file], execOpts);
          } catch (e) {
            diff = e.stdout || '';
          }
        }
        return json(res, 200, { diff });
      } else {
        // 파일 목록: 커밋 대상과 같은 경로를 쓰도록 -z(이스케이프 없는 원래 경로)로 읽는다. 새 폴더는 안의 파일까지 펼친다
        const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain', '-z', '--untracked-files=all'], execOpts);
        const files = parsePorcelainZ(status).map(e => ({ status: porcelainStatusLetter(e.xy), path: e.path }));

        let stat = '';
        try {
          stat = execFileSync('git', ['-C', cwd, 'diff', '--no-color', '--stat', 'HEAD'], execOpts).trim();
        } catch (_) { /* no HEAD yet */ }

        return json(res, 200, { files, stat });
      }
    } catch (e) {
      return json(res, 200, { files: [], diff: '', stat: '', error: e.message || 'not a git repo' });
    }
  }

  if (method === "GET" && url === "/api/tunnel") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    return json(res, 200, { url: tunnelUrl });
  }

  if (method === "POST" && url === "/api/kill") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id } = JSON.parse(await readBody(req));
    killWorker(id, "Stopped from dashboard (Stop button).");
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/preview/open") {
    const { workerId, port } = JSON.parse(await readBody(req));
    const numericPort = Number(port);
    if (!canAccessWorker(ctx, workerId)) return json(res, 403, { ok: false, error: "forbidden" });
    // 해당 워커에서 감지된 포트만 허용 — 임의 포트를 외부에 노출하지 않도록
    if (!detectedPorts.get(String(workerId))?.has(numericPort)) return json(res, 404, { ok: false, error: "port not detected" });
    if (PREVIEW_TUNNEL) startPreviewTunnel(numericPort);
    return json(res, 200, { ok: true, url: previewTunnels.get(numericPort)?.url || null });
  }

  if (method === "GET" && url === "/api/paths") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    return json(res, 200, getPaths());
  }

  if (method === "POST" && url === "/api/paths") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const body = JSON.parse(await readBody(req));
    const paths = updatePaths(body || {});
    broadcast({ type: "paths", ...paths });
    return json(res, 200, { ok: true, ...paths });
  }

  if (method === "GET" && url === "/api/ui-state") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    return json(res, 200, getUiState());
  }

  if (method === "POST" && url === "/api/ui-state") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const body = JSON.parse(await readBody(req));
    const ui = updateUiState(body || {});
    broadcast({ type: "ui_state", ui });
    return json(res, 200, { ok: true, ui });
  }

  if (method === "GET" && url === "/api/presets") {
    return json(res, 200, { presets: getPresets() });
  }

  if (method === "POST" && url === "/api/presets") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.presets)) return json(res, 400, { ok: false, error: "presets must be an array" });
    const cleaned = [...new Set(body.presets.map((t) => String(t).trim().slice(0, 500)).filter(Boolean))].slice(0, 30);
    const state = loadState();
    state.presets = cleaned;
    saveState(state);
    broadcast({ type: "presets", presets: cleaned });
    return json(res, 200, { ok: true, presets: cleaned });
  }

  if (method === "GET" && url === "/api/push/public-key") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const publicKey = getPushPublicKey();
    return json(res, 200, { enabled: !!(webpush && publicKey), publicKey });
  }

  if (method === "POST" && url === "/api/push/subscribe") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    if (!webpush) return json(res, 503, { ok: false, error: "web-push not installed" });
    const { subscription } = JSON.parse(await readBody(req));
    if (!subscription || typeof subscription.endpoint !== "string" || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return json(res, 400, { ok: false, error: "invalid subscription" });
    }
    const count = addPushSubscription({ endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } });
    return json(res, 200, { ok: true, count });
  }

  if (method === "POST" && url === "/api/push/unsubscribe") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { endpoint } = JSON.parse(await readBody(req));
    if (typeof endpoint === "string") removePushSubscription(endpoint);
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/push/test") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    sendPushToAll({ title: "TermHub", body: "푸시 알림 테스트", tag: "termhub-test", data: { url: "/" } });
    return json(res, 200, { ok: true });
  }

  if (method === "POST" && url === "/api/share-url") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id } = JSON.parse(await readBody(req));
    if (!workers.has(String(id))) return json(res, 404, { error: "worker not found" });
    return json(res, 200, { url: scopedUrlFor(req, String(id)) });
  }

  json(res, 404, { error: "not found" });
});

wss = new WebSocketServer({ server, perMessageDeflate: { threshold: 1024 } });
const clientSizes = new Map();
const WS_PING_INTERVAL_MS = 30000;
// 끊긴 소켓(절전 모드의 폰 등)을 정리 — pong이 없으면 다음 주기에 종료해 클라이언트가 재연결하게 한다
setInterval(() => {
  wss.clients.forEach(c => {
    if (c.isAliveSocket === false) { c.terminate(); return; }
    c.isAliveSocket = false;
    c.ping();
  });
}, WS_PING_INTERVAL_MS);
wss.on('connection', (ws, req) => {
  const ctx = authContext(req);
  if (!ctx) {
    ws.close(1008, "unauthorized");
    return;
  }
  ws.authContext = ctx;
  ws.isAliveSocket = true;
  ws.lastPresence = Date.now();
  ws.on('pong', () => { ws.isAliveSocket = true; });
  // 계정 한도는 전체 접속에만 보낸다 (공유 링크로 들어온 사람에게는 계정 정보가 아니다)
  if (ctx.kind === "full") {
    ws.send(JSON.stringify({ type: "limits", limits: accountLimits }));
    maybeFetchClaudeLimits(true);
  }
  if (ctx.kind === "worker") {
    workerResizeOwners.set(String(ctx.workerId), ws);
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'presence') {
        ws.lastPresence = Date.now();
        return;
      }
      if (msg.type === 'view') {
        ws.lastPresence = Date.now();
        const ids = Array.isArray(msg.ids) ? msg.ids.map(String).filter(id => canAccessWorker(ctx, id)) : [];
        const previous = ws.viewing || new Set();
        ws.viewing = new Set(ids);
        // 새로 보기 시작한 워커는 현재 화면부터 보내고 실시간 출력을 이어 붙인다.
        // 터미널은 pane 크기 그대로 그려져 크기가 다른 기기에서는 잘리므로, 지금 그 탭을 연 기기가 크기의 주인이 된다
        ids.forEach(id => {
          if (previous.has(id)) return;
          claimWorkerSize(id, clientSizes.get(ws), ws);
          applyWorkerSize(id);
          attachTermViewer(ws, id);
        });
        previous.forEach(id => { if (!ws.viewing.has(id)) detachTermViewer(ws, id); });
        return;
      }
      if (msg.type === 'input') {
        const id = String(msg.id);
        if (typeof msg.data !== "string" || !msg.data || msg.data.length > TERM_INPUT_MAX_CHARS) return;
        if (!workers.has(id) || !canAccessWorker(ctx, id)) return;
        ws.lastPresence = Date.now();
        // 터미널에 직접 친 기기가 그 워커 크기의 주인이 된다 ('active'와 같은 규칙)
        const w = workers.get(id);
        // 명령이 끝나 셸로 돌아온(completed) 워커에 다시 입력하면 /api/key·sendInput처럼 감시를 재개한다 — 셸에서 claude를 다시 띄우는 경우
        if (w.status === "completed" && isAlive(w.sessionName)) {
          w.status = "running";
          w.aiState = null;
          w.exitReason = null;
          w.seenExpectedCmd = false;
          startPolling(id);
          broadcast({ type: "status", id, status: "running", reason: null });
        }
        claimWorkerSize(id, clientSizes.get(ws), ws);
        applyWorkerSize(id);
        sendTermInput(id, msg.data);
        return;
      }
      if (msg.type === 'resize') {
        const size = { cols: msg.cols, rows: msg.rows };
        clientSizes.set(ws, size);
        if (msg.id && workers.has(String(msg.id)) && canAccessWorker(ctx, msg.id)) {
          setWorkerSize(msg.id, size, ws);
          applyWorkerSize(String(msg.id));
        } else if (ctx.kind === "full") {
          setAllUnownedWorkerSizes(size, ws);
        } else {
          setWorkerSize(ctx.workerId, size, ws);
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (msg.id && workers.has(String(msg.id)) && canAccessWorker(ctx, msg.id)) {
          // 입력한 기기가 그 워커 크기의 주인이 된다
          claimWorkerSize(msg.id, size, ws);
          applyWorkerSize(String(msg.id));
        } else if (size && ctx.kind === "full") {
          setAllUnownedWorkerSizes(size, ws);
        } else if (size) {
          setWorkerSize(ctx.workerId, size, ws);
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => {
    (ws.viewing || new Set()).forEach(id => detachTermViewer(ws, id));
    clientSizes.delete(ws);
    releaseResizeOwnership(ws);
  });

  // 새 클라이언트에게 기존 미리보기 상태 동기화 (리스닝 중인 포트만, 포트 기준 중복 제거)
  if (ws.readyState === 1) {
    const syncedPorts = new Set();
    detectedPorts.forEach((portSet, workerId) => {
      if (!canAccessWorker(ctx, workerId)) return;
      portSet.forEach(port => {
        if (syncedPorts.has(port)) return;
        syncedPorts.add(port);
        checkPortListening(port).then(listening => {
          if (listening) {
            ws.send(JSON.stringify({ type: "preview_detected", workerId, port }));
          } else {
            portSet.delete(port);
          }
        });
      });
    });
    // 이미 생성된 터널 URL 전송
    previewTunnels.forEach((tunnel, port) => {
      if (ctx.kind !== "full" && !detectedPorts.get(ctx.workerId)?.has(Number(port))) return;
      if (tunnel.url) {
        ws.send(JSON.stringify({ type: "preview_tunnel", port, url: tunnel.url }));
      }
    });
  }
});


function recoverSessions() {
  const raw = tmux("ls -F '#{session_name}|#{pane_current_path}|#{pane_current_command}'");
  if (!raw.trim()) return;
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("|");
    const sessionName = parts[0];
    const cwd = parts[1] || "unknown";
    const cmd = parts[2] || "unknown";
    if (!sessionName.startsWith("term-")) continue;
    const id = sessionName.replace("term-", "");
    const numId = parseInt(id);
    if (isNaN(numId)) continue;
    if (workers.has(id)) continue;
    workers.set(id, {
      sessionName,
      cwd,
      cmd,
      logs: [],
      status: "running",
      expectedCmd: getBaseCommand(cmd),
      seenExpectedCmd: false,
      exitReason: null,
      lastPaneCommand: null,
      lastAction: null,
      title: getSessionTitle(sessionName),
      startedAt: sessionCreatedAt(sessionName),
      claudeSessionId: null,
      claudeName: null,
    });
    startPolling(id);
    if (numId >= nextId) nextId = numId + 1;
  }
  if (workers.size > 0) {
    console.log(`♻️  Recovered ${workers.size} session(s)`);
  }
  restorePersistedWorkers();
}

// tmux 세션이 살아 있으면 저장된 명령·세션 ID만 덧입히고, 죽어 있으면(재부팅 등) 같은 탭 번호로 Claude 세션을 재개한다.
function restorePersistedWorkers() {
  const saved = loadState().workers || {};
  let resumed = 0;
  for (const [id, s] of Object.entries(saved)) {
    if (!/^\d+$/.test(id) || !s) continue;
    const numId = Number(id);
    if (numId >= nextId) nextId = numId + 1;
    const live = workers.get(id);
    if (live) {
      // pane 명령(claude.exe 등)보다 처음 띄울 때 쓴 명령이 정확하다
      if (s.cmd) { live.cmd = s.cmd; live.expectedCmd = getBaseCommand(s.cmd); }
      live.env = s.env || {};
      live.claudeSessionId = s.claudeSessionId || null;
      persistWorker(id);
      continue;
    }
    if (s.status !== "running") { forgetPersistedWorker(id); continue; }
    // tmux 서버가 그대로인데 이 세션만 없다면 서버가 꺼져 있는 동안 사용자가 끄거나 명령이 끝난 것이다 — 되살리지 않는다.
    // (예전 상태 파일처럼 식별자가 없으면 판단할 수 없어 기존대로 되살린다)
    if (s.tmuxServer && s.tmuxServer === tmuxServerId()) {
      console.log(`♻️  #${id}: session ended while TermHub was down, not resuming`);
      forgetPersistedWorker(id);
      continue;
    }
    let blocked = null;
    if (!s.claudeSessionId) blocked = "Server restarted and there was no Claude session to resume.";
    else if (!s.cwd || !fs.existsSync(s.cwd)) blocked = `Server restarted but the folder no longer exists: ${s.cwd}`;
    if (blocked) {
      const sessionName = s.sessionName || `term-${id}`;
      workers.set(id, {
        sessionName,
        cwd: s.cwd || "unknown",
        cmd: s.cmd || "",
        env: s.env || {},
        logs: [],
        status: "completed",
        expectedCmd: getBaseCommand(s.cmd),
        seenExpectedCmd: false,
        exitReason: blocked,
        lastPaneCommand: null,
        lastAction: null,
        title: getSessionTitle(sessionName),
        startedAt: s.startedAt || null,
        claudeSessionId: s.claudeSessionId || null,
        claudeName: s.claudeName || null,
      });
      persistWorker(id);
      continue;
    }
    const resumable = claudeTranscriptExists(s.claudeSessionId);
    if (!resumable) console.log(`♻️  #${id}: no transcript for ${s.claudeSessionId}, starting a fresh Claude instead`);
    spawnWorker(s.cwd, buildResumeCommand(s.cmd, resumable ? s.claudeSessionId : null), s.env, { id, keepTitle: true, claudeSessionId: resumable ? s.claudeSessionId : null });
    resumed++;
  }
  if (resumed > 0) console.log(`♻️  Resumed ${resumed} Claude session(s) from saved state`);
}

function startTunnel() {
  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log("☁️  cloudflared not found — skipping tunnel");
    sendIssueAlert({
      key: "tunnel-cloudflared-missing",
      title: "🚨 Tunnel Unavailable",
      description: "cloudflared is not installed, so external tunnel cannot start.",
      color: 0xe74c3c,
      fields: [{ name: "Issue", value: "cloudflared not found in PATH", inline: false }],
    });
    return;
  }
  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const handleData = (data) => {
    const text = data.toString();
    const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
    const valid = matches.find((m) => m[1] && m[1].toLowerCase() !== "api");
    if (valid) {
      const nextUrl = valid[0];
      if (cachedTunnelUrl === nextUrl) return;
      const changed = cachedTunnelUrl && cachedTunnelUrl !== nextUrl;
      cachedTunnelUrl = nextUrl;
      tunnelUrl = nextUrl;
      tunnelHealthFailures = 0;
      if (changed) {
        console.log(`☁️  Tunnel URL changed → ${tunnelUrl}`);
      } else {
        console.log(`☁️  Tunnel URL → ${tunnelUrl}`);
      }
      broadcast({ type: "tunnel", url: tunnelUrl });
      if (DISCORD_WEBHOOK) {
        fetch(DISCORD_WEBHOOK, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: DISCORD_USERNAME,
            avatar_url: DISCORD_AVATAR_URL,
            content: `☁️ TermHub → ${tunnelUrl}`,
          }),
        }).catch(() => {});
      }
    }
  };
  tunnelProcess.stdout.on("data", handleData);
  tunnelProcess.stderr.on("data", handleData);
  tunnelProcess.on("close", (code) => {
    console.log(`☁️  cloudflared exited (code ${code}), restarting in 5s...`);
    sendIssueAlert({
      key: `tunnel-exit-${code}`,
      title: "⚠️ Tunnel Restarted",
      description: `cloudflared exited with code ${code}. Restarting in 5 seconds.`,
      color: code === 0 ? 0xf39c12 : 0xe67e22,
      fields: [
        { name: "Issue", value: "Tunnel process exited unexpectedly.", inline: false },
        { name: "Exit Code", value: String(code), inline: true },
        { name: "Last URL", value: tunnelUrl || cachedTunnelUrl || "unknown", inline: true },
      ],
    });
    tunnelUrl = null;
    cachedTunnelUrl = null;
    tunnelProcess = null;
    tunnelHealthFailures = 0;
    setTimeout(startTunnel, 5000);
  });
}

function startPreviewTunnel(port) {
  // 이미 해당 포트의 터널이 존재하면 중복 생성 방지
  if (previewTunnels.has(port)) return;

  try {
    execSync("which cloudflared", { stdio: "pipe" });
  } catch {
    console.log(`☁️  cloudflared not found — cannot start preview tunnel for port ${port}`);
    return;
  }

  console.log(`☁️  Starting preview tunnel for port ${port}...`);
  const proc = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // 터널 생성 즉시 Map에 등록 (중복 스폰 방지)
  previewTunnels.set(port, { process: proc, url: null });

  const handleData = (data) => {
    const text = data.toString();
    const matches = [...text.matchAll(/https:\/\/([a-z0-9-]+)\.trycloudflare\.com/gi)];
    const valid = matches.find((m) => m[1] && m[1].toLowerCase() !== "api");
    if (valid) {
      const url = valid[0];
      const entry = previewTunnels.get(port);
      if (entry && entry.url !== url) {
        entry.url = url;
        console.log(`☁️  Preview tunnel port ${port} → ${url}`);
        broadcast({ type: "preview_tunnel", port, url });
      }
    }
  };

  proc.stdout.on("data", handleData);
  proc.stderr.on("data", handleData);
  proc.on("close", () => {
    previewTunnels.delete(port);
  });
}

function cleanupPreviewPorts(workerId) {
  const portSet = detectedPorts.get(workerId);
  if (!portSet) return;

  for (const port of portSet) {
    // 해당 포트를 다른 워커가 사용 중인지 확인
    let usedByOther = false;
    for (const [wid, pset] of detectedPorts) {
      if (wid !== workerId && pset.has(port)) {
        usedByOther = true;
        break;
      }
    }
    if (!usedByOther) {
      const tunnel = previewTunnels.get(port);
      if (tunnel) {
        tunnel.process.kill();
        previewTunnels.delete(port);
      }
    }
  }

  detectedPorts.delete(workerId);
  pendingPorts.delete(workerId);
  for (const key of [...previewHealthFailures.keys()]) {
    if (key.startsWith(`${workerId}:`)) previewHealthFailures.delete(key);
  }
}

function checkTunnel() {
  if (!cachedTunnelUrl || !tunnelProcess) return;
  const healthUrl = withPathname(cachedTunnelUrl, "/healthz");
  fetch(healthUrl, { signal: AbortSignal.timeout(10000), cache: "no-store" })
    .then(r => {
      if (!r.ok) throw new Error(r.status);
      tunnelHealthFailures = 0;
    })
    .catch((err) => {
      tunnelHealthFailures += 1;
      const reason = err?.cause?.code || err?.code || err?.message || String(err);
      console.log(`☁️  Tunnel health check failed (${tunnelHealthFailures}/${TUNNEL_HEALTHCHECK_FAILURE_LIMIT}): ${reason}`);
      if (tunnelHealthFailures >= TUNNEL_HEALTHCHECK_FAILURE_LIMIT) {
        console.log("☁️  Dashboard tunnel health check threshold reached, restarting cloudflared...");
        const processAlive = tunnelProcess && !tunnelProcess.killed && tunnelProcess.exitCode === null;
        const uptimeMin = Math.floor(process.uptime() / 60);
        sendIssueAlert({
          key: "tunnel-healthcheck-threshold",
          title: "🚨 Tunnel Healthcheck Failure",
          description: `${TUNNEL_HEALTHCHECK_FAILURE_LIMIT} consecutive tunnel health checks failed. Restarting cloudflared.`,
          color: 0xe74c3c,
          fields: [
            { name: "Error", value: reason, inline: false },
            { name: "Health URL", value: healthUrl || "unknown", inline: false },
            { name: "cloudflared alive", value: processAlive ? "Yes" : "No", inline: true },
            { name: "Server uptime", value: `${uptimeMin}m`, inline: true },
          ],
        });
        tunnelHealthFailures = 0;
        if (tunnelProcess) tunnelProcess.kill();
      }
    });
}

server.listen(PORT, () => {
  recoverSessions();
  syncClaudeSessions();
  setInterval(syncClaudeSessions, CLAUDE_SESSION_SYNC_MS);
  refreshGitInfo();
  setInterval(refreshGitInfo, GIT_INFO_INTERVAL_MS);
  startUsageTracking();
  initPush();
  cleanupUploads();
  setInterval(cleanupUploads, UPLOAD_CLEANUP_INTERVAL_MS);
  console.log(`✅ TermHub running → http://localhost:${PORT}`);
  console.log(`🔑 Password: ${PASSWORD}`);
  console.log(`📺 View tmux session: tmux attach -t term-1`);
  startTunnel();
  if (ENABLE_TUNNEL_HEALTHCHECK) {
    setInterval(checkTunnel, TUNNEL_HEALTHCHECK_INTERVAL_MS);
  } else {
    console.log("☁️  Tunnel health check disabled (set ENABLE_TUNNEL_HEALTHCHECK=1 to enable)");
  }
  if (ENABLE_PREVIEW) {
    setInterval(checkPreviewPorts, PREVIEW_HEALTH_INTERVAL_MS);
    console.log(`🔎 Preview health check every ${Math.round(PREVIEW_HEALTH_INTERVAL_MS / 60000)}m`);
  }
});

process.on("SIGINT", () => {
  if (tunnelProcess) tunnelProcess.kill();
  previewTunnels.forEach(t => t.process.kill());
  process.exit();
});
process.on("SIGTERM", () => {
  if (tunnelProcess) tunnelProcess.kill();
  previewTunnels.forEach(t => t.process.kill());
  process.exit();
});
