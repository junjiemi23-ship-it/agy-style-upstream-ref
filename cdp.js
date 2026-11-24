// Chrome DevTools Protocol (CDP) helpers for AGY Claude Style (agy-claude-style).
// Node >= 22: uses built-in fetch and WebSocket (zero external dependencies).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const STYLE_ID = 'ag-claude-style-css';
const PLUGIN_VERSION = '2.2.0';
const SETTING_BINDING = '__agClaudeStyleSetting';
const STARTUP_GRACE_SECONDS = 90;
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const APP_DATA = IS_MAC
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : IS_WIN
  ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

const PORT_FILE = path.join(APP_DATA, 'Antigravity', 'DevToolsActivePort');
const PID_FILE = path.join(__dirname, '.watch.pid');
const CONFIG_FILE = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  language: 'zh-CN',
  palette: 'obsidian',
  homeLayout: 'studio',
  homeRipple: true,
  composerRestyle: true,
  mascot: 'crab',
  logoInk: 'accent',
  inlineStats: true,
  ringMode: 'dual',
  turnBadges: true,
  focusMode: false,
  sprintMinutes: '25',
  meteorRide: 'auto',
  costGuard: true,
  hudTopBar: false,
  hudBottomBar: false,
  hudRimProgress: false,
  hudFooterChip: false,
  hudCompact: false,
  effortSliderStyle: 'claude',
  effortAccent: true,
  performanceBackdrop: 'card',
  smoothCaret: true,
  sidebarRestyle: true,
  sidebarCompact: false,
  placeholderStyle: 'studio',
  autoRelaunchWithCdp: true,
  exitOnHostClose: false,
  pollIntervalMs: 2500,
};

// Shared declarative schema consumed by inject.js and installer build manifests.
const CONFIG_VALIDATORS = {
  language: ['zh-CN', 'zh-TW', 'yue', 'en', 'ja'],
  palette: ['obsidian', 'claude', 'host'],
  homeLayout: ['studio', 'classic', 'off'],
  homeRipple: 'boolean',
  composerRestyle: 'boolean',
  mascot: ['crab', 'off'],
  logoInk: ['accent', 'foreground'],
  inlineStats: 'boolean',
  ringMode: ['dual', 'context', 'quota'],
  turnBadges: 'boolean',
  focusMode: 'boolean',
  sprintMinutes: ['off', '25', '45'],
  meteorRide: ['auto', 'manual', 'off'],
  costGuard: 'boolean',
  hudTopBar: 'boolean',
  hudBottomBar: 'boolean',
  hudRimProgress: 'boolean',
  hudFooterChip: 'boolean',
  hudCompact: 'boolean',
  effortSliderStyle: ['claude', 'chatgpt', 'liangwufeng'],
  effortAccent: 'boolean',
  performanceBackdrop: ['off', 'card', 'page'],
  smoothCaret: 'boolean',
  sidebarRestyle: 'boolean',
  sidebarCompact: 'boolean',
  placeholderStyle: ['studio', 'host'],
  autoRelaunchWithCdp: 'boolean',
  exitOnHostClose: 'boolean',
};

function validateConfigSetting(key, value) {
  if (key === 'pollIntervalMs') {
    return Number.isInteger(value) && value >= 250 && value <= 60000;
  }
  if (!Object.prototype.hasOwnProperty.call(CONFIG_VALIDATORS, key)) return false;
  const rule = CONFIG_VALIDATORS[key];
  if (rule === 'boolean') return typeof value === 'boolean';
  if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value);
  return false;
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function readConfig(configPath = CONFIG_FILE) {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function updateConfigSetting(key, value, configPath = CONFIG_FILE) {
  if (!validateConfigSetting(key, value)) return false;
  const next = { ...readConfig(configPath), [key]: value };
  writeFileAtomic(configPath, JSON.stringify(next, null, 2) + '\n');
  return true;
}

function readPort() {
  if (process.env.AG_CDP_PORT) return parseInt(process.env.AG_CDP_PORT, 10);
  try {
    const text = fs.readFileSync(PORT_FILE, 'utf8');
    const port = parseInt(text.split(/\r?\n/)[0].trim(), 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

const SWARM_SIDECAR_URL_PREFIX = 'plugin://swarm--';

function isInjectableTarget(t) {
  if (!t || !t.webSocketDebuggerUrl) return false;
  const url = typeof t.url === 'string' ? t.url : '';
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.startsWith('devtools://') || lowerUrl.startsWith('data:')) return false;
  if (t.type === 'page') return true;
  if (t.type === 'iframe' && lowerUrl.startsWith(SWARM_SIDECAR_URL_PREFIX)) return true;
  return false;
}

async function listPages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  const targets = await res.json();
  return targets.filter(isInjectableTarget);
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onClose = null;
    this.listeners = new Map();
    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.method) {
        for (const cb of this.listeners.get(msg.method) || []) cb(msg.params);
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    const handleClosed = () => {
      if (this.closed) return;
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
      if (this.onClose) this.onClose();
    };
    ws.addEventListener('close', handleClosed);
    ws.addEventListener('error', handleClosed);
  }

  static connect(wsUrl, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connect timeout'));
      }, timeoutMs);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(new CdpSession(ws));
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connect failed'));
        },
        { once: true }
      );
    });
  }

  send(method, params = {}, timeoutMs = 5000) {
    if (this.closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async evaluate(expression, awaitPromise = false) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res.result.value;
  }

  close() {
    if (!this.closed) this.ws.close();
  }
}

function readCss() {
  return fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
}

const RUNTIME_PARTS = ['i18n-locales.js', 'i18n-core.js', 'sidecar-core.js', 'usage-core.js', 'ripple-core.js', 'mascot-core.js', 'focus-core.js', 'crab-assets.js', 'effort-core.js', 'perf-assets.js', 'ui-runtime.js'];

function readRuntimeBundle() {
  return RUNTIME_PARTS.map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
}

function computeHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildInjectExpression(customConfig) {
  const config = customConfig || readConfig();
  const css = readCss();
  const bundle = readRuntimeBundle();
  const codeHash = computeHash(bundle);
  return `(() => {
    const css = ${JSON.stringify(css)};
    const applyStyle = () => {
      const targetParent = document.head || document.documentElement;
      if (!targetParent) return;
      let style = document.getElementById(${JSON.stringify(STYLE_ID)});
      if (!style) {
        style = document.createElement('style');
        style.id = ${JSON.stringify(STYLE_ID)};
      }
      if (style.textContent !== css) style.textContent = css;
      if (style.parentNode !== targetParent || targetParent.lastElementChild !== style) {
        targetParent.appendChild(style);
      }
    };

    let status = 'ok';
    let mounted = false;
    const mount = () => {
      if (mounted || !document.documentElement) return;
      mounted = true;
      try {
        const isSidecar = typeof location !== 'undefined' && location.protocol === 'plugin:';
        if (!isSidecar) {
          if (document.head) applyStyle();
          else document.addEventListener('DOMContentLoaded', applyStyle, { once: true });
        }
        ${bundle}
        if (typeof globalThis.__agCsUiMain === 'function') {
          const baseCfg = ${JSON.stringify({ ...config, binding: SETTING_BINDING, codeHash })};
          const ov = globalThis.__agCsOverrideConfig;
          const nextCfg =
            ov && typeof ov === 'object' && ov.codeHash === baseCfg.codeHash
              ? { ...baseCfg, ...ov, binding: baseCfg.binding, codeHash: baseCfg.codeHash }
              : baseCfg;
          globalThis.__agCsUiMain(nextCfg);
        }
      } catch (e) {
        status = 'error: ' + (e && e.message ? e.message : String(e));
        if (typeof console !== 'undefined' && console.error) {
          console.error('[agy-claude-style] init error:', e);
        }
      }
    };

    if (document.documentElement) {
      mount();
    } else {
      status = 'deferred';
      const onReady = () => {
        if (document.documentElement) {
          document.removeEventListener('readystatechange', onReady);
          document.removeEventListener('DOMContentLoaded', onReady);
          mount();
        }
      };
      document.addEventListener('readystatechange', onReady);
      document.addEventListener('DOMContentLoaded', onReady);
    }
    const st = window.__agClaudeStyle && window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null;
    return {
      version: ${JSON.stringify(PLUGIN_VERSION)},
      status,
      state: st,
    };
  })()`;
}

function buildConfigScriptExpression(customConfig, expectedCodeHash) {
  const config = customConfig || readConfig();
  const expectedHash = expectedCodeHash || '';
  const payload = { ...config, binding: SETTING_BINDING, codeHash: expectedHash };
  return `(() => {
    const nextCfg = ${JSON.stringify(payload)};
    globalThis.__agCsOverrideConfig = nextCfg;
    if (
      window.__agClaudeStyle &&
      typeof window.__agClaudeStyle.refreshConfig === 'function' &&
      (!${JSON.stringify(expectedHash)} || window.__agClaudeStyle.codeHash === ${JSON.stringify(expectedHash)})
    ) {
      window.__agClaudeStyle.refreshConfig(nextCfg);
      return {
        version: ${JSON.stringify(PLUGIN_VERSION)},
        status: 'refreshed',
        state: window.__agClaudeStyle.getState ? window.__agClaudeStyle.getState() : null,
      };
    }
    return null;
  })()`;
}

function buildRefreshExpression(customConfig, expectedCodeHash) {
  return buildConfigScriptExpression(customConfig, expectedCodeHash);
}

const REMOVE_EXPRESSION = `(() => {
  if (Array.isArray(globalThis.__agCsCleanups)) {
    while (globalThis.__agCsCleanups.length) {
      const fn = globalThis.__agCsCleanups.pop();
      try {
        if (typeof fn === 'function') fn();
      } catch (e) {}
    }
  }
  delete globalThis.__agCsCleanups;
  delete globalThis.__agCsOverrideConfig;
  try {
    if (window.__agClaudeStyle && typeof window.__agClaudeStyle.destroy === 'function') {
      window.__agClaudeStyle.destroy();
    }
  } catch (e) {}
  if (window.__agCsI18n && typeof window.__agCsI18n.destroy === 'function') {
    window.__agCsI18n.destroy();
  }
  delete window.__agClaudeStyle;
  delete window.__agCsI18n;
  delete globalThis.__agCsUiMain;
  delete globalThis.__agCsCrabAssets;
  delete globalThis.__agCsMascotCore;
  delete globalThis.__agCsFocusCore;
  delete globalThis.__agCsRippleCore;
  delete globalThis.__agCsUsageCore;
  delete globalThis.__agCsEffortCore;
  delete globalThis.__agCsPerfAssets;
  delete globalThis.__agCsI18nCore;
  delete globalThis.__agCsSidecarCore;
  delete globalThis.__agCsLocales;
  const root = document.documentElement;
  if (root) {
    root.removeAttribute('data-ag-cs-effort-accent');
    root.removeAttribute('data-ag-cs-perf-backdrop');
    root.removeAttribute('data-ag-cs-focus');
    root.removeAttribute('data-ag-cs-lang');
    root.removeAttribute('data-ag-cs-cjk');
    if (root.getAttribute('data-ag-cjk') === '1') root.removeAttribute('data-ag-cjk');
  }
  const nodes = document.querySelectorAll(
    'style#${STYLE_ID}, style#ag-token-hud-style, .ag-cs-home-panel-seat, .ag-cs-ripple-host, .ag-cs-ripple-canvas, .ag-cs-crab, .ag-cs-meteor-stage, .ag-cs-wish-toast, .ag-cs-sprint-pill, .ag-cs-cost-guard-bar, .ag-cs-inline-stats, .ag-cs-context-ring, .ag-cs-ctx-popover, .ag-cs-effort-popover, .ag-cs-perf-backdrop, .ag-cs-smooth-caret, .ag-cs-turn-bar, .ag-cs-hud-top-bar, .ag-cs-hud-bottom-bar, .ag-cs-hud-rim-progress, .ag-cs-hud-footer-chip, #ag-cs-settings-sec, .ag-th-top-bar, .ag-th-bottom-bar, .ag-th-rim-progress, .ag-th-footer-chip, .ag-th-popover, .ag-th-turn-bar, .ag-th-reopen-pill'
  );
  nodes.forEach((n) => n.remove());
  return { removed: nodes.length };
})()`;

function detectAntigravityProcess() {
  try {
    if (IS_MAC) {
      const out = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const pid = parseInt(m[1], 10);
        const comm = m[2].trim();
        const lower = comm.toLowerCase();
        if (
          lower.endsWith('/antigravity.app/contents/macos/antigravity') ||
          lower === 'antigravity'
        ) {
          pids.push(pid);
        }
      }
      return { running: pids.length > 0, pids };
    }
    if (IS_WIN) {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const pids = [];
      for (const rawLine of out.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || !line.startsWith('"')) continue;
        const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
        if (cols.length >= 2 && cols[0].toLowerCase() === 'antigravity.exe') {
          const pid = parseInt(cols[1], 10);
          if (Number.isInteger(pid) && pid > 0) pids.push(pid);
        }
      }
      return { running: pids.length > 0, pids };
    }
    const out = execFileSync('ps', ['-eo', 'pid=,comm='], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = [];
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim();
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      if (path.basename(m[2].trim()).toLowerCase() === 'antigravity') {
        pids.push(parseInt(m[1], 10));
      }
    }
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

function findAntigravityExecutable() {
  if (IS_MAC) {
    const candidates = [
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const candidates = [
      path.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe'),
      path.join(progFiles, 'Antigravity', 'Antigravity.exe'),
      path.join(progFilesX86, 'Antigravity', 'Antigravity.exe'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }
  for (const c of ['/usr/bin/antigravity', '/usr/local/bin/antigravity', '/opt/Antigravity/antigravity']) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveRunningAntigravityPath(pids = []) {
  const validPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0) : [];
  try {
    if (IS_MAC) {
      const args = validPids.length > 0 ? ['-p', validPids.join(','), '-o', 'comm='] : ['-ax', '-o', 'comm='];
      const out = execFileSync('/bin/ps', args, {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const suffix = '/contents/macos/antigravity';
      for (const rawLine of out.split(/\r?\n/)) {
        const comm = rawLine.trim();
        const lower = comm.toLowerCase();
        if (lower.endsWith(`.app${suffix}`) && comm.length > suffix.length) {
          const appPath = comm.slice(0, comm.length - suffix.length);
          if (fs.existsSync(appPath)) return appPath;
        }
      }
      return null;
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty ExecutablePath",
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      for (const rawLine of out.split(/\r?\n/)) {
        const exePath = rawLine.trim();
        if (exePath && fs.existsSync(exePath)) return exePath;
      }
      return null;
    }
    for (const pid of validPids) {
      try {
        const target = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
        if (target && fs.existsSync(target)) return target;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

function hasRemoteDebuggingFlag(pids = []) {
  const validPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0) : [];
  if (validPids.length === 0) return false;
  try {
    if (IS_MAC) {
      const out = execFileSync('/bin/ps', ['-p', validPids.join(','), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /--remote-debugging-port(?:=|\s|$)/i.test(out);
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" | Select-Object -ExpandProperty CommandLine",
        ],
        {
          encoding: 'utf8',
          timeout: 3000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      return /--remote-debugging-port(?:=|\s|$)/i.test(out);
    }
    for (const pid of validPids) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        const args = raw.split('\0').filter(Boolean);
        if (args.some((arg) => /^--remote-debugging-port(?:=|$)/i.test(arg))) {
          return true;
        }
      } catch {}
    }
    return false;
  } catch {
    return false;
  }
}

function checkPidAlive(pid, killFn = (p, sig) => process.kill(p, sig)) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    killFn(pid, 0);
    return 'alive';
  } catch (err) {
    if (err && err.code === 'EPERM') return 'alive';
    return 'dead';
  }
}

function splitCommandArgs(cmdLine) {
  if (typeof cmdLine !== 'string' || !cmdLine.trim()) return [];
  const args = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmdLine.length; i++) {
    const ch = cmdLine[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < cmdLine.length && (cmdLine[i + 1] === '"' || cmdLine[i + 1] === '\\')) {
        cur += cmdLine[++i];
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur.length > 0) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) args.push(cur);
  return args;
}

function inspectProcessInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (IS_MAC) {
      const cmd = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!cmd) return null;
      let exePath = null;
      try {
        exePath = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
          encoding: 'utf8',
          timeout: 1500,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null;
      } catch {}
      return { cmd, args: null, exePath, cwd: null };
    }
    if (IS_WIN) {
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p | Select-Object ExecutablePath, CommandLine | ConvertTo-Json -Compress }`,
        ],
        {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();
      if (!out) return null;
      const parsed = JSON.parse(out);
      const cmd = typeof parsed.CommandLine === 'string' ? parsed.CommandLine.trim() : '';
      const exePath = typeof parsed.ExecutablePath === 'string' ? parsed.ExecutablePath.trim() : null;
      if (!cmd) return null;
      return {
        cmd,
        args: splitCommandArgs(cmd),
        exePath: exePath || null,
        cwd: null,
      };
    }
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const args = raw.split('\0').filter((s) => s.length > 0);
    const cmd = args.join(' ').trim();
    if (!cmd) return null;
    let cwd = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    let exePath = null;
    try {
      exePath = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {}
    return { cmd, args, exePath, cwd };
  } catch {
    return null;
  }
}

function inspectProcessCommand(pid) {
  const info = inspectProcessInfo(pid);
  return info && typeof info.cmd === 'string' && info.cmd.length > 0 ? info.cmd : null;
}

function normalizePathForCompare(p, targetPlatform = process.platform) {
  if (!p || typeof p !== 'string') return '';
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  let cleaned = pathMod.normalize(p.replace(/[\\\/]+$/, '') || p);
  if (targetPlatform === 'darwin') {
    cleaned = cleaned.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '');
  } else if (targetPlatform === 'win32') {
    cleaned = cleaned.toLowerCase();
  }
  return cleaned;
}

function resolveCandidatePath(candidate, cwd, targetPlatform = process.platform) {
  if (!candidate || typeof candidate !== 'string') return '';
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  if (pathMod.isAbsolute(candidate)) {
    return normalizePathForCompare(pathMod.resolve(candidate), targetPlatform);
  }
  if (cwd && pathMod.isAbsolute(cwd)) {
    return normalizePathForCompare(pathMod.resolve(cwd, candidate), targetPlatform);
  }
  return '';
}

function hasPathToken(haystack, targetPath, targetPlatform = process.platform) {
  if (!haystack || !targetPath) return false;
  const h = targetPlatform === 'win32' ? haystack.toLowerCase() : haystack;
  const t = normalizePathForCompare(targetPath, targetPlatform);
  let idx = 0;
  while ((idx = h.indexOf(t, idx)) !== -1) {
    const before = idx === 0 ? ' ' : h[idx - 1];
    const afterIdx = idx + t.length;
    const after = afterIdx >= h.length ? ' ' : h[afterIdx];
    const beforeOk = idx === 0 || /[\s"']/.test(before);
    const afterOk = afterIdx === h.length || /[\s"']/.test(after);
    if (beforeOk && afterOk) return true;
    idx += t.length;
  }
  return false;
}

function extractDirFlagValue(cmd, args, cwd, targetPlatform = process.platform) {
  if (Array.isArray(args) && args.length > 0) {
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--dir' && i + 1 < args.length) {
        return { present: true, resolved: resolveCandidatePath(args[i + 1], cwd, targetPlatform) };
      }
      if (args[i].startsWith('--dir=')) {
        return { present: true, resolved: resolveCandidatePath(args[i].slice(6), cwd, targetPlatform) };
      }
    }
    return { present: false, resolved: '' };
  }
  const m = cmd.match(/(?:^|\s)--dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(.+?))(?=\s+--[a-z0-9-]+(?:=|\s|$)|$)/i);
  if (!m) return { present: false, resolved: '' };
  const rawVal = (m[1] || m[2] || m[3] || '').trim();
  return { present: true, resolved: resolveCandidatePath(rawVal, cwd, targetPlatform) };
}

const NODE_DISALLOWED_ENTRY_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-i',
  '--interactive',
  '-c',
  '--check',
  '-h',
  '--help',
  '-v',
  '--version',
]);

function isNodeBinaryName(binPathOrToken, targetPlatform = process.platform) {
  if (!binPathOrToken || typeof binPathOrToken !== 'string') return false;
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  const base = pathMod.basename(binPathOrToken).toLowerCase();
  return /^(?:node(?:\.exe)?|nodejs|electron(?:\.exe)?|electron helper.*|antigravity(?:\.exe)?)$/.test(base);
}

function evaluateWatcherOwnership(rawInfo, targetDir = __dirname, targetPlatform = process.platform) {
  if (!rawInfo || !targetDir) return 'unknown';
  const info =
    typeof rawInfo === 'string'
      ? { cmd: rawInfo, args: null, exePath: null, cwd: null }
      : rawInfo;
  const cmd = typeof info.cmd === 'string' ? info.cmd.trim() : '';
  if (!cmd) return 'unknown';

  const args = Array.isArray(info.args) ? info.args : null;
  const pathMod = targetPlatform === 'win32' ? path.win32 : path.posix;
  const normTargetDir = normalizePathForCompare(pathMod.resolve(targetDir), targetPlatform);
  if (!normTargetDir) return 'unknown';

  const hasFlag = (flag) =>
    args
      ? args.includes(flag)
      : new RegExp(`(?:^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(cmd);

  if (hasFlag('--once') || hasFlag('--remove')) {
    return 'foreign';
  }

  // 1. Native watcher binary check (must match executable itself, never mid-command arguments like `tail /path/watcher`).
  const nativeExeName = targetPlatform === 'win32' ? 'agy-claude-style-watcher.exe' : 'agy-claude-style-watcher';
  const expectedNativeExe = normalizePathForCompare(pathMod.join(normTargetDir, nativeExeName), targetPlatform);
  const exePrefix = cmd.split(/\s+--/)[0].trim().replace(/^["']|["']$/g, '');
  const leadingToken = exePrefix.split(/\s+/)[0] || '';
  const exeMatchesNative = info.exePath
    ? pathMod.basename(info.exePath).toLowerCase() === nativeExeName
    : args && args[0]
    ? pathMod.basename(args[0]).toLowerCase() === nativeExeName
    : normalizePathForCompare(exePrefix, targetPlatform) === expectedNativeExe ||
      (!/\s/.test(exePrefix) && pathMod.basename(exePrefix).toLowerCase() === nativeExeName);

  if (exeMatchesNative) {
    const dirFlag = extractDirFlagValue(cmd, args, info.cwd, targetPlatform);
    if (dirFlag.present) {
      if (dirFlag.resolved) {
        return dirFlag.resolved === normTargetDir ? 'owned' : 'foreign';
      }
      return 'unknown';
    }
    const resolvedExe = info.exePath
      ? normalizePathForCompare(pathMod.resolve(info.exePath), targetPlatform)
      : args && args[0]
      ? resolveCandidatePath(args[0], info.cwd, targetPlatform)
      : pathMod.isAbsolute(exePrefix)
      ? normalizePathForCompare(exePrefix, targetPlatform)
      : '';
    if (resolvedExe) {
      return normalizePathForCompare(pathMod.dirname(resolvedExe), targetPlatform) === normTargetDir ? 'owned' : 'foreign';
    }
    return 'unknown';
  }

  // 2. Node inject.js --watch / --managed check: verify executable AND exact first script argument (no ambiguous CLI flag skipping).
  if (!hasFlag('--watch') && !hasFlag('--managed')) return 'foreign';
  const expectedScript = normalizePathForCompare(pathMod.join(normTargetDir, 'inject.js'), targetPlatform);

  if (args && args.length >= 2) {
    if (!isNodeBinaryName(info.exePath || args[0], targetPlatform)) return 'foreign';
    const entryScript = args[1];
    if (!entryScript) return 'foreign';
    if (entryScript.startsWith('-')) {
      return NODE_DISALLOWED_ENTRY_FLAGS.has(entryScript.toLowerCase()) ? 'foreign' : 'unknown';
    }
    if (pathMod.basename(entryScript).toLowerCase() !== 'inject.js') {
      return 'foreign';
    }
    const resolvedEntry = resolveCandidatePath(entryScript, info.cwd, targetPlatform);
    if (resolvedEntry) {
      return resolvedEntry === expectedScript ? 'owned' : 'foreign';
    }
    return 'unknown';
  }

  // Space-joined cmd string (e.g. macOS ps): use info.exePath (from -o comm=) when available, else first token.
  let launcherTok = '';
  let rest = '';
  if (info.exePath) {
    launcherTok = info.exePath;
    if (cmd.startsWith(info.exePath) && (cmd.length === info.exePath.length || /\s/.test(cmd[info.exePath.length]))) {
      rest = cmd.slice(info.exePath.length).trim();
    } else {
      const baseExe = pathMod.basename(info.exePath);
      if (cmd.startsWith(baseExe) && (cmd.length === baseExe.length || /\s/.test(cmd[baseExe.length]))) {
        rest = cmd.slice(baseExe.length).trim();
      } else {
        rest = cmd.slice(leadingToken.length).trim();
      }
    }
  } else {
    const tokens = splitCommandArgs(cmd);
    launcherTok = tokens[0] || leadingToken;
    const trimmed = cmd.trimStart();
    if (tokens[0] && (trimmed.startsWith(`"${tokens[0]}"`) || trimmed.startsWith(`'${tokens[0]}'`))) {
      rest = trimmed.slice(tokens[0].length + 2).trim();
    } else {
      rest = trimmed.slice(launcherTok.length).trim();
    }
  }

  if (!isNodeBinaryName(launcherTok, targetPlatform)) return 'foreign';
  if (!rest) return 'foreign';
  if (rest.startsWith('-')) {
    const firstFlag = rest.split(/\s+/)[0].toLowerCase();
    return NODE_DISALLOWED_ENTRY_FLAGS.has(firstFlag) ? 'foreign' : 'unknown';
  }

  const normRest = targetPlatform === 'win32' ? rest.toLowerCase() : rest;
  const rawUnquotedRest = normRest.replace(/^["']/, '');
  const unquotedRest =
    targetPlatform === 'darwin'
      ? rawUnquotedRest.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|\s|"|'|$))/, '')
      : rawUnquotedRest;
  if (unquotedRest.startsWith(expectedScript)) {
    const nextChar = unquotedRest[expectedScript.length];
    if (!nextChar || /[\s"']/.test(nextChar)) {
      return 'owned';
    }
  }

  const firstArg = rest.replace(/^["']/, '').split(/[\s"']/)[0] || '';
  if (!firstArg || pathMod.basename(firstArg).toLowerCase() !== 'inject.js') {
    // Handles non-inject.js first arg (e.g. other.js) AND also safe fallback for unknown spaces in script path
    if (pathMod.isAbsolute(firstArg)) return 'foreign';
    return firstArg.toLowerCase().endsWith('inject.js') ? 'unknown' : 'foreign';
  }
  const resolvedRel = resolveCandidatePath(firstArg, info.cwd, targetPlatform);
  if (resolvedRel) {
    return resolvedRel === expectedScript ? 'owned' : 'foreign';
  }
  return 'unknown';
}

function matchesWatcherForDir(rawInfo, targetDir = __dirname, targetPlatform = process.platform) {
  return evaluateWatcherOwnership(rawInfo, targetDir, targetPlatform) === 'owned';
}

function classifyWatcherPid(pid, targetDir = __dirname, opts = {}) {
  const killFn = typeof opts.killFn === 'function' ? opts.killFn : (p, sig) => process.kill(p, sig);
  const inspectFn = typeof opts.inspectFn === 'function' ? opts.inspectFn : inspectProcessInfo;
  const platform = opts.platform || process.platform;

  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 'dead', pid, reason: 'invalid-pid' };
  }
  if (checkPidAlive(pid, killFn) === 'dead') {
    return { status: 'dead', pid, reason: 'esrch' };
  }

  let rawInfo = null;
  try {
    rawInfo = inspectFn(pid);
  } catch {
    rawInfo = null;
  }
  const info =
    typeof rawInfo === 'string'
      ? { cmd: rawInfo, args: null, exePath: null, cwd: null }
      : rawInfo;

  if (!info || typeof info.cmd !== 'string' || !info.cmd.trim()) {
    if (checkPidAlive(pid, killFn) === 'dead') {
      return { status: 'dead', pid, reason: 'exited-during-inspect' };
    }
    return { status: 'unknown', pid, reason: 'inspect-unavailable' };
  }

  const ownership = evaluateWatcherOwnership(info, targetDir, platform);
  if (ownership === 'owned') {
    return { status: 'owned', pid, info };
  }
  if (ownership === 'unknown') {
    return { status: 'unknown', pid, info, reason: 'relative-path-unverified' };
  }
  return { status: 'foreign', pid, info };
}

function isLikelyWatcherProcess(pid, targetDir = __dirname, opts = {}) {
  return classifyWatcherPid(pid, targetDir, opts).status === 'owned';
}

function resolveExistingWatchPidAction(pidFile = PID_FILE, targetDir = __dirname, opts = {}) {
  const selfPid = Number.isInteger(opts.selfPid) ? opts.selfPid : process.pid;
  let pid;
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
  } catch {
    return { action: 'write', status: 'missing', pid: null };
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return { action: 'clear', status: 'invalid', pid: null };
  }
  if (pid === selfPid) {
    return { action: 'write', status: 'self', pid };
  }
  const cls = classifyWatcherPid(pid, targetDir, opts);
  if (cls.status === 'dead') {
    return { action: 'clear', status: 'dead', pid };
  }
  if (cls.status === 'foreign') {
    return { action: 'clear', status: 'foreign', pid, info: cls.info };
  }
  if (cls.status === 'owned') {
    return { action: 'owned', status: 'owned', pid, info: cls.info };
  }
  return { action: 'refuse', status: 'unknown', pid, reason: cls.reason };
}

function removeStalePortFile() {
  try {
    if (fs.existsSync(PORT_FILE)) fs.unlinkSync(PORT_FILE);
  } catch {}
}

function activateAntigravityWindow(opts = {}) {
  if (IS_MAC) {
    try {
      const appTarget = opts.appPath || findAntigravityExecutable() || 'Antigravity';
      const child = spawn('/usr/bin/open', ['-a', appTarget], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function launchAntigravityWithCdp(opts = {}) {
  const cdpPort = Number.isInteger(opts.port) && opts.port >= 0 ? opts.port : 0;
  const flag = `--remote-debugging-port=${cdpPort}`;
  const detectFn = typeof opts.detectProcess === 'function' ? opts.detectProcess : detectAntigravityProcess;
  const removePortFileFn =
    typeof opts.removePortFile === 'function' ? opts.removePortFile : removeStalePortFile;
  const spawnFn = typeof opts.spawn === 'function' ? opts.spawn : spawn;
  if (!opts.skipPortCleanup && !detectFn().running) {
    removePortFileFn();
  }
  if (IS_MAC) {
    const appTarget = opts.appPath || findAntigravityExecutable() || 'Antigravity';
    const child = spawnFn('/usr/bin/open', ['-a', appTarget, '--args', flag], {
      detached: true,
      stdio: 'ignore',
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  }
  const exePath = opts.appPath || findAntigravityExecutable();
  if (!exePath) return false;
  const child = spawnFn(exePath, [flag], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  if (child && typeof child.unref === 'function') child.unref();
  return true;
}

async function ensureAntigravityWithCdp(opts = {}) {
  const readPortFn = typeof opts.readPort === 'function' ? opts.readPort : readPort;
  const listPagesFn = typeof opts.listPages === 'function' ? opts.listPages : listPages;
  const detectProcessFn =
    typeof opts.detectProcess === 'function' ? opts.detectProcess : detectAntigravityProcess;
  const hasCdpFlagFn =
    typeof opts.hasRemoteDebuggingFlag === 'function'
      ? opts.hasRemoteDebuggingFlag
      : hasRemoteDebuggingFlag;
  const launchFn = typeof opts.launch === 'function' ? opts.launch : launchAntigravityWithCdp;
  const relaunchFn =
    typeof opts.relaunch === 'function'
      ? opts.relaunch
      : typeof opts.relaunchFn === 'function'
      ? opts.relaunchFn
      : relaunchAntigravityWithCdp;
  const activateFn =
    typeof opts.activate === 'function' ? opts.activate : activateAntigravityWindow;
  const shouldRelaunch = opts.relaunch === true || Boolean(opts.autoRelaunchWithCdp);

  const port = readPortFn();
  if (port) {
    try {
      const pages = await listPagesFn(port);
      if (Array.isArray(pages) && pages.length > 0) {
        try {
          await activateFn({ appPath: opts.appPath });
        } catch {}
        return { ok: true, action: 'already-cdp', port, pagesCount: pages.length };
      }
    } catch {}
  }

  const proc = detectProcessFn() || { running: false, pids: [] };
  const pids = Array.isArray(proc.pids) ? proc.pids : [];
  if (proc.running) {
    if (hasCdpFlagFn(pids)) {
      try {
        await activateFn({ appPath: opts.appPath });
      } catch {}
      return { ok: true, action: 'waiting-cdp', pids };
    }
    if (shouldRelaunch) {
      const res = await relaunchFn({
        port: opts.port ?? 0,
        waitMs: opts.waitMs,
        appPath: opts.appPath,
      });
      if (res && res.relaunched) {
        return { ok: true, action: 'relaunched' };
      }
      return { ok: false, action: 'relaunch-failed', reason: res?.reason || 'unknown' };
    }
    return { ok: false, action: 'running-without-cdp', pids };
  }

  const launched = launchFn({ port: opts.port ?? 0, appPath: opts.appPath });
  if (launched) {
    return { ok: true, action: 'launched' };
  }
  return { ok: false, action: 'executable-not-found' };
}

async function relaunchAntigravityWithCdp(opts = {}) {
  const waitMs = Number.isInteger(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : 8000;
  const detectFn = typeof opts.detectProcess === 'function' ? opts.detectProcess : detectAntigravityProcess;
  const resolveRunningFn =
    typeof opts.resolveRunningPath === 'function' ? opts.resolveRunningPath : resolveRunningAntigravityPath;
  const findExeFn = typeof opts.findExecutable === 'function' ? opts.findExecutable : findAntigravityExecutable;
  const launchFn = typeof opts.launch === 'function' ? opts.launch : launchAntigravityWithCdp;
  const removePortFileFn =
    typeof opts.removePortFile === 'function' ? opts.removePortFile : removeStalePortFile;
  const killFn =
    typeof opts.terminate === 'function'
      ? opts.terminate
      : (pids) => {
          if (IS_WIN) {
            const validWinPids = Array.isArray(pids) ? pids.filter((p) => Number.isInteger(p) && p > 0 && p !== process.pid) : [];
            if (validWinPids.length > 0) {
              for (const pid of validWinPids) {
                try {
                  execFileSync('taskkill', ['/PID', String(pid), '/T'], {
                    timeout: 4000,
                    windowsHide: true,
                    stdio: 'ignore',
                  });
                } catch {}
              }
            } else {
              execFileSync('taskkill', ['/IM', 'Antigravity.exe'], {
                timeout: 4000,
                windowsHide: true,
                stdio: 'ignore',
              });
            }
          } else {
            for (const pid of pids) {
              if (pid > 0 && pid !== process.pid) {
                try {
                  process.kill(pid, 'SIGTERM');
                } catch {}
              }
            }
          }
        };

  const initialProc = detectFn();
  const initialPids = Array.isArray(initialProc?.pids) ? initialProc.pids : [];
  const resolvedPath = opts.appPath || resolveRunningFn(initialPids) || findExeFn();
  const hasValidTarget = Boolean(
    resolvedPath && (typeof opts.launch === 'function' || fs.existsSync(resolvedPath))
  );
  if (!hasValidTarget) {
    return { relaunched: false, reason: 'executable-not-found' };
  }

  try {
    killFn(initialPids);
  } catch {}

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!detectFn().running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (detectFn().running) {
    return { relaunched: false, reason: 'still-running' };
  }
  removePortFileFn();
  await new Promise((r) => setTimeout(r, 350));
  const launched = launchFn({ ...opts, appPath: resolvedPath });
  return { relaunched: launched, reason: launched ? 'ok' : 'executable-not-found' };
}

function formatCdpUnavailableMessage({ running, port }) {
  const launchHint = IS_MAC
    ? 'open -a Antigravity --args --remote-debugging-port=0（或运行 ./launch.sh）'
    : IS_WIN
    ? 'Antigravity.exe --remote-debugging-port=0（或双击 launch.bat）'
    : 'antigravity --remote-debugging-port=0（或运行 ./launch.sh）';
  if (running) {
    return (
      `检测到 Antigravity 正在运行，但未开启远程调试端口（Antigravity 2.33.0+ 默认关闭 CDP` +
      `${port ? `，端口 ${port} 无响应` : `，未生成 ${PORT_FILE}`}）。` +
      `请完全退出 Antigravity 后带参启动：${launchHint}`
    );
  }
  if (port) {
    return `端口 ${port} 无响应：Antigravity 可能未运行。请通过带参方式启动：${launchHint}`;
  }
  return `未找到调试端口文件，Antigravity 未运行: ${PORT_FILE}。如使用 Antigravity 2.33.0+，请使用 ${launchHint}`;
}

module.exports = {
  STYLE_ID,
  PLUGIN_VERSION,
  SETTING_BINDING,
  STARTUP_GRACE_SECONDS,
  RUNTIME_PARTS,
  PORT_FILE,
  PID_FILE,
  CONFIG_FILE,
  DEFAULT_CONFIG,
  CONFIG_VALIDATORS,
  validateConfigSetting,
  writeFileAtomic,
  readConfig,
  updateConfigSetting,
  readPort,
  SWARM_SIDECAR_URL_PREFIX,
  isInjectableTarget,
  listPages,
  detectAntigravityProcess,
  findAntigravityExecutable,
  resolveRunningAntigravityPath,
  hasRemoteDebuggingFlag,
  splitCommandArgs,
  inspectProcessInfo,
  inspectProcessCommand,
  evaluateWatcherOwnership,
  matchesWatcherForDir,
  classifyWatcherPid,
  resolveExistingWatchPidAction,
  isLikelyWatcherProcess,
  removeStalePortFile,
  activateAntigravityWindow,
  launchAntigravityWithCdp,
  relaunchAntigravityWithCdp,
  ensureAntigravityWithCdp,
  formatCdpUnavailableMessage,
  CdpSession,
  readCss,
  readRuntimeBundle,
  computeHash,
  buildInjectExpression,
  buildConfigScriptExpression,
  buildRefreshExpression,
  REMOVE_EXPRESSION,
};
