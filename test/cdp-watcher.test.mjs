import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const cdp = require(path.join(ROOT_DIR, 'cdp.js'));
const injectMod = require(path.join(ROOT_DIR, 'inject.js'));
const removeMod = require(path.join(ROOT_DIR, 'remove.js'));

function createMockCdpServer({ evaluateDelayMs = 0 } = {}) {
  const sockets = new Set();
  let injectCount = 0;

  function encodeWsTextFrame(str) {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'PAGE_MOCK',
            type: 'page',
            title: 'Antigravity Mock',
            url: 'https://127.0.0.1:9999/',
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/PAGE_MOCK`,
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));

    let buf = Buffer.alloc(0);
    let fragChunks = [];
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + payloadLen) return;
        let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          const unmasked = Buffer.allocUnsafe(payloadLen);
          for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i & 3];
          payload = unmasked;
        }
        buf = buf.subarray(offset + maskLen + payloadLen);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          fragChunks.push(payload);
          if (fin) {
            const text = Buffer.concat(fragChunks).toString('utf8');
            fragChunks = [];
            try {
              const msg = JSON.parse(text);
              let result = {};
              if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
                result = { identifier: 'script-1' };
              } else if (msg.method === 'Runtime.evaluate') {
                injectCount++;
                result = { result: { type: 'object', value: { version: cdp.PLUGIN_VERSION, status: 'ok' } } };
              }
              const respond = () => {
                if (!socket.destroyed) {
                  socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
                }
              };
              if (msg.method === 'Runtime.evaluate' && evaluateDelayMs > 0) {
                setTimeout(respond, evaluateDelayMs);
              } else {
                respond();
              }
            } catch {}
          }
        }
      }
    });
  });

  return {
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    getInjectCount() {
      return injectCount;
    },
    async close() {
      for (const s of sockets) s.destroy();
      if (!server.listening) return;
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function stageTempRuntimeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-watcher-test-'));
  const files = [
    'cdp.js',
    'inject.js',
    'style.css',
    'config.example.json',
    ...cdp.RUNTIME_PARTS,
  ];
  for (const f of files) {
    fs.copyFileSync(path.join(ROOT_DIR, f), path.join(dir, f));
  }
  return dir;
}

async function waitFor(fn, timeoutMs = 12000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

async function killAndWait(proc, timeoutMs = 1500) {
  if (!proc || proc.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      proc.kill('SIGKILL');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

function cleanupTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
}

test('formatCdpUnavailableMessage clearly distinguishes Antigravity 2.33.0+ running without CDP vs not running', () => {
  const runningNoPort = cdp.formatCdpUnavailableMessage({ running: true, port: null });
  assert.match(runningNoPort, /2\.33\.0/);
  assert.match(runningNoPort, /--remote-debugging-port=0/);

  const runningDeadPort = cdp.formatCdpUnavailableMessage({ running: true, port: 9222 });
  assert.match(runningDeadPort, /9222/);
  assert.match(runningDeadPort, /2\.33\.0/);

  const stopped = cdp.formatCdpUnavailableMessage({ running: false, port: null });
  assert.match(stopped, /未运行/);
  assert.match(stopped, /--remote-debugging-port=0/);
});

test('inject.js --watch --exit-on-host-close exits cleanly and removes .watch.pid after CDP host closes', async () => {
  const dir = stageTempRuntimeDir();
  const mock = createMockCdpServer({ evaluateDelayMs: 300 });
  let child = null;
  try {
    const port = await mock.start();
    child = spawn(process.execPath, [path.join(dir, 'inject.js'), '--watch', '--exit-on-host-close'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port) },
      stdio: 'ignore',
    });

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));

    await waitFor(() => mock.getInjectCount() >= 1, 6000);
    // The first evaluation only applies config. Wait until the watcher has
    // acknowledged the full injection before simulating an attached host closing.
    const logFile = path.join(dir, 'watch.log');
    await waitFor(() => fs.readFileSync(logFile, 'utf8').includes('[✓] 已注入 agy-claude-style:'), 6000);
    assert.ok(fs.existsSync(path.join(dir, '.watch.pid')), '.watch.pid created while watching');

    // Simulate Antigravity closing while port file/env still points to the old dead port
    await mock.close();

    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not exit after host closed')), 12000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid cleaned up on exit');
  } finally {
    await killAndWait(child);
    try { await mock.close(); } catch {}
    cleanupTempDir(dir);
  }
});

test('inject.js --watch --parent-pid exits cleanly when parent process is gone', async () => {
  const dir = stageTempRuntimeDir();
  let child = null;
  try {
    // Spawn a short-lived dummy parent process and immediately wait for it to exit
    const dummy = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = dummy.pid;
    await new Promise((resolve) => dummy.on('exit', resolve));

    child = spawn(
      process.execPath,
      [path.join(dir, 'inject.js'), '--watch', '--parent-pid', String(deadPid)],
      {
        cwd: dir,
        env: { ...process.env, AG_CDP_PORT: '1' },
        stdio: 'ignore',
      }
    );
    const exitCode = await Promise.race([
      new Promise((resolve) => child.on('exit', (code) => resolve(code))),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not exit when parent PID died')), 6000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid cleaned up on parent exit');
  } finally {
    await killAndWait(child);
    cleanupTempDir(dir);
  }
});

test('relaunchAntigravityWithCdp verifies executable before terminating and preserves resolved running path', async () => {
  let terminateCalled = 0;
  let launchedWith = null;

  // Missing executable must NOT terminate the running process
  const missingRes = await cdp.relaunchAntigravityWithCdp({
    detectProcess: () => ({ running: true, pids: [4242] }),
    resolveRunningPath: () => null,
    findExecutable: () => null,
    terminate: () => {
      terminateCalled++;
    },
    launch: (opts) => {
      launchedWith = opts;
      return true;
    },
  });
  assert.deepEqual(missingRes, { relaunched: false, reason: 'executable-not-found' });
  assert.equal(terminateCalled, 0, 'Must not terminate running process when executable cannot be resolved');
  assert.equal(launchedWith, null);

  // When running executable path is resolved, terminate first then launch with that exact path
  let running = true;
  const okRes = await cdp.relaunchAntigravityWithCdp({
    port: 0,
    waitMs: 1000,
    detectProcess: () => ({ running, pids: running ? [5151] : [] }),
    resolveRunningPath: (pids) => (pids.includes(5151) ? '/custom/path/Antigravity' : null),
    findExecutable: () => null,
    terminate: (pids) => {
      terminateCalled++;
      assert.deepEqual(pids, [5151]);
      running = false;
    },
    removePortFile: () => {},
    launch: (opts) => {
      launchedWith = opts;
      return true;
    },
  });
  assert.deepEqual(okRes, { relaunched: true, reason: 'ok' });
  assert.equal(terminateCalled, 1);
  assert.equal(launchedWith.appPath, '/custom/path/Antigravity');
});

test('hasRemoteDebuggingFlag detects --remote-debugging-port on running processes', async () => {
  assert.equal(cdp.hasRemoteDebuggingFlag([]), false);
  if (process.platform === 'win32') return;

  const withFlag = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)', '--', '--remote-debugging-port=0'], {
    stdio: 'ignore',
  });
  const withoutFlag = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
    stdio: 'ignore',
  });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(cdp.hasRemoteDebuggingFlag([withFlag.pid]), true);
    assert.equal(cdp.hasRemoteDebuggingFlag([withoutFlag.pid]), false);
  } finally {
    try { withFlag.kill('SIGKILL'); } catch {}
    try { withoutFlag.kill('SIGKILL'); } catch {}
  }
});

test('cdp exports STARTUP_GRACE_SECONDS = 90 and safe activateAntigravityWindow helper', () => {
  assert.equal(cdp.STARTUP_GRACE_SECONDS, 90);
  assert.equal(typeof cdp.activateAntigravityWindow, 'function');
  if (process.platform !== 'darwin') {
    assert.equal(cdp.activateAntigravityWindow(), false);
  }
});

test('launchAntigravityWithCdp cleans stale port file only when not running and skipPortCleanup is false', () => {
  let removedCount = 0;
  let spawnedArgs = null;
  const fakeSpawn = (cmd, args) => {
    spawnedArgs = { cmd, args };
    return { unref() {} };
  };
  const res = cdp.launchAntigravityWithCdp({
    appPath: '/fake/Antigravity',
    detectProcess: () => ({ running: false, pids: [] }),
    removePortFile: () => {
      removedCount++;
    },
    spawn: fakeSpawn,
  });
  assert.equal(res, true);
  assert.equal(removedCount, 1);
  assert.ok(spawnedArgs.args.includes('--remote-debugging-port=0'));

  // Skip cleanup when process is already running
  cdp.launchAntigravityWithCdp({
    appPath: '/fake/Antigravity',
    detectProcess: () => ({ running: true, pids: [101] }),
    removePortFile: () => {
      removedCount++;
    },
    spawn: fakeSpawn,
  });
  assert.equal(removedCount, 1);

  // Skip cleanup when skipPortCleanup is true
  cdp.launchAntigravityWithCdp({
    appPath: '/fake/Antigravity',
    skipPortCleanup: true,
    detectProcess: () => ({ running: false, pids: [] }),
    removePortFile: () => {
      removedCount++;
    },
    spawn: fakeSpawn,
  });
  assert.equal(removedCount, 1);
});

test('ensureAntigravityWithCdp covers full decision matrix', async () => {
  // 1. already-cdp: reachable port with pages activates and returns already-cdp
  let activated = 0;
  let relaunched = 0;
  let launched = 0;
  const alreadyRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => 9333,
    listPages: async (port) => {
      assert.equal(port, 9333);
      return [{ id: 'p1' }, { id: 'p2' }];
    },
    activate: () => {
      activated++;
    },
    detectProcess: () => {
      throw new Error('detectProcess should not run when already-cdp');
    },
    launch: () => {
      launched++;
      return true;
    },
    relaunch: async () => {
      relaunched++;
      return { relaunched: true, reason: 'ok' };
    },
  });
  assert.deepEqual(alreadyRes, { ok: true, action: 'already-cdp', port: 9333, pagesCount: 2 });
  assert.equal(activated, 1);
  assert.equal(launched, 0);
  assert.equal(relaunched, 0);

  // 2. waiting-cdp: running with --remote-debugging-port activates and returns waiting-cdp
  activated = 0;
  const waitingRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: true, pids: [111, 222] }),
    hasRemoteDebuggingFlag: (pids) => {
      assert.deepEqual(pids, [111, 222]);
      return true;
    },
    activate: () => {
      activated++;
    },
  });
  assert.deepEqual(waitingRes, { ok: true, action: 'waiting-cdp', pids: [111, 222] });
  assert.equal(activated, 1);

  // 3. running-without-cdp: running without CDP and no relaunch flags
  const noCdpRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => 9333,
    listPages: async () => {
      throw new Error('connection refused');
    },
    detectProcess: () => ({ running: true, pids: [333] }),
    hasRemoteDebuggingFlag: () => false,
    relaunch: async () => {
      relaunched++;
      return { relaunched: true, reason: 'ok' };
    },
  });
  assert.deepEqual(noCdpRes, { ok: false, action: 'running-without-cdp', pids: [333] });
  assert.equal(relaunched, 0);

  // 4. relaunch=true: triggers relaunch and returns relaunched
  let relaunchOpts = null;
  const relaunchBoolRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: true, pids: [444] }),
    hasRemoteDebuggingFlag: () => false,
    relaunch: true,
    waitMs: 5000,
    appPath: '/apps/Antigravity',
    relaunchFn: async (opts) => {
      relaunchOpts = opts;
      return { relaunched: true, reason: 'ok' };
    },
  });
  assert.deepEqual(relaunchBoolRes, { ok: true, action: 'relaunched' });
  assert.deepEqual(relaunchOpts, { port: 0, waitMs: 5000, appPath: '/apps/Antigravity' });

  // 5. autoRelaunchWithCdp=true: relaunched & relaunch-failed
  relaunchOpts = null;
  const autoRelaunchOk = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: true, pids: [555] }),
    hasRemoteDebuggingFlag: () => false,
    autoRelaunchWithCdp: true,
    port: 9444,
    relaunch: async (opts) => {
      relaunchOpts = opts;
      return { relaunched: true, reason: 'ok' };
    },
  });
  assert.deepEqual(autoRelaunchOk, { ok: true, action: 'relaunched' });
  assert.deepEqual(relaunchOpts, { port: 9444, waitMs: undefined, appPath: undefined });

  const autoRelaunchFail = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: true, pids: [555] }),
    hasRemoteDebuggingFlag: () => false,
    autoRelaunchWithCdp: true,
    relaunch: async () => ({ relaunched: false, reason: 'still-running' }),
  });
  assert.deepEqual(autoRelaunchFail, { ok: false, action: 'relaunch-failed', reason: 'still-running' });

  // 6. not running -> launched
  let launchOpts = null;
  const launchedRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: false, pids: [] }),
    appPath: '/opt/Antigravity',
    launch: (opts) => {
      launchOpts = opts;
      return true;
    },
  });
  assert.deepEqual(launchedRes, { ok: true, action: 'launched' });
  assert.deepEqual(launchOpts, { port: 0, appPath: '/opt/Antigravity' });

  // 7. not running -> executable-not-found
  const notFoundRes = await cdp.ensureAntigravityWithCdp({
    readPort: () => null,
    detectProcess: () => ({ running: false, pids: [] }),
    launch: () => false,
  });
  assert.deepEqual(notFoundRes, { ok: false, action: 'executable-not-found' });
});

test('inject.js --watch --exit-on-host-close --startup-grace 1 exits 0 and cleans .watch.pid on dead port', async () => {
  const dir = stageTempRuntimeDir();
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [path.join(dir, 'inject.js'), '--watch', '--exit-on-host-close', '--startup-grace', '1'],
      {
        cwd: dir,
        env: { ...process.env, AG_CDP_PORT: '1', AG_WATCH_POLL_MS: '300' },
        stdio: 'ignore',
      }
    );

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    await waitFor(() => fs.existsSync(path.join(dir, '.watch.pid')), 4000, 50);

    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Watcher did not exit after startup grace')), 5000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid cleaned up after startup grace exit');
  } finally {
    await killAndWait(child);
    cleanupTempDir(dir);
  }
});

test('plain inject.js --watch does NOT exit when --startup-grace 1 expires (even if config exitOnHostClose is true)', async () => {
  const dir = stageTempRuntimeDir();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ exitOnHostClose: true }, null, 2));
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [path.join(dir, 'inject.js'), '--watch', '--startup-grace=1'],
      {
        cwd: dir,
        env: { ...process.env, AG_CDP_PORT: '1', AG_WATCH_POLL_MS: '300' },
        stdio: 'ignore',
      }
    );

    await waitFor(() => fs.existsSync(path.join(dir, '.watch.pid')), 4000, 50);
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(child.exitCode, null, 'plain --watch must stay alive past startup grace');
    assert.ok(fs.existsSync(path.join(dir, '.watch.pid')), '.watch.pid remains while plain watcher is running');
  } finally {
    await killAndWait(child);
    cleanupTempDir(dir);
  }
});

test('inject.js --managed attaches to mock CDP, injects, and exits 0 when mock CDP closes', async () => {
  const dir = stageTempRuntimeDir();
  const mock = createMockCdpServer();
  let child = null;
  try {
    const port = await mock.start();
    child = spawn(process.execPath, [path.join(dir, 'inject.js'), '--managed'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port), AG_WATCH_POLL_MS: '250' },
      stdio: 'ignore',
    });

    const exitPromise = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const logFile = path.join(dir, 'watch.log');
    await waitFor(() => {
      try {
        return fs.readFileSync(logFile, 'utf8').includes('[✓] 已注入 agy-claude-style:');
      } catch {
        return false;
      }
    }, 6000, 50);
    assert.ok(fs.existsSync(path.join(dir, '.watch.pid')), '.watch.pid created in --managed mode');

    await mock.close();

    const exitCode = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('--managed watcher did not exit after host closed')), 8000)),
    ]);
    assert.equal(exitCode, 0);
    assert.equal(fs.existsSync(path.join(dir, '.watch.pid')), false, '.watch.pid removed when host closed');
  } finally {
    await killAndWait(child);
    try { await mock.close(); } catch {}
    cleanupTempDir(dir);
  }
});

test('duplicate watcher handling: --managed exits 0 cleanly without clobbering, plain --watch exits 1, --replace takes over', async () => {
  const dir = stageTempRuntimeDir();
  const mock = createMockCdpServer();
  let first = null;
  let dupPlain = null;
  let dupManaged = null;
  let replacer = null;
  try {
    const port = await mock.start();
    const pidFile = path.join(dir, '.watch.pid');

    first = spawn(process.execPath, [path.join(dir, 'inject.js'), '--watch'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port), AG_WATCH_POLL_MS: '300' },
      stdio: 'ignore',
    });
    await waitFor(() => {
      try {
        return fs.readFileSync(pidFile, 'utf8').trim() === String(first.pid);
      } catch {
        return false;
      }
    }, 5000, 50);

    // 1. Plain duplicate --watch exits 1 without overwriting .watch.pid
    dupPlain = spawn(process.execPath, [path.join(dir, 'inject.js'), '--watch'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port) },
      stdio: 'ignore',
    });
    const dupPlainCode = await Promise.race([
      new Promise((resolve) => dupPlain.on('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Plain duplicate watcher did not exit')), 5000)),
    ]);
    assert.equal(dupPlainCode, 1);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(first.pid));
    assert.equal(first.exitCode, null);

    // 2. Duplicate --managed waits briefly and exits 0 cleanly without clobbering .watch.pid
    dupManaged = spawn(process.execPath, [path.join(dir, 'inject.js'), '--managed'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port) },
      stdio: 'ignore',
    });
    const dupManagedCode = await Promise.race([
      new Promise((resolve) => dupManaged.on('exit', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Duplicate --managed did not exit')), 5000)),
    ]);
    assert.equal(dupManagedCode, 0);
    assert.equal(fs.readFileSync(pidFile, 'utf8').trim(), String(first.pid));
    assert.equal(first.exitCode, null);

    // 3. --watch --replace terminates first watcher and takes over .watch.pid
    const firstExitPromise = new Promise((resolve) => first.on('exit', resolve));
    replacer = spawn(process.execPath, [path.join(dir, 'inject.js'), '--watch', '--replace'], {
      cwd: dir,
      env: { ...process.env, AG_CDP_PORT: String(port), AG_WATCH_POLL_MS: '300' },
      stdio: 'ignore',
    });
    await Promise.race([
      firstExitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('--replace did not terminate existing watcher')), 5000)),
    ]);
    await waitFor(() => {
      try {
        return fs.readFileSync(pidFile, 'utf8').trim() === String(replacer.pid);
      } catch {
        return false;
      }
    }, 5000, 50);
    assert.equal(replacer.exitCode, null);
  } finally {
    for (const proc of [first, dupPlain, dupManaged, replacer]) {
      await killAndWait(proc);
    }
    try { await mock.close(); } catch {}
    cleanupTempDir(dir);
  }
});

test('launch scripts, watch-hidden.vbs, and package.json support managed mode by default and --daemon fallback', () => {
  const launchBat = fs.readFileSync(path.join(ROOT_DIR, 'launch.bat'), 'utf8');
  assert.match(launchBat, /--daemon/i);
  assert.match(launchBat, /--exit-on-host-close/);
  assert.match(launchBat, /--watch --replace/);
  assert.match(launchBat, /--launch/);

  const launchSh = fs.readFileSync(path.join(ROOT_DIR, 'launch.sh'), 'utf8');
  assert.match(launchSh, /INJECT_JS="\$PWD\/inject\.js"/);
  assert.match(launchSh, /--daemon/);
  assert.match(launchSh, /--exit-on-host-close/);
  assert.match(launchSh, /--skip-if-running/);
  assert.match(launchSh, /--watch --replace/);
  assert.match(launchSh, /LAUNCH_ARGS/);
  assert.match(launchSh, /node "\$INJECT_JS" --launch/);
  assert.match(launchSh, /node "\$INJECT_JS" --watch --exit-on-host-close --skip-if-running/);

  const vbs = fs.readFileSync(path.join(ROOT_DIR, 'watch-hidden.vbs'), 'utf8');
  assert.match(vbs, /WScript\.Arguments\.Count\s*=\s*0/i);
  assert.match(vbs, /--watch --replace/);
  assert.match(vbs, /WScript\.Arguments\(i\)/i);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.managed, 'node inject.js --managed');
});

test('buildRefreshExpression produces lightweight config refresh payload matching codeHash', () => {
  const full = cdp.buildInjectExpression(cdp.DEFAULT_CONFIG);
  const hash = cdp.computeHash(cdp.readRuntimeBundle());
  const refresh = cdp.buildRefreshExpression({ ...cdp.DEFAULT_CONFIG, palette: 'claude' }, hash);
  assert.ok(refresh.length < 2048, `Expected compact refresh expression, got ${refresh.length} chars`);
  assert.ok(refresh.includes('"palette":"claude"'));
  assert.ok(refresh.includes(hash));
  assert.ok(full.includes(hash));
});

test('writeFileAtomic and updateConfigSetting persist valid updates and preserve file atomically if rename fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-atomic-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  const origRename = fs.renameSync;
  try {
    assert.equal(cdp.updateConfigSetting('palette', 'claude', cfgPath), true);
    assert.equal(cdp.readConfig(cfgPath).palette, 'claude');
    assert.equal(cdp.updateConfigSetting('palette', 'invalid-theme', cfgPath), false);
    assert.equal(cdp.updateConfigSetting('__proto__', 'hacked', cfgPath), false);
    assert.equal(cdp.isLikelyWatcherProcess(-1), false);
    assert.equal(cdp.isLikelyWatcherProcess(99999999), false);

    // Atomic rename failure MUST throw, clean temp file, and leave original config.json untouched
    const originalRaw = fs.readFileSync(cfgPath, 'utf8');
    fs.renameSync = () => {
      const err = new Error('simulated EXDEV/EPERM rename failure');
      err.code = 'EPERM';
      throw err;
    };
    assert.throws(() => cdp.updateConfigSetting('palette', 'obsidian', cfgPath), /simulated EXDEV\/EPERM/);
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), originalRaw);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    assert.deepEqual(leftovers, []);
  } finally {
    fs.renameSync = origRename;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-closed PID ownership blocks kill/overwrite on unknown or foreign PIDs across Node and native cmdlines', () => {
  const targetDir = '/Users/dev/Library/Application Support/AGY Claude Style';
  const aliveKill = () => {};

  // 1. Blocked inspection (e.g. macOS sandbox /bin/ps EPERM) => 'unknown', fail closed
  const unkCls = cdp.classifyWatcherPid(43210, targetDir, {
    killFn: aliveKill,
    inspectFn: () => null,
    platform: 'darwin',
  });
  assert.equal(unkCls.status, 'unknown');
  assert.equal(cdp.isLikelyWatcherProcess(43210, targetDir, { killFn: aliveKill, inspectFn: () => null }), false);

  // 2. Process alive initially, then exited right before inspectFn ran => 'dead'
  let checks = 0;
  const raceDeadCls = cdp.classifyWatcherPid(43211, targetDir, {
    killFn: () => {
      checks++;
      if (checks >= 2) {
        const err = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
    },
    inspectFn: () => null,
    platform: 'darwin',
  });
  assert.equal(raceDeadCls.status, 'dead');

  // 3. Other project's inject.js --watch, one-shot inject.js, shell wrapper, -e eval trick, and other dir native watcher => 'foreign'
  const foreignCmds = [
    'node /Users/dev/other-project/agy-claude-style/inject.js --watch',
    `node "${targetDir}/inject.js"`, // missing --watch
    `node -e "${targetDir}/inject.js" --watch`,
    `node other.js "${targetDir}/inject.js" --watch`,
    `grep "${targetDir}/inject.js" --watch`,
    `tail ${targetDir}/agy-claude-style-watcher`,
    `/tmp/other-install/agy-claude-style-watcher --watch --dir /tmp/other-install`,
    `${targetDir}/agy-claude-style-watcher --once --dir ${targetDir}`,
  ];
  for (const cmd of foreignCmds) {
    const cls = cdp.classifyWatcherPid(51515, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd, args: null, exePath: null, cwd: null }),
      platform: 'darwin',
    });
    assert.equal(cls.status, 'foreign', `Expected foreign for cmdline: ${cmd}`);
  }
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: `tail ${targetDir}/agy-claude-style-watcher`, exePath: '/usr/bin/tail', cwd: null }, targetDir, 'darwin'),
    'foreign'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: `tail ${targetDir}/agy-claude-style-watcher` }, targetDir, 'darwin'),
    'foreign'
  );

  // Argv-based -e eval, wrong positional script, and pre-script Node flags (--require preload) must NEVER classify as owned
  assert.equal(
    cdp.classifyWatcherPid(51516, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node', args: ['node', '-e', path.join(targetDir, 'inject.js'), '--watch'], exePath: null, cwd: null }),
      platform: 'darwin',
    }).status,
    'foreign'
  );
  assert.equal(
    cdp.classifyWatcherPid(51517, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node', args: ['node', 'other.js', path.join(targetDir, 'inject.js'), '--watch'], exePath: null, cwd: null }),
      platform: 'darwin',
    }).status,
    'foreign'
  );
  assert.equal(
    cdp.classifyWatcherPid(51521, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node', args: ['node', '--require', path.join(targetDir, 'inject.js'), '--watch'], exePath: null, cwd: null }),
      platform: 'darwin',
    }).status,
    'unknown'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership({ cmd: `node --require ${path.join(targetDir, 'inject.js')} --watch`, exePath: '/usr/local/bin/node' }, targetDir, 'darwin'),
    'unknown'
  );

  // Relative watch.sh command ("node inject.js --watch --replace"):
  // without cwd => MUST be 'unknown' (fail closed, refuse kill/overwrite); with matching cwd => 'owned'; with different cwd => 'foreign'
  assert.equal(
    cdp.classifyWatcherPid(51518, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node inject.js --watch --replace', args: null, exePath: null, cwd: null }),
      platform: 'darwin',
    }).status,
    'unknown'
  );
  assert.equal(
    cdp.classifyWatcherPid(51519, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node inject.js --watch --replace', args: ['node', 'inject.js', '--watch', '--replace'], exePath: null, cwd: targetDir }),
      platform: 'linux',
    }).status,
    'owned'
  );
  assert.equal(
    cdp.classifyWatcherPid(51520, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd: 'node inject.js --watch --replace', args: ['node', 'inject.js', '--watch', '--replace'], exePath: null, cwd: '/tmp/another-dir' }),
      platform: 'linux',
    }).status,
    'foreign'
  );

  // 4. Owned processes: Node inject.js --watch in targetDir AND native macOS/Windows watchers in targetDir
  const ownedMacCmds = [
    `/usr/local/bin/node ${targetDir}/inject.js --watch`,
    `${targetDir}/agy-claude-style-watcher --watch --dir ${targetDir}`,
    `/tmp/alt-bin/agy-claude-style-watcher --dir ${targetDir} --cdp-port 9222`,
  ];
  for (const cmd of ownedMacCmds) {
    const cls = cdp.classifyWatcherPid(61616, targetDir, {
      killFn: aliveKill,
      inspectFn: () => ({ cmd, args: null, exePath: null, cwd: null }),
      platform: 'darwin',
    });
    assert.equal(cls.status, 'owned', `Expected owned on darwin for cmdline: ${cmd}`);
  }

  const winTarget = 'C:\\Users\\Alice\\AppData\\Local\\AGY Claude Style';
  assert.equal(
    cdp.classifyWatcherPid(71717, winTarget, {
      killFn: aliveKill,
      platform: 'win32',
      inspectFn: () => ({
        exePath: `${winTarget}\\agy-claude-style-watcher.exe`,
        cmd: `"${winTarget}\\agy-claude-style-watcher.exe" --dir "${winTarget}"`,
        args: [`${winTarget}\\agy-claude-style-watcher.exe`, '--dir', winTarget],
        cwd: null,
      }),
    }).status,
    'owned'
  );
  assert.equal(
    cdp.classifyWatcherPid(71718, winTarget, {
      killFn: aliveKill,
      platform: 'win32',
      inspectFn: () => ({
        exePath: `${winTarget}\\agy-claude-style-watcher.exe`,
        cmd: `"${winTarget}\\agy-claude-style-watcher.exe" --dir "C:\\Other\\Dir"`,
        args: [`${winTarget}\\agy-claude-style-watcher.exe`, '--dir', 'C:\\Other\\Dir'],
        cwd: null,
      }),
    }).status,
    'foreign'
  );

  // 5. Exercise REAL acquireLock (inject.js) and stopWatcherWithResult (remove.js) against disk .watch.pid
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-lock-'));
  const pidFile = path.join(lockDir, '.watch.pid');
  try {
    // 5a. Unknown ownership: must NOT send kill signal AND must preserve .watch.pid intact
    fs.writeFileSync(pidFile, '54321\n', 'utf8');
    const signalsUnknown = [];
    let exitCode = null;
    injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9001,
      replaceExisting: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig) signalsUnknown.push([p, sig]);
      },
      inspectFn: () => null,
      exitFn: (code) => {
        exitCode = code;
        return { blocked: true };
      },
    });
    assert.equal(exitCode, 1);
    assert.deepEqual(signalsUnknown, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '54321\n');

    const stopUnk = removeMod.stopWatcherWithResult({
      pidFile,
      targetDir: lockDir,
      selfPid: 9002,
      killFn: (p, sig) => {
        if (sig !== 0) signalsUnknown.push([p, sig || 'SIGTERM']);
      },
      inspectFn: () => null,
    });
    assert.equal(stopUnk.stopped, false);
    assert.equal(stopUnk.reason, 'unknown');
    assert.deepEqual(signalsUnknown, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '54321\n');

    // 5b. Foreign PID: must NOT send kill signal, clears stale .watch.pid and writes selfPid
    const signalsForeign = [];
    const foreignRes = injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9003,
      replaceExisting: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig) signalsForeign.push([p, sig]);
      },
      inspectFn: () => ({ cmd: '/usr/bin/python3 -m http.server', args: null, exePath: null, cwd: null }),
    });
    assert.equal(foreignRes.acquired, true);
    assert.deepEqual(signalsForeign, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '9003');

    // 5c. Owned PID: stopWatcherWithResult sends termination signal and removes .watch.pid
    const signalsOwned = [];
    const stopOwned = removeMod.stopWatcherWithResult({
      pidFile,
      targetDir: lockDir,
      selfPid: 9004,
      killFn: (p, sig) => {
        if (sig === 0) return;
        signalsOwned.push([p, sig || 'SIGTERM']);
      },
      inspectFn: () => ({
        cmd: `"${process.execPath}" "${path.join(lockDir, 'inject.js')}" --watch`,
        args: null,
        exePath: null,
        cwd: null,
      }),
    });
    assert.equal(stopOwned.stopped, true);
    assert.equal(stopOwned.pid, 9003);
    assert.equal(signalsOwned.length, 1);
    assert.equal(fs.existsSync(pidFile), false);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('applyPageScripts separates immutable bootstrap from short config script and retains latest config across reload', async () => {
  const fullExpr = cdp.buildInjectExpression({ ...cdp.DEFAULT_CONFIG, palette: 'claude' });
  const hash = cdp.computeHash(cdp.readRuntimeBundle());
  const cfg1 = cdp.buildConfigScriptExpression({ ...cdp.DEFAULT_CONFIG, palette: 'claude' }, hash);
  const cfg2 = cdp.buildConfigScriptExpression({ ...cdp.DEFAULT_CONFIG, palette: 'obsidian' }, hash);
  assert.ok(cfg2.length < 2048, `Config script must stay short, got ${cfg2.length}`);

  let nextId = 1;
  const activeScripts = new Map();
  const cdpCalls = [];
  const fakeSession = {
    async send(method, params) {
      cdpCalls.push({ method, sourceLen: params?.source?.length || 0, params });
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        const id = 'doc-script-' + nextId++;
        activeScripts.set(id, params.source);
        return { identifier: id };
      }
      if (method === 'Page.removeScriptToEvaluateOnNewDocument') {
        activeScripts.delete(params.identifier);
        return {};
      }
      return {};
    },
    async evaluate(source) {
      cdpCalls.push({ method: 'Runtime.evaluate', sourceLen: source.length, source });
      if (source.includes("status: 'refreshed'")) {
        return { version: cdp.PLUGIN_VERSION, status: 'refreshed', state: { cfg: { palette: 'obsidian' } } };
      }
      return { version: cdp.PLUGIN_VERSION, status: 'ok', state: { cfg: { palette: 'claude' } } };
    },
  };

  const entry = { session: fakeSession, bootstrapScriptId: null, configScriptId: null };
  await injectMod.applyPageScripts(entry, { expr: fullExpr, configExpr: cfg1, refreshOnly: false });
  const callsBeforeConfigReload = cdpCalls.length;
  const origBootstrapId = entry.bootstrapScriptId;

  const reloadRes = await injectMod.applyPageScripts(entry, { expr: fullExpr, configExpr: cfg2, refreshOnly: true });
  assert.equal(reloadRes.status, 'refreshed');
  assert.equal(entry.bootstrapScriptId, origBootstrapId, 'bootstrapScriptId must remain untouched on config-only change');

  const configCalls = cdpCalls.slice(callsBeforeConfigReload);
  const maxConfigPayload = Math.max(...configCalls.map((c) => c.sourceLen));
  assert.ok(maxConfigPayload < 2048, `Expected zero ~1.4MB payload on config reload, max=${maxConfigPayload}`);
  assert.equal(activeScripts.size, 2);

  // Replay both remaining AddScriptToEvaluateOnNewDocument scripts in registration order on a fresh document (navigation simulation)
  const docListeners = new Map();
  const htmlEl = {
    attributes: new Map(),
    setAttribute(k, v) { this.attributes.set(k, String(v)); },
    getAttribute(k) { return this.attributes.get(k) ?? null; },
    removeAttribute(k) { this.attributes.delete(k); },
    appendChild() {},
    querySelectorAll: () => [],
  };
  const headEl = { appendChild() {}, lastElementChild: null };
  const bodyEl = { appendChild() {}, querySelectorAll: () => [] };
  const fakeDoc = {
    documentElement: null,
    head: null,
    body: null,
    readyState: 'loading',
    hidden: false,
    getElementById: () => null,
    createElement: (tag) => ({
      tagName: tag.toUpperCase(),
      id: '',
      textContent: '',
      style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      appendChild() {},
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      remove() {},
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(ev, fn) {
      if (!docListeners.has(ev)) docListeners.set(ev, []);
      docListeners.get(ev).push(fn);
    },
    removeEventListener(ev, fn) {
      const arr = docListeners.get(ev);
      if (arr) {
        const idx = arr.indexOf(fn);
        if (idx >= 0) arr.splice(idx, 1);
      }
    },
  };
  const storageMap = new Map();
  const sandbox = {
    window: null,
    globalThis: null,
    document: fakeDoc,
    navigator: { language: 'en-US' },
    location: { pathname: '/' },
    localStorage: {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    performance: { now: () => Date.now() },
    Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  // Step 1: Execute new-document scripts in exact registration order at document-start
  for (const scriptSource of activeScripts.values()) {
    vm.runInNewContext(scriptSource, sandbox);
  }
  // Step 2: Simulate HTML root becoming available on DOMContentLoaded
  fakeDoc.documentElement = htmlEl;
  fakeDoc.head = headEl;
  fakeDoc.body = bodyEl;
  fakeDoc.readyState = 'interactive';
  for (const fn of [...(docListeners.get('DOMContentLoaded') || [])]) fn();

  const mountedState = sandbox.window.__agClaudeStyle.getState();
  assert.equal(mountedState.cfg.palette, 'obsidian', 'Reloaded document must initialize with latest config override');
  vm.runInNewContext(cdp.REMOVE_EXPRESSION, sandbox);

  // Additional real scenarios for Item D:
  // (a) New window attach AFTER config.json changed while bootstrap expr in memory still holds old palette='claude'
  const mkLiveSandbox = () => {
    const htmlNode = {
      attributes: new Map(),
      setAttribute(k, v) { this.attributes.set(k, String(v)); },
      getAttribute(k) { return this.attributes.get(k) ?? null; },
      removeAttribute(k) { this.attributes.delete(k); },
      appendChild() {},
      querySelectorAll: () => [],
    };
    const ldoc = {
      documentElement: htmlNode,
      head: { appendChild() {}, lastElementChild: null },
      body: { appendChild() {}, querySelectorAll: () => [] },
      readyState: 'complete',
      hidden: false,
      getElementById: () => null,
      createElement: () => ({
        tagName: 'DIV', id: '', textContent: '', style: {},
        classList: { add() {}, remove() {}, contains: () => false },
        setAttribute() {}, getAttribute: () => null, removeAttribute() {},
        appendChild() {}, addEventListener() {}, removeEventListener() {},
        querySelectorAll: () => [], querySelector: () => null, remove() {},
      }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    const ls = new Map();
    const sb = {
      window: null, globalThis: null, document: ldoc,
      navigator: { language: 'en-US' }, location: { pathname: '/' },
      localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      matchMedia: () => ({ matches: false }),
      MutationObserver: class { observe() {} disconnect() {} },
      ResizeObserver: class { observe() {} disconnect() {} },
      requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
      performance: { now: () => Date.now() },
      Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean, Promise, Uint8Array, Float32Array, Intl,
    };
    sb.window = sb;
    sb.globalThis = sb;
    return sb;
  };

  // Case (a): fresh window attach using stale fullExpr ('claude') + latest cfg2 ('obsidian')
  const sbNewWin = mkLiveSandbox();
  const entryNewWin = {
    bootstrapScriptId: null,
    configScriptId: null,
    session: {
      async send(method) {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's-' + Math.random() };
        return {};
      },
      async evaluate(source) {
        return vm.runInNewContext(source, sbNewWin);
      },
    },
  };
  await injectMod.applyPageScripts(entryNewWin, { expr: fullExpr, configExpr: cfg2, refreshOnly: false });
  assert.equal(sbNewWin.window.__agClaudeStyle.getState().cfg.palette, 'obsidian', 'New window attached after config-only update must start with obsidian');
  vm.runInNewContext(cdp.REMOVE_EXPRESSION, sbNewWin);

  // Case (b): fast refresh failure triggers full fallback AND still evaluates cfg2 before stale expr so window gets obsidian
  const sbFallback = mkLiveSandbox();
  let evalCount = 0;
  const entryFallback = {
    bootstrapScriptId: 'old-boot',
    configScriptId: 'old-cfg',
    session: {
      async send(method) {
        if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 's-fb-' + Math.random() };
        return {};
      },
      async evaluate(source) {
        evalCount++;
        if (evalCount === 1) return null; // Simulate fast-refresh miss triggering full fallback
        return vm.runInNewContext(source, sbFallback);
      },
    },
  };
  const fbRes = await injectMod.applyPageScripts(entryFallback, { expr: fullExpr, configExpr: cfg2, refreshOnly: true });
  assert.equal(fbRes.status, 'ok');
  assert.equal(sbFallback.window.__agClaudeStyle.getState().cfg.palette, 'obsidian', 'Full fallback after fast-refresh miss must end up with obsidian');
  vm.runInNewContext(cdp.REMOVE_EXPRESSION, sbFallback);
});

test('evaluateWatcherOwnership classifies --managed node watcher and native --launch watcher as owned while one-shot --launch stays foreign', () => {
  const macDir = '/Users/dev/Library/Application Support/AGY Claude Style';
  assert.equal(
    cdp.evaluateWatcherOwnership(`node "${macDir}/inject.js" --managed`, macDir, 'darwin'),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: 'node', args: ['node', `${macDir}/inject.js`, '--managed'], exePath: null, cwd: null },
      macDir,
      'darwin'
    ),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(`node "${macDir}/inject.js" --launch`, macDir, 'darwin'),
    'foreign'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: 'node', args: ['node', `${macDir}/inject.js`, '--launch'], exePath: null, cwd: null },
      macDir,
      'darwin'
    ),
    'foreign'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      `"${macDir}/agy-claude-style-watcher" --launch --relaunch --exit-on-host-close --dir "${macDir}"`,
      macDir,
      'darwin'
    ),
    'owned'
  );

  const winDir = 'C:\\Users\\Alice\\AppData\\Local\\AGY Claude Style';
  assert.equal(
    cdp.evaluateWatcherOwnership(
      {
        exePath: `${winDir}\\agy-claude-style-watcher.exe`,
        cmd: `"${winDir}\\agy-claude-style-watcher.exe" --launch --relaunch --exit-on-host-close --dir "${winDir}"`,
        args: [`${winDir}\\agy-claude-style-watcher.exe`, '--launch', '--relaunch', '--exit-on-host-close', '--dir', winDir],
        cwd: null,
      },
      winDir,
      'win32'
    ),
    'owned'
  );

  // macOS /var <-> /private/var and /tmp <-> /private/tmp symlink canonicalization (including spaces)
  const varSpaceDir = '/var/folders/ab/My Space Dir/agy-cs';
  const privVarSpaceDir = `/private${varSpaceDir}`;
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: `/usr/local/bin/node "${varSpaceDir}/inject.js" --watch`, args: null, exePath: '/usr/local/bin/node', cwd: null },
      privVarSpaceDir,
      'darwin'
    ),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: `/usr/local/bin/node "${privVarSpaceDir}/inject.js" --managed`, args: null, exePath: '/usr/local/bin/node', cwd: null },
      varSpaceDir,
      'darwin'
    ),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: `/usr/local/bin/node "/private/tmp/agy cs/inject.js" --watch`, args: null, exePath: null, cwd: null },
      '/tmp/agy cs',
      'darwin'
    ),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      {
        cmd: `/private/var/folders/ab/My Space Dir/agy-cs/agy-claude-style-watcher --launch --dir "/private/var/folders/ab/My Space Dir/agy-cs"`,
        args: null,
        exePath: '/var/folders/ab/My Space Dir/agy-cs/agy-claude-style-watcher',
        cwd: null,
      },
      varSpaceDir,
      'darwin'
    ),
    'owned'
  );
  assert.equal(
    cdp.evaluateWatcherOwnership(
      { cmd: `/usr/local/bin/node "/private/var/folders/other/inject.js" --watch`, args: null, exePath: null, cwd: null },
      varSpaceDir,
      'darwin'
    ),
    'foreign'
  );
});

test('acquireLock with allowGracefulDuplicateExit keeps fail-closed unknown/foreign protection and skips owned duplicate cleanly', () => {
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cs-lock-grace-'));
  const pidFile = path.join(lockDir, '.watch.pid');
  try {
    // 1. Unknown PID still fails closed with exitFn(1) and preserves .watch.pid
    fs.writeFileSync(pidFile, '55551\n', 'utf8');
    const signalsUnknown = [];
    let unknownExitCode = null;
    const unknownRes = injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9101,
      allowGracefulDuplicateExit: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig) signalsUnknown.push([p, sig]);
      },
      inspectFn: () => null,
      exitFn: (code, info) => {
        unknownExitCode = code;
        return { blocked: true, code, info };
      },
    });
    assert.equal(unknownExitCode, 1);
    assert.equal(unknownRes.blocked, true);
    assert.deepEqual(signalsUnknown, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '55551\n');

    // 2. Foreign PID is never signaled; lock is acquired and .watch.pid is updated
    const signalsForeign = [];
    let foreignExitCalled = false;
    const foreignRes = injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9102,
      allowGracefulDuplicateExit: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig) signalsForeign.push([p, sig]);
      },
      inspectFn: () => ({ cmd: '/usr/bin/python3 -m http.server', args: null, exePath: null, cwd: null }),
      exitFn: () => {
        foreignExitCalled = true;
      },
    });
    assert.equal(foreignExitCalled, false);
    assert.equal(foreignRes.acquired, true);
    assert.equal(foreignRes.priorStatus, 'foreign');
    assert.deepEqual(signalsForeign, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '9102');

    // 3. Owned PID returns { acquired: false, duplicate: true } cleanly without calling exitFn or overwriting .watch.pid
    const signalsOwned = [];
    let ownedExitCalled = false;
    const ownedRes = injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9103,
      allowGracefulDuplicateExit: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig) signalsOwned.push([p, sig]);
      },
      inspectFn: () => ({
        cmd: `"${process.execPath}" "${path.join(lockDir, 'inject.js')}" --managed`,
        args: null,
        exePath: null,
        cwd: null,
      }),
      exitFn: () => {
        ownedExitCalled = true;
      },
    });
    assert.equal(ownedExitCalled, false);
    assert.deepEqual(ownedRes, { acquired: false, duplicate: true, pid: 9102 });
    assert.deepEqual(signalsOwned, []);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '9102');

    // 4. Owned PID that exits during grace poll re-evaluates and acquires lock
    let pollChecks = 0;
    let exitedExitCalled = false;
    const exitedRes = injectMod.acquireLock({
      pidFile,
      targetDir: lockDir,
      selfPid: 9104,
      allowGracefulDuplicateExit: true,
      skipExitHook: true,
      killFn: (p, sig) => {
        if (sig === 0) {
          pollChecks++;
          if (pollChecks >= 3) {
            const err = new Error('ESRCH');
            err.code = 'ESRCH';
            throw err;
          }
        }
      },
      inspectFn: () => ({
        cmd: `"${process.execPath}" "${path.join(lockDir, 'inject.js')}" --managed`,
        args: null,
        exePath: null,
        cwd: null,
      }),
      exitFn: () => {
        exitedExitCalled = true;
      },
    });
    assert.equal(exitedExitCalled, false);
    assert.equal(exitedRes.acquired, true);
    assert.equal(exitedRes.replaced, true);
    assert.equal(fs.readFileSync(pidFile, 'utf8'), '9104');
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('listPages includes Swarm sidecar iframe targets, excludes unrelated iframes, and inject expression skips CSS on plugin: sidecars', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 'MAIN_PAGE',
            type: 'page',
            title: 'Antigravity',
            url: 'https://127.0.0.1:2736/',
            webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/MAIN_PAGE',
          },
          {
            id: 'SWARM_FRAME',
            type: 'iframe',
            title: 'Swarm',
            url: 'plugin://swarm--swarm_board-42226/?token=abc&conversationId=123',
            webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/SWARM_FRAME',
          },
          {
            id: 'OTHER_FRAME',
            type: 'iframe',
            title: 'Other Plugin',
            url: 'plugin://other--panel-1234/',
            webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/OTHER_FRAME',
          },
          {
            id: 'DEVTOOLS',
            type: 'page',
            title: 'DevTools',
            url: 'devtools://devtools/bundled/inspector.html',
            webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/DEVTOOLS',
          },
          {
            id: 'DATA_PAGE',
            type: 'page',
            title: 'Blank',
            url: 'data:text/html,<html></html>',
            webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/DATA_PAGE',
          },
        ])
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try {
    const port = srv.address().port;
    const targets = await cdp.listPages(port);
    assert.deepEqual(
      targets.map((t) => t.id),
      ['MAIN_PAGE', 'SWARM_FRAME']
    );
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }

  const sidecarIdx = cdp.RUNTIME_PARTS.indexOf('sidecar-core.js');
  const uiIdx = cdp.RUNTIME_PARTS.indexOf('ui-runtime.js');
  assert.ok(sidecarIdx >= 0 && sidecarIdx < uiIdx, 'sidecar-core.js must load before ui-runtime.js');

  const injectExpr = cdp.buildInjectExpression();
  assert.ok(injectExpr.includes("location.protocol === 'plugin:'"), 'inject expression must guard CSS on sidecars');
  assert.ok(cdp.REMOVE_EXPRESSION.includes('delete globalThis.__agCsSidecarCore'), 'REMOVE_EXPRESSION cleans __agCsSidecarCore');
});
