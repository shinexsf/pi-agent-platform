/**
 * 内核（@pi-agent-platform/core）。
 *
 * 只放会话内核与它的直接依赖：内核对象的仓储、会话生命周期、worker 进程域、
 * 能力控制面、插件宿主、宿主 API 与基础设施（日志 / 路径 / 配置注入）。
 *
 * 依赖方向单向：入口应用（HTTP server / 未来的桌面端）依赖本包，本包不依赖任何
 * 入口应用。平台功能（通知、配置模板、渠道网关、静态托管）留在入口侧。
 */

// ── 配置注入 ──
export { initCoreConfig, coreConfig, type CoreConfig } from './config.js';

// ── 基础设施 ──
export { logger, childLogger, serverLogFile } from './logger.js';
export { normalizePath } from './utils/normalize-path.js';

// ── 数据层 ──
export * from './db/index.js';

// ── 仓储 ──
export * from './repos/agent.repo.js';
export * from './repos/session.repo.js';

// ── worker 进程域 ──
export * from './worker-pool.js';
export * from './session-timeout-scanner.js';

// ── 会话内核 ──
export * from './services/session.js';
export * from './services/session-ops.js';
export * from './services/attachment-store.js';
export * from './services/extension-utils.js';
export * from './services/plugins.js';
export * from './services/server-builtin-skills.js';
export * from './prompt-resolver.js';
export * from './slash-commands.js';

// ── 能力控制面 ──
export * from './capabilities/index.js';
export * from './capabilities/registry.js';
export * from './capabilities/authorize.js';

// ── 插件宿主 ──
export * from './services/plugin-extensions.js';
export * from './services/event-bus.js';
export * from './services/system-envelope.js';

// ── 宿主 API surface（插件与内核之间唯一的稳定缝）──
export type {
  HostApi,
  HostDbApi,
  HostSessionsApi,
  HostSessionSummary,
  HostAgentsApi,
  HostLifecycleApi,
  HostBusApi,
  HostEnsureSessionInput,
  HostEnsureSessionResult,
  HostSystemEventInput,
} from './host-api.js';

// ── 插件运行期：常量 + registry 读写（契约类型在 @pi-agent-platform/plugin-types）──
export * from './plugins/index.js';
