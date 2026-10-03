require("dotenv").config();
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { execSync, execFileSync, spawn } = require("child_process");
const fs = require("fs");
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
const CLAUDE_MIN_ROWS = Math.max(50, Number(process.env.CLAUDE_MIN_ROWS || 500));
const STATE_PATH = path.join(__dirname, ".termhub-state.json");
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

function getBaseCommand(cmd) {
  if (!cmd) return "";
  return String(cmd).trim().split(/\s+/)[0] || "";
}

function terminalRowsForWorker(w) {
  const rows = w.rows || 50;
  const baseCommand = getBaseCommand(w.cmd || w.expectedCmd);
  if (baseCommand === "claude" || baseCommand.endsWith("/claude")) {
    return Math.max(rows, CLAUDE_MIN_ROWS);
  }
  return rows;
}

function isClaudeWorker(w) {
  const baseCommand = getBaseCommand(w?.cmd || w?.expectedCmd);
  return baseCommand === "claude" || baseCommand.endsWith("/claude");
}

function displayOutputForWorker(w, output) {
  if (!isClaudeWorker(w)) return output;
  const lines = output.split("\n");
  while (lines.length > 1 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  return lines.join("\n");
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

function getCommandLine(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch (e) {
    return "";
  }
}

function isIgnoredPreviewPortOwner(port) {
  let raw = "";
  try {
    raw = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: "pipe",
    });
  } catch (e) {
    return false;
  }

  let current = { pid: null, command: "" };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      current = { pid: line.slice(1), command: "" };
      if (PREVIEW_IGNORE_PROCESS_PATTERN.test(getCommandLine(current.pid))) {
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

function isCloudflaredPort(port) {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { encoding: "utf8", stdio: "pipe" });
    return /\bcloudflar(?:ed)?\b/i.test(out);
  } catch (e) {
    return false;
  }
}

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
    checkPortListening(port).then((listening) => {
      if (!listening) {
        pending.add(port);
        return;
      }
      if (portSet.has(port)) return;
      if (isCloudflaredPort(port)) return;
      if (!isExplicitlyAllowedPreviewPort(port) && isIgnoredPreviewPortOwner(port)) {
        rememberIgnoredPreviewPort(port);
        return;
      }
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
        } else {
          broadcast({ type: "preview_prompt", workerId: id, port, contentType: ct });
        }
        if (PREVIEW_TUNNEL) startPreviewTunnel(port);
      });
    });
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

function spawnWorker(cwd, cmd) {
  const config = loadConfig();
  cmd = cmd || config.defaultCommand || "claude";
  const id = String(nextId++);
  const sessionName = "term-" + id;
  tmux(`new-session -d -s ${sessionName} -c "${cwd}" -e CLAUDECODE=`);
  tmux(`send-keys -t ${sessionName} ${JSON.stringify(cmd)} Enter`);
  setSessionTitle(sessionName, "");
  const logs = [];
  workers.set(id, {
    sessionName,
    cwd,
    cmd,
    logs,
    status: "running",
    expectedCmd: getBaseCommand(cmd),
    seenExpectedCmd: false,
    exitReason: null,
    lastPaneCommand: null,
    lastAction: null,
    title: "",
  });
  startPolling(id);
  broadcast({ type: "spawned", id, cwd, cmd, status: "running", sessionName, title: "" });
  return id;
}

function detectWaiting(output) {
  const lines = output.split("\n");
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

function sendWaitingAlert(id) {
  const w = workers.get(id);
  if (!w) return;

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

let lastCapture = {};

function pollOutput(id) {
  const w = workers.get(id);
  if (!w) return;
  if (!isAlive(w.sessionName)) {
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    w.status = 'completed';
    w.aiState = null;
    w.exitReason = w.exitReason || inferExitReason(w, "tmux session ended or was killed externally.");
    broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
    return;
  }
  const cols = w.cols || 80;
  const rows = terminalRowsForWorker(w);
  tmux(`resize-pane -t ${w.sessionName} -x ${cols} -y ${rows}`);
  tmux(`resize-window -t ${w.sessionName} -x ${cols} -y ${rows}`);
  const output = displayOutputForWorker(w, tmux(`capture-pane -t ${w.sessionName} -p -S -500 -J`));

  // Track actual working directory
  const currentCwd = tmux(`display-message -t ${w.sessionName} -p "#{pane_current_path}"`).trim();
  if (currentCwd && currentCwd !== w.cwd) {
    w.cwd = currentCwd;
    broadcast({ type: "cwd", id, cwd: currentCwd });
  }
  const currentPaneCmd = tmux(`display-message -t ${w.sessionName} -p "#{pane_current_command}"`).trim();
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
      broadcast({ type: "status", id, status: "completed", reason: w.exitReason });
      return;
    }
  }

  if (output === lastCapture[id]) {
    // Output unchanged — 대기 중인 포트 재시도
    detectPorts(id, output);
    // check if idle threshold reached
    if (w.aiState !== 'idle' && w.aiState !== 'waiting' && w.lastChangeTime) {
      const elapsed = Date.now() - w.lastChangeTime;
      if (elapsed >= IDLE_THRESHOLD) {
        const waiting = detectWaiting(output);
        const newState = waiting ? 'waiting' : 'idle';
        if (newState !== w.aiState) {
          w.aiState = newState;
          broadcast({ type: "aiState", id, state: newState });
          if (newState === 'waiting') sendWaitingAlert(id);
        }
      }
    }
    return;
  }

  lastCapture[id] = output;
  detectPorts(id, output);
  w.lastChangeTime = Date.now();
  const lines = output.split("\n");
  w.logs = lines.slice(-200).map(text => ({ src: "stdout", text, ts: Date.now() }));
  broadcast({ type: "snapshot", id, lines });

  // Output just changed — check for waiting, otherwise working
  const waiting = detectWaiting(output);
  const aiState = waiting ? 'waiting' : 'working';
  if (aiState !== w.aiState) {
    w.aiState = aiState;
    broadcast({ type: "aiState", id, state: aiState });
    if (aiState === 'waiting') sendWaitingAlert(id);
  }
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
  const lines = text.split("\n");
  for (const line of lines) {
    if (line) tmuxExec(["send-keys", "-t", w.sessionName, "-l", "--", line]);
    tmuxExec(["send-keys", "-t", w.sessionName, "Enter"]);
  }
  rememberAction(w, "input", "text");
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

function readBody(req) {
  return new Promise(res => {
    let buf = "";
    req.on("data", c => (buf += c));
    req.on("end", () => res(buf));
  });
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
    logs: w.logs,
    aiState: w.aiState || null,
    exitReason: w.exitReason || null
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
  return ["spawned", "log", "status", "cwd", "aiState", "snapshot", "title", "preview_detected", "preview_prompt", "preview_closed"].includes(obj.type);
}

function canAccessWorker(ctx, workerId) {
  if (!ctx) return false;
  if (ctx.kind === "full") return true;
  return String(ctx.workerId) === String(workerId);
}

function setWorkerSize(workerId, size, owner) {
  const w = workers.get(String(workerId));
  if (!w) return;
  const currentOwner = workerResizeOwners.get(String(workerId));
  if (currentOwner && currentOwner !== owner) return;
  w.cols = size.cols;
  w.rows = size.rows;
}

function setAllUnownedWorkerSizes(size, owner) {
  workers.forEach((_, workerId) => {
    if (workerResizeOwners.has(workerId)) return;
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

  const MIME = { ".css": "text/css", ".js": "application/javascript" };
  const ext = path.extname(url);
  if (method === "GET" && MIME[ext]) {
    const safePath = path.normalize(url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, "public", safePath);
    if (filePath.startsWith(path.join(__dirname, "public")) && fs.existsSync(filePath)) {
      res.writeHead(200, { "Content-Type": MIME[ext] + "; charset=utf-8" });
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
    });
    startPolling(id);
    broadcast({ type: "spawned", id, cwd, status: "running", sessionName, title: getSessionTitle(sessionName) });
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
    const id = spawnWorker(resolvedCwd, body.cmd);
    return json(res, 200, { ok: true, id });
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
    const { id, text } = JSON.parse(await readBody(req));
    if (!canAccessWorker(ctx, id)) return json(res, 403, { ok: false, error: "forbidden" });
    const ok = sendInput(id, text);
    return json(res, 200, { ok });
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
      // 워커 관련 alert 쿨다운 키 정리 (issueAlertTime 무한 누적 방지)
      issueAlertTime.delete(`worker-waiting-${id}`);
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
      broadcast({ type: "status", id, status: "running", reason: null });
      return json(res, 200, { ok: true });
    }
    return json(res, 200, { ok: false });
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
        let diff = '';
        try {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', 'HEAD', '--', file], execOpts);
        } catch (_) {
          diff = execFileSync('git', ['-C', cwd, '--no-color', 'diff', '--', file], execOpts);
        }
        return json(res, 200, { diff });
      } else {
        // 파일 목록: git status --porcelain (untracked 포함)
        const status = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], execOpts);
        const files = status.trim().split('\n').filter(Boolean).map(line => {
          const xy = line.substring(0, 2).trim();
          const filePath = line.substring(3);
          // 상태 매핑: M=수정, A=추가, D=삭제, ?=untracked(신규), R=이름변경
          let s = 'M';
          if (xy === '??') s = 'A';
          else if (xy.includes('D')) s = 'D';
          else if (xy.includes('A')) s = 'A';
          else if (xy.includes('R')) s = 'R';
          return { status: s, path: filePath };
        });

        let stat = '';
        try {
          stat = execFileSync('git', ['-C', cwd, '--no-color', 'diff', '--stat', 'HEAD'], execOpts).trim();
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

  if (method === "POST" && url === "/api/share-url") {
    if (ctx.kind !== "full") return json(res, 403, { error: "forbidden" });
    const { id } = JSON.parse(await readBody(req));
    if (!workers.has(String(id))) return json(res, 404, { error: "worker not found" });
    return json(res, 200, { url: scopedUrlFor(req, String(id)) });
  }

  json(res, 404, { error: "not found" });
});

wss = new WebSocketServer({ server });
const clientSizes = new Map();
wss.on('connection', (ws, req) => {
  const ctx = authContext(req);
  if (!ctx) {
    ws.close(1008, "unauthorized");
    return;
  }
  ws.authContext = ctx;
  if (ctx.kind === "worker") {
    workerResizeOwners.set(String(ctx.workerId), ws);
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'resize') {
        const size = { cols: msg.cols, rows: msg.rows };
        clientSizes.set(ws, size);
        if (msg.id && workers.has(String(msg.id)) && canAccessWorker(ctx, msg.id)) {
          setWorkerSize(msg.id, size, ws);
        } else if (ctx.kind === "full") {
          setAllUnownedWorkerSizes(size, ws);
        } else {
          setWorkerSize(ctx.workerId, size, ws);
        }
      }
      if (msg.type === 'active') {
        const size = clientSizes.get(ws);
        if (size && ctx.kind === "full") {
          setAllUnownedWorkerSizes(size, ws);
        } else if (size) {
          setWorkerSize(ctx.workerId, size, ws);
        }
      }
    } catch (e) {}
  });
  ws.on('close', () => {
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
    });
    startPolling(id);
    if (numId >= nextId) nextId = numId + 1;
  }
  if (workers.size > 0) {
    console.log(`♻️  Recovered ${workers.size} session(s)`);
  }
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
