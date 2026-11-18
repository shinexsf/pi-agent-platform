/**
 * 内核运行期配置：由入口应用在启动时注入。
 *
 * 内核**不读环境变量、不推算路径** —— 那些是"这个进程怎么被启动"的知识，属于入口。
 * 内核只声明"我需要知道哪些值"，由组合根填。
 *
 * 单例形态（而不是层层传参）的理由：这些值对整个进程是常量，且 `worker-pool` /
 * 插件解析 / 会话服务都在深调用栈里，逐层透传只会增加噪音而不增加安全。
 * 如果将来同一进程要跑两个不同配置的内核实例，这里需要改成显式传参。
 */

export interface CoreConfig {
  /** 可同时存活的 worker 上限。 */
  maxWorkers: number;
  /** pi agent 目录（`~/.pi/agent`），用于读 settings、注入 worker 环境。 */
  agentDir: string;
  /** 附件根目录（worker 从中读字节）。 */
  attachmentsDir: string;
  /** 插件目录（registry.json + 各插件子目录）。 */
  pluginsDir: string;
  /** 平台随包 skill 的根目录（为空表示不注入）。 */
  serverBuiltinSkillsDir: string | undefined;
  /** 平台 MCP 目录（`mcp.json` 路径），注入给 worker。 */
  mcpConfigPath: string;
  /** worker 启动就绪等待上限（毫秒）。 */
  workerStartupTimeoutMs: number;
  /** worker SIGTERM → SIGKILL 的等待上限（毫秒）。 */
  workerStopTimeoutMs: number;
  /** 是否开发态（影响 worker 入口解析与诊断面）。 */
  isDev: boolean;
}

let current: CoreConfig | undefined;

/** 由组合根调用一次。 */
export function initCoreConfig(config: CoreConfig): void {
  current = config;
}

/** 读取内核配置；未初始化时立即失败（早失败优于默认值静默生效）。 */
export function coreConfig(): CoreConfig {
  if (!current) {
    throw new Error('core config not initialized — call initCoreConfig() from the composition root first');
  }
  return current;
}
