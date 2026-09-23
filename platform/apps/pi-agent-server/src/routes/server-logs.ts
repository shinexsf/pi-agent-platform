/**
 * Server-logs routes — 系统日志查看（只读活跃日志文件，单文件范围）。
 *
 * 产品功能（web 配置 → 二级菜单「系统日志」），正式端点，不是 debug：
 *   GET /api/server-logs?tail=&level=&q=
 *
 * 路径解析唯一事实来源是 logger.ts 导出的 `serverLogFile`：
 *   dev  = <package>/logs/dev-server.log
 *   prod = $PI_LOG_FILE（pi-server CLI 注入 ~/.pi/server/logs/server.log）
 * 本模块不区分环境 —— 拿到什么路径读什么。
 *
 * 日志是 pino JSONL（含 console bridge 进来的三方输出），单文件 ≤10MB
 * （PI_LOG_MAX_SIZE），整读 + 服务端过滤即可，无需索引。
 * 归档文件（滚动产物）不在本端点范围 —— 存量历史暂不提供。
 *
 * 注意：日志含本地路径等信息；server 本身无 auth，与 /debug/* 同一信任模型
 * （个人平台）。不要把这个端点暴露到公网。
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { serverLogFile } from '../logger.js';

/** 解析后的单条日志（非 JSON 行只带 raw）。 */
export interface ServerLogLineDTO {
  raw: string;
  /** pino time（epoch ms），JSON 行才有 */
  time?: number;
  /** pino 数值级别 10 trace / 20 debug / 30 info / 40 warn / 50 error / 60 fatal */
  level?: number;
  /** child logger 名（server / im-gateway / session-info / ...） */
  name?: string;
  msg?: string;
}

/**
 * level 过滤语义 = 最低级别（阈值）：
 *   error → ≥50（含 fatal）、warn → ≥40、info → ≥30、debug → ≥10（全量）。
 * 未带 level 参数 = 不过滤。
 */
const LEVEL_THRESHOLDS: Record<string, number> = {
  debug: 10,
  info: 30,
  warn: 40,
  error: 50,
};

const MAX_TAIL = 5000;

function parseLine(raw: string): ServerLogLineDTO {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && typeof obj.msg === 'string') {
      return {
        raw,
        time: typeof obj.time === 'number' ? obj.time : undefined,
        level: typeof obj.level === 'number' ? obj.level : undefined,
        name: typeof obj.name === 'string' ? obj.name : undefined,
        msg: obj.msg,
      };
    }
  } catch {
    // 非 JSON 行（三方直接写文件的场景）→ 只回 raw，前端原样展示
  }
  return { raw };
}

export function createServerLogsRouter(): Hono {
  const router = new Hono();

  // GET /api/server-logs?tail=500&level=error&q=keyword
  router.get('/', async (c) => {
    const tailRaw = Number.parseInt(c.req.query('tail') ?? '500', 10);
    const tail = Math.min(MAX_TAIL, Math.max(1, Number.isNaN(tailRaw) ? 500 : tailRaw));
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    const levelName = (c.req.query('level') ?? '').toLowerCase();
    const minLevel = levelName ? LEVEL_THRESHOLDS[levelName] : undefined;

    let content = '';
    let sizeBytes = 0;
    let mtimeMs = 0;
    let exists = true;
    try {
      const [buf, st] = await Promise.all([fs.readFile(serverLogFile, 'utf8'), fs.stat(serverLogFile)]);
      content = buf;
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return c.json({ error: `Failed to read log file: ${(err as Error).message}` }, 500);
      }
      exists = false; // 文件还没生成（server 刚起、logger 未落盘）
    }

    const allLines = content.split('\n').filter((l) => l.trim());
    const matched: ServerLogLineDTO[] = [];
    for (const raw of allLines) {
      if (minLevel !== undefined) {
        // 非 JSON 行级别未知 → 按 info 对待（console bridge 已包进 logger，
        // 纯 raw 行极少见），保证过滤时不漏也不乱。
        const dto = parseLine(raw);
        if ((dto.level ?? 30) < minLevel) continue;
        if (q && !raw.toLowerCase().includes(q)) continue;
        matched.push(dto);
        continue;
      }
      if (q && !raw.toLowerCase().includes(q)) continue;
      matched.push(parseLine(raw));
    }

    return c.json({
      file: serverLogFile,
      exists,
      sizeBytes,
      mtimeMs,
      totalLines: allLines.length,
      matchedLines: matched.length,
      lines: matched.slice(-tail),
    });
  });

  return router;
}
