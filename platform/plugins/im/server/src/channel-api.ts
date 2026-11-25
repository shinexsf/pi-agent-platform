/**
 * IM 渠道契约的类型声明（**协议包**，不是平台契约）。
 *
 * 平台对这些形状一无所知：它只知道"有个 service 注册到了 `im.channel` 这个 namespace"，
 * 以及 `services.call(name, { uplink })` 会拿到一个对象。所以这份文件跟着 im 插件走，
 * 渠道作者拷走它（或以后做成独立小包）。
 *
 * 类比 JDBC：`getDrivers()` → 遍历 → `driver.connect()` → `Connection`。
 * 差别只有一个 —— 这里的"接口"不是平台定的，是这份文件定的。
 */

/** 网关传给渠道的回调面（网关实现，渠道持有）。 */
export interface ImUplink {
  /** 一条连接存在（新增连接 / 插件装载时逐条声明）。 */
  declare(meta: ConnectionMeta): void;
  /** 一条连接被删除（先 retire，再断开，最后改配置文件）。 */
  retire(connectionId: string): void;
  /** 渠道收到外部消息：交给网关路由到会话。 */
  onInbound(msg: InboundMessage): Promise<void>;
  /** 连接在线状态变化（网关据此启停投递与会话订阅）。 */
  onStatus(evt: { connectionId: string; status: ChannelStatus; error?: string }): void;
}

export type ChannelStatus = 'connected' | 'disconnected' | 'error';

/** 连接元信息：渠道告诉网关"我有这么一条连接"。不含 agentId（渠道不认识 agent）。 */
export interface ConnectionMeta {
  id: string;
  label: string;
}

/** 渠道 → 网关 的入站消息。 */
export interface InboundMessage {
  connectionId: string;
  /** 外部会话 id（私聊 = 用户 id，群聊 = 群 id）。 */
  chatId: string;
  /** 发送者（可选，仅用于日志与归因）。 */
  userId?: string;
  text: string;
  attachments?: Array<{ bytes: Uint8Array; mimeType: string; filename?: string }>;
}

/** 出站载荷。 */
export type OutboundPayload = { text: string } | { filePath: string; caption?: string };

/** 渠道实现的驱动面（网关持有）。 */
export interface ChannelDriver {
  /** 契约版本；网关不认就跳过该渠道（只影响它自己）。 */
  apiVersion: 1;
  /** 渠道类型（`qq` / `wechat` / 自定义）。 */
  type: string;
  /** 人类可读名字（网关页展示用）。 */
  label: string;
  /** 当前所有连接（读渠道自己的配置文件）。 */
  connections(): ConnectionMeta[];
  connect(connectionId: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
  /**
   * 可选能力：删除一条连接（渠道删自己 `config.json` 里的条目）。
   *
   * 存在 = 平台页面的"删除"可用；不存在 = 该入口禁用并给出原因（**不静默失败**）。
   * 网关负责在删除前后 `retire` 该连接并清掉绑定。
   */
  remove?(connectionId: string): Promise<void>;
  /** 发一条文本。 */
  send(connectionId: string, chatId: string, payload: { text: string }): Promise<void>;
  /** 可选能力：发文件/图片（存在 = 支持；网关用 `typeof driver.sendFile === 'function'` 判断）。 */
  sendFile?(connectionId: string, chatId: string, payload: { filePath: string; caption?: string }): Promise<void>;
}

/** 接口名常量：渠道注册与网关发现必须用同一串（拼错就谁也看不见谁）。 */
export const CHANNEL_NAMESPACE = 'im.channel';
/** 契约版本。 */
export const CHANNEL_API_VERSION = 1;
