/**
 * QQ real adapter — wraps qq-bot-sdk (WebSocket) + @tencent-connect/qqbot-connector.
 *
 * Login flow (different from WeChat):
 *   1. Call `startQrConnect(callbacks)` to get a scan URL from q.qq.com
 *   2. User scans the URL with the mobile QQ app on https://bot.q.qq.com
 *   3. Connector's polling picks up the auth result and invokes onSuccess
 *      with `{appId, appSecret, userOpenid}` (the bot's own credentials,
 *      not pre-registered — the QR is the registration step)
 *   4. We fetch `users/@me` to get the bot's display name, then write
 *      the row to DB and emit a 'connected' event
 *
 * Messaging flow (after login):
 *   - createWebsocket() to iLink, listen for C2C/GROUP messages
 *   - Send replies via client.c2cApi.postMessage(openID, msg)
 *
 * MVP scope: p2p only. Group messages are handled at routing layer (fast-fail).
 */

import { createOpenAPI, createWebsocket, WsEventType, AvailableIntentsEventsEnum } from 'qq-bot-sdk';
import { startQrConnect, type QrConnectCredentials } from '@tencent-connect/qqbot-connector';

type QQBotEnv = 'production' | 'test';
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelErrorHandler,
  ChannelId,
  ChannelMessageHandler,
  ChannelStatusHandler,
  ChannelStatusSnapshot,
  ExternalChatId,
  OutboundTarget,
} from '@pi-agent-platform/channel-types';
import { QQ_SYSTEM_PROMPT } from './system-prompt.js';

export interface QqAdapterOptions {
  config: ChannelConfig;
  host: {
    logEvent: (e: {
      channelId: ChannelId;
      channelType: string;
      kind: string;
      message?: string;
      data?: Record<string, unknown>;
    }) => void;
    /** Optional: persist final appId/appSecret/displayName to the channels_qq
     * row. Called only on successful QR scan. */
    onCredentials?: (creds: { appId: string; appSecret: string; displayName: string }) => void;
  };
  appId: string; // placeholder (empty for fresh QR login)
  appSecret: string; // placeholder
  /** Connector environment: 'production' (default) or 'test' (sandbox).
   *  Set via QQ_BOT_ENV env var in channel-qq package. */
  env?: QQBotEnv;
}

/**
 * Real QQ adapter. The first start() call uses the QR flow; subsequent calls
 * (or after the row has real appId/appSecret) connect directly via WebSocket.
 */
export class QqAdapter implements ChannelAdapter {
  readonly type = 'qq' as const;

  private msgHandler: ChannelMessageHandler | null = null;
  private errHandler: ChannelErrorHandler | null = null;
  private statusHandler: ChannelStatusHandler | null = null;
  private _status: ChannelStatusSnapshot;
  private readonly _configId: string;
  private client: ReturnType<typeof createOpenAPI> | null = null;
  private wsClient: ReturnType<typeof createWebsocket> | null = null;
  private stopQrConnect: (() => void) | null = null;
  private useQrFlow: boolean;
  /** Monotonic msg_seq counter for outbound messages (QQ requires unique seq per msg). */
  private _msgSeq = 0;

  constructor(private readonly opts: QqAdapterOptions) {
    this._configId = opts.config.id;
    // Allow QQ_BOT_ENV env var to flip bot APIs into sandbox (test) mode.
    // Default is production (api.bot.qq.com). Set QQ_BOT_ENV=test to use
    // sandbox.api.sgroup.qq.com (matches QQ open platform test bots).
    if (!opts.env) {
      const e = (typeof process !== 'undefined' && process.env?.QQ_BOT_ENV) || '';
      opts.env = (e === 'test' || e === 'sandbox') ? 'test' : 'production';
    }
    this._status = {
      channelId: opts.config.id,
      channelType: 'qq',
      status: 'disabled',
      since: new Date().toISOString(),
    };
    // QR flow is only used when we don't have real credentials yet
    this.useQrFlow = !opts.appId || !opts.appSecret;
  }

  async start(): Promise<void> {
    this.updateStatus({ status: 'starting' });
    try {
      if (this.useQrFlow) {
        this.startQrFlow();
      } else {
        this.startWebSocketFlow();
      }
    } catch (err) {
      this.updateStatus({ status: 'error', error: (err as Error).message });
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'start-failed',
        message: (err as Error).message,
      });
      throw err;
    }
  }

  /**
   * QR-code based first-time login. The user scans the URL with mobile QQ
   * and the connector returns bot credentials. We then update the row in DB
   * with the real appId/appSecret, fetch the bot's display name, and emit
   * a 'connected' event.
   */
  private startQrFlow(): void {
    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'qq',
      kind: 'info',
      message: 'Starting QQ QR login flow (request to q.qq.com)',
    });

    const onSuccess = async (credentials: QrConnectCredentials[]) => {
      const cred = credentials[0];
      if (!cred) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'qq',
          kind: 'error',
          message: 'No credentials returned from QQ scan',
        });
        return;
      }

      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'info',
        message: `QR scan success, got appId=${cred.appId.slice(0, 6)}...`,
      });

      // Fetch bot display name from QQ API
      let displayName = cred.appId;
      try {
        // Use the SAME endpoints as the SDK (which hardcodes these).
        // - getAppAccessToken: always https://api.bot.qq.com/app/getAppAccessToken
        //   (SDK does not switch this URL even in sandbox mode — it's a known quirk)
        // - users/@me: production https://api.bot.qq.com/users/@me
        //              sandbox    https://sandbox.api.sgroup.qq.com/users/@me
        const useSandbox = this.opts.env === 'test';
        const usersBase = useSandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com';
        const tokenResp = await fetch('https://api.bot.qq.com/app/getAppAccessToken', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: cred.appId, clientSecret: cred.appSecret }),
        });
        if (tokenResp.ok) {
          const tokenData = (await tokenResp.json()) as { access_token?: string };
          if (tokenData.access_token) {
            const meResp = await fetch(`${usersBase}/users/@me`, {
              headers: { Authorization: `QQBot ${tokenData.access_token}` },
            });
            if (meResp.ok) {
              const me = (await meResp.json()) as { username?: string; nickname?: string };
              displayName = me.username ?? me.nickname ?? cred.appId;
            } else {
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'qq',
                kind: 'warn',
                message: `users/@me ${meResp.status}: ${await meResp.text().catch(() => '')}`,
              });
            }
          }
        } else {
          this.opts.host.logEvent({
            channelId: this._configId,
            channelType: 'qq',
            kind: 'warn',
            message: `getAppAccessToken ${tokenResp.status}: ${await tokenResp.text().catch(() => '')}`,
          });
        }
      } catch (err) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'qq',
          kind: 'warn',
          message: `Failed to fetch bot display name: ${(err as Error).message}`,
        });
      }

      // Persist to DB + set in-memory config
      this.opts.host.onCredentials?.({
        appId: cred.appId,
        appSecret: cred.appSecret,
        displayName,
      });

      // Now start the WebSocket with the real credentials
      try {
        this.startWebSocketFlowWith(cred.appId, cred.appSecret);
      } catch (err) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'qq',
          kind: 'error',
          message: `WebSocket start after QR failed: ${(err as Error).message}`,
        });
      }
    };

    const onFailure = (err: Error) => {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'error',
        message: `QQ QR login failed: ${err.message}`,
      });
      this.updateStatus({ status: 'error', error: err.message });
      this.errHandler?.(this._configId, err);
    };

    const onQrDisplayed = (url: string) => {
      // Connector gave us a URL; we emit it to the admin via SSE for
      // client-side QR rendering. The URL is something like
      // "https://q.qq.com/qqbot/qrcoder/...".
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'qr-url',
        message: `QQ QR ready (${url.length} chars)`,
        data: { qrUrl: url, qrRawPreview: url.slice(0, 80) + (url.length > 80 ? '...' : '') },
      });
    };

    const onQrExpired = () => {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'qr-expired',
        message: 'QQ QR code expired, refreshing...',
      });
    };

    // startQrConnect returns a stop() function. We don't track it for now;
    // the connector will run until the user scans or process exits.
    this.stopQrConnect = startQrConnect(
      { onSuccess, onFailure, onQrDisplayed, onQrExpired },
      { displayQrCodeToConsole: false, source: 'pi-agent-platform' },
    );
    // Note: startQrConnect doesn't expose an env option, so we always poll
    // q.qq.com (production). If you registered your bot in the sandbox, you'll
    // need to patch the connector or use the production bot for testing.
  }

  /**
   * WebSocket-only start (used when we already have real appId/appSecret).
   */
  private startWebSocketFlow(): void {
    this.startWebSocketFlowWith(this.opts.appId, this.opts.appSecret);
  }

  private startWebSocketFlowWith(appId: string, appSecret: string): void {
    const sandbox = this.opts.env === 'test';
    const intents = [AvailableIntentsEventsEnum.GROUP_AND_C2C_EVENT];

    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'qq',
      kind: 'ws-open-start',
      message: `Starting QQ bot WS: appId=${appId.slice(0, 4)}... (sandbox=${this.opts.env === 'test'})`,
    });

    try {
      // IMPORTANT: SDK has two auth modes.
      //   - `token` mode: pass an access_token directly. SDK sends
      //     "Bot <appID>.<token>" header. Many bots now return 401 with this.
      //   - `secret` mode: pass the appSecret as `secret`. SDK first calls
      //     POST /app/getAppAccessToken to exchange for an access_token,
      //     then sends "QQBot <access_token>" header. SDK auto-refreshes.
      // Use secret mode so SDK handles token lifecycle for us.
      // The SDK type requires `token` (we pass empty string; secret overrides).
      const config = { appID: appId, token: '', secret: appSecret, intents, sandbox };
      this.client = createOpenAPI(config);
      this.wsClient = createWebsocket(config);
    } catch (err) {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'error',
        message: `createOpenAPI/Websocket threw: ${(err as Error).message}`,
      });
      return;
    }

    const ws = this.wsClient as unknown as {
      on: (event: string, handler: (...args: unknown[]) => void) => void;
    };
    const c2cEvent = String(WsEventType.C2C_MESSAGE_CREATE);
    const groupEvent = String(WsEventType.GROUP_MESSAGE_CREATE);
    ws.on(c2cEvent, (payload: unknown) => {
      const { msg } = payload as { msg: unknown };
      this.handleC2C(msg);
    });
    ws.on(groupEvent, (payload: unknown) => {
      const { msg } = payload as { msg: unknown };
      this.handleGroup(msg);
    });
    ws.on('ws', (data: unknown) => {
      const d = data as { eventType: string; eventMsg?: unknown };
      const ev = d.eventType;
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'ws-event',
        message: `ws event: ${ev}`,
        data: { eventMsg: d.eventMsg as unknown },
      });
      if (ev === 'READY' || ev === 'RESUMED') {
        this.updateStatus({ status: 'connected' });
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'qq',
          kind: 'connected',
          message: 'QQ WebSocket connected',
        });
      } else if (ev === 'DISCONNECT') {
        this.updateStatus({ status: 'reconnecting' });
      } else if (ev === 'DEAD') {
        this.updateStatus({ status: 'error', error: 'WebSocket DEAD — restart required' });
      }
    });

    // Patch the SDK's access_token fetch path: qq-bot-sdk uses config.sandbox
    // to switch api.bot.qq.com ↔ sandbox.api.sgroup.qq.com. If the bot was
    // registered in the QQ open platform's TEST env, set QQ_BOT_ENV=test.
    // (connector always uses q.qq.com production for QR scan, but the bot
    //  APIs need to match.)

    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'qq',
      kind: 'info',
      message: 'QQ WebSocket started (waiting for connection event)',
    });
  }

  async stop(): Promise<void> {
    try {
      this.stopQrConnect?.();
      this.stopQrConnect = null;
      this.client = null;
      this.wsClient = null;
      this.updateStatus({ status: 'stopped' });
    } catch (err) {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'qq',
        kind: 'stop-failed',
        message: (err as Error).message,
      });
    }
  }

  isConnected(): boolean {
    return this._status.status === 'connected' && this.wsClient !== null;
  }

  async sendText(target: OutboundTarget, text: string): Promise<string> {
    if (!this.client) throw new Error('adapter not started');
    // QQ c2c postMessage format (verified against q.qq.com API + reference pi-qq-bot):
    //   markdown: { msg_type: 2, markdown: { content: text }, msg_seq: <int> }
    //     — NOTE: msg_type=2 means "markdown" in C2C context, despite the same
    //     code being used for "ark" in other contexts. No `content` field needed.
    //   text    : { msg_type: 0, content: text, msg_seq: <int> }
    //
    // Per-message msg_seq is required; QQ uses it for ordering/dedup. We
    // monotonically increment it within this adapter instance.
    this._msgSeq = (this._msgSeq ?? 0) + 1;
    const msgSeq = this._msgSeq;
    try {
      const result = (await this.client.c2cApi.postMessage(target.chatId, {
        msg_type: 2,
        markdown: { content: text },
        msg_seq: msgSeq,
      })) as { msg_id?: string };
      return String(result?.msg_id ?? `qq-msg-${Date.now()}`);
    } catch (err) {
      // If markdown rejected, retry as plain text (msg_type=0).
      const anyErr = err as { err_code?: number; code?: number; message?: string };
      const code = anyErr?.err_code ?? anyErr?.code;
      if (code && (code === 40034011 || code === 40034021)) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'qq',
          kind: 'warn',
          message: `markdown rejected (${code}), retrying as plain text`,
        });
        this._msgSeq = (this._msgSeq ?? 0) + 1;
        const fallback = (await this.client.c2cApi.postMessage(target.chatId, {
          msg_type: 0,
          content: text,
          msg_seq: this._msgSeq,
        })) as { msg_id?: string };
        return String(fallback?.msg_id ?? `qq-msg-${Date.now()}`);
      }
      throw err;
    }
  }

  async sendImage(target: OutboundTarget, localPath: string, caption?: string): Promise<string> {
    if (!this.client) throw new Error('adapter not started');
    await this.client.c2cApi.postMessage(target.chatId, {
      content: caption ? `[图片] ${caption} (本地路径: ${localPath})` : `[图片] ${localPath}`,
      msg_type: 0,
    });
    return `qq-img-${Date.now()}`;
  }

  async sendFile(target: OutboundTarget, localPath: string, caption?: string): Promise<string> {
    if (!this.client) throw new Error('adapter not started');
    await this.client.c2cApi.postMessage(target.chatId, {
      content: caption ? `[文件] ${caption} (本地路径: ${localPath})` : `[文件] ${localPath}`,
      msg_type: 0,
    });
    return `qq-file-${Date.now()}`;
  }

  getSystemPromptContext(_channelId: ChannelId, _chatId: ExternalChatId): string {
    return QQ_SYSTEM_PROMPT;
  }

  onMessage(handler: ChannelMessageHandler): void {
    this.msgHandler = handler;
  }

  onError(handler: ChannelErrorHandler): void {
    this.errHandler = handler;
  }

  onStatusChange(handler: ChannelStatusHandler): void {
    this.statusHandler = handler;
  }

  getStatus(): ChannelStatusSnapshot {
    return this._status;
  }

  private handleC2C(msg: unknown): void {
    if (!this.msgHandler) return;
    const m = msg as {
      author?: { user_openid?: string };
      content?: string;
      timestamp?: string;
      attachments?: Array<{ content_type: string; url: string }>;
    };
    const openId = m.author?.user_openid ?? '';
    this.msgHandler({
      channelId: this._configId,
      channelType: 'qq',
      chatId: openId,
      isGroup: false,
      senderId: openId,
      text: m.content ?? '',
      timestamp: m.timestamp ?? new Date().toISOString(),
      images: m.attachments
        ?.filter((a) => a.content_type === 'image')
        .map((a) => ({ localPath: a.url, mimeType: 'image/jpeg' })),
    });
  }

  private handleGroup(msg: unknown): void {
    if (!this.msgHandler) return;
    const m = msg as {
      group_openid?: string;
      author?: { user_openid?: string; member_openid?: string };
      content?: string;
      timestamp?: string;
    };
    const groupOpenId = m.group_openid ?? '';
    const senderId = m.author?.member_openid ?? m.author?.user_openid ?? '';
    this.msgHandler({
      channelId: this._configId,
      channelType: 'qq',
      chatId: groupOpenId,
      isGroup: true,
      senderId,
      text: m.content ?? '',
      timestamp: m.timestamp ?? new Date().toISOString(),
    });
  }

  private updateStatus(patch: Partial<ChannelStatusSnapshot>): void {
    this._status = {
      ...this._status,
      ...patch,
      channelId: this._configId,
      channelType: 'qq',
      since: new Date().toISOString(),
    };
    this.statusHandler?.(this._status);
  }
}