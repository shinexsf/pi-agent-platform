#!/usr/bin/env node
/**
 * stop-server.mjs — 按端口精确停止 dev/packaged server。
 *
 * 背景：禁止用 `taskkill /IM node.exe` / `pkill node` 这类按进程名批量 kill 的方式停
 * server —— 会误杀机器上其他无关 node 进程（pi-server CLI、其他工具等）。
 * 本脚本只定位并 kill **监听指定端口的那一个进程**：
 *
 *   - 端口解析：--port=N，缺省固定 3000（dev 默认值，见 server config.ts）。
 *     不跟随 PORT 环境变量 —— agent/工具环境里可能被注入无关的 PORT，
 *     跟随会导致误伤别的服务（如 9006 的 pi-server daemon）。停其他端口必须显式 --port。
 *   - Windows：`netstat -ano -p tcp` 解析 LISTENING 行取 PID
 *   - POSIX：`lsof -iTCP:<port> -sTCP:LISTEN -t`（fallback: `ss -lptn`）
 *   - kill 范围：仅该 PID（session-worker 子进程会在 IPC disconnect 时自退出，
 *     见 workers/session-worker/src/index.ts 的 process.on('disconnect')，
 *     不需要也不会去 kill 其他 node 进程）
 *
 * 用法：
 *   node scripts/stop-server.mjs              # 只停 3000 端口上的 dev server
 *   node scripts/stop-server.mjs --port=9006  # 停打包态 pi-server（默认 9006）
 *   node scripts/stop-server.mjs --dry-run    # 只列出目标 PID，不 kill
 */

import { exec, execFileSync } from 'node:child_process';
import process from 'node:process';

// ---------- args ----------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const port = Number.parseInt(String(args.port ?? '3000'), 10);
if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error(`[stop-server] invalid port: ${args.port}`);
  process.exit(1);
}
const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';

// ---------- resolve PID by listening port ----------

/** @returns {number[]} PIDs listening on `port` */
function findListenerPids() {
  if (process.platform === 'win32') {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    const pids = new Set();
    for (const line of out.split('\n')) {
      // "  TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345"
      const m = line.match(/^\s+TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && Number.parseInt(m[2], 10) === port) {
        const pid = Number.parseInt(m[3], 10);
        if (pid > 0 && pid !== process.pid) pids.add(pid);
      }
    }
    return [...pids];
  }

  // POSIX: lsof first, ss fallback
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
    });
    return [
      ...new Set(
        out
          .split('\n')
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid),
      ),
    ];
  } catch {
    /* lsof missing or no listener — fall through to ss */
  }
  try {
    const out = execFileSync('ss', ['-lptnH', `sport = :${port}`], { encoding: 'utf8' });
    const pids = new Set();
    for (const m of out.matchAll(/pid=(\d+)/g)) {
      const pid = Number.parseInt(m[1], 10);
      if (pid > 0 && pid !== process.pid) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

/** Best-effort process label for logging (never used for matching/killing). */
function describePid(pid) {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim()
        : execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return out.split('\n')[0] ?? '';
  } catch {
    return '(info unavailable)';
  }
}

/** Kill exactly one PID. Windows: taskkill /F /PID (precise). POSIX: SIGTERM → 5s → SIGKILL. */
async function killPid(pid) {
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      exec(`taskkill /F /PID ${pid}`, { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; /* already gone */
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      return; /* exited */
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* give up */
  }
}

// ---------- main ----------

const pids = findListenerPids();

if (pids.length === 0) {
  console.log(`[stop-server] no process listening on port ${port} — nothing to do`);
  process.exit(0);
}

for (const pid of pids) {
  console.log(`[stop-server] port ${port} → pid ${pid} ${describePid(pid)}`);
}

if (dryRun) {
  console.log('[stop-server] dry-run: not killing');
  process.exit(0);
}

for (const pid of pids) {
  await killPid(pid);
  console.log(`[stop-server] killed pid ${pid}`);
}
console.log('[stop-server] done (session workers self-exit on IPC disconnect)');
