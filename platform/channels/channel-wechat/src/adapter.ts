/**
 * WeChat real adapter — wraps @wechatbot/wechatbot (iLink ClawBot SDK).
 *
 * SDK API summary (see spike notes):
 *   new WeChatBot(options)        → bot
 *   bot.login({ force, callbacks }) → QR scan login (AWAIT this — blocks until scan)
 *   bot.start()                   → start message polling (after login)
 *   bot.onMessage(msg => {...})   → register inbound handler
 *   bot.send(userId, content)     → send content (text/image/file/url)
 *   bot.reply(msg, content)       → reply in context
 *   bot.stop()                    → graceful shutdown
 *
 * IncomingMessage fields:
 *   userId  — sender's user ID
 *   text    — extracted text content (or "[image]" for media-only)
 *   type    — 'text' | 'image' | 'voice' | 'file' | 'video'
 *   images / voices / files / videos — media arrays
 *
 * Auto-reconnect: SDK has built-in polling + reconnect (HTTP long-poll).
 *
 * Reference: reference/projects/personal-agent-manage/reference/projects/pi-wechat-bot
 * The reference uses `await bot.login({force: true, callbacks})` then `bot.start().catch(...)`.
 * We follow the exact same pattern.
 *
 * Dev mock: set WECHAT_MOCK_QR=1 to skip the real SDK and emit synthetic events.
 */

import { WeChatBot, type IncomingMessage } from '@wechatbot/wechatbot';
import { WECHAT_MOCK_QR } from './mock-config.js';
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
import { WECHAT_SYSTEM_PROMPT } from './system-prompt.js';

export interface WechatAdapterOptions {
  config: ChannelConfig;
  host: {
    logEvent: (e: { channelId: ChannelId; channelType: string; kind: string; message?: string; data?: Record<string, unknown> }) => void;
    /** Ensure a session exists for the given chat, returning sessionId. */
    ensureSession?: (channelId: string, chatId: string) => Promise<string>;
    /** Upload raw bytes to attachment-store. */
    uploadAttachment?: (sessionId: string, input: { bytes: Uint8Array; mimeType: string; filename?: string }) => Promise<{ id: string; mimeType: string; sizeBytes: number }>;
  };
  /** storage directory (per-channel). Required for iLink ClawBot. */
  storageDir: string;
  /**
   * Whether to force the QR flow even when stored credentials exist.
   * - false (default): if storageDir has saved login, reuse it silently — no QR needed.
   *   Falls back to QR if saved login is missing or invalid.
   * - true: always emit a QR URL (use for first-time setup or after `clearAll()`).
   */
  force?: boolean;
}

/**
 * Wrap iLink's qrcode_img_content into something the web admin can render
 * with `<img src>` regardless of the SDK's return format.
 *
 * - "data:image/..." → use as-is
 * - "http://..." or "https://..." or "/" → use as-is (image URL)
 * - anything else (raw base64) → assume PNG and prefix with data URL header
 */
export function wrapQrImageContent(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  if (/^(https?:|\/)/i.test(trimmed)) return trimmed;
  // Heuristic: if it looks like base64 (alnum + / + =) prefix with PNG data URL
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return `data:image/png;base64,${trimmed.replace(/\s+/g, '')}`;
  }
  // Fallback: return as-is (admin can see the preview and debug)
  return trimmed;
}

/**
 * Generate a 1×1 transparent PNG as base64. Used in mock mode so the web admin
 * can render "something" in the QR slot while real iLink is unavailable.
 */
function generateMockQrPng(): string {
  // 1×1 transparent PNG (67 bytes)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return `data:image/png;base64,${pngBase64}`;
}

/** Magic-byte MIME sniffing for common file types. Returns null if unrecognized. */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  // WebP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  // PDF
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'application/pdf';
  return null;
}

/** Real WeChat adapter backed by @wechatbot/wechatbot. */
export class WechatAdapter implements ChannelAdapter {
  readonly type = 'wechat' as const;

  private msgHandler: ChannelMessageHandler | null = null;
  private errHandler: ChannelErrorHandler | null = null;
  private statusHandler: ChannelStatusHandler | null = null;
  private _status: ChannelStatusSnapshot;
  private readonly _configId: string;
  private bot: WeChatBot | null = null;
  private mockTimers: NodeJS.Timeout[] = [];
  /**
   * Cache of last IncomingMessage per chatId so we can use bot.reply() (which
   * needs the original message for context_token) instead of bot.send() (which
   * requires the userId to already be in the SDK's contextStore, which can
   * be empty after restart).
   * key: msg.userId (from_user_id), value: the most recent IncomingMessage.
   */
  private lastIncomingByChatId = new Map<string, IncomingMessage>();

  constructor(private readonly opts: WechatAdapterOptions) {
    this._configId = opts.config.id;
    this._status = {
      channelId: opts.config.id,
      channelType: 'wechat',
      status: 'disabled',
      since: new Date().toISOString(),
    };
  }

  async start(): Promise<void> {
    this.updateStatus({ status: 'starting' });
    if (WECHAT_MOCK_QR) {
      await this.startMockFlow();
      return;
    }

    // Clear stale context_tokens on each (re)start so the SDK has to fetch a
    // fresh one from iLink on the next inbound. Without this, a context_token
    // cached from a previous server lifetime can be errcode=-14 session
    // timeout and silently break reply sending.
    try {
      // Synchronous rm so adapter.start() can run the rest inline (some
      // route handlers fire-and-forget start, and tests assert that login was
      // called immediately).
      const fsSync = require('node:fs');
      try { fsSync.rmSync(`${this.opts.storageDir}/context_tokens.json`, { force: true }); } catch {}
    } catch (err) {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'warn',
        message: `failed to clear stale context_tokens: ${(err as Error).message}`,
      });
    }

    // ── Step 1: construct bot ──────────────────────────────────────────
    this.bot = new WeChatBot({
      storage: 'file',
      storageDir: this.opts.storageDir,
      logLevel: 'debug',
    });

    // ── Step 2: register inbound + error handlers BEFORE login ────────
    // Reference: same — `bot.onMessage` registered before `bot.login`.
    this.bot.onMessage((msg) => this.handleIncoming(msg));

    this.bot.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      // iLink sends errcode=-14 'session timeout' when the bot session has
      // expired on the iLink side. The SDK's poller only re-logs-in on its
      // OWN getUpdates failures — but our manual sendRaw bypass returns the
      // same string here. Surface it loudly so the admin knows to manually
      // Stop + Start (which forces a fresh login flow).
      const msg = (error as { message?: string }).message ?? String(err);
      if (/session timeout|errcode[\s:=-]+-?14/i.test(msg)) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'wechat',
          kind: 'warn',
          message: 'iLink session expired — please Stop then Start the channel to re-login (this also re-emits a fresh QR for scanning)',
        });
      }
      this.updateStatus({ status: 'error', error: error.message });
      this.errHandler?.(this._configId, error);
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'error',
        message: error.message,
      });
    });

    // ── Step 3: await login({force: true, callbacks}) ─────────────────
    // CRITICAL: must pass `force: true` to bypass stored creds (otherwise
    // SDK silently reuses old creds and onQrUrl never fires). Must pass
    // `callbacks` here (NOT in constructor) — SDK only reads callbacks
    // from this argument.
    //
    // Login blocks until the user scans + confirms in WeChat. The HTTP
    // /start-qr endpoint awaits this whole `start()` so the admin dialog
    // can show the SSE events in real time. Reference uses the same
    // pattern (pi-wechat-bot/src/index.ts:175-185).
    let creds;
    try {
      creds = await this.bot.login({
        force: this.opts.force ?? false,
        callbacks: {
          onQrUrl: (rawContent: string) => {
            // SDK's `qrcode_img_content` from iLink API. Format can be:
            //   - URL string (scan URL like https://liteapp.weixin.qq.com/q/...)
            //   - data URL (data:image/png;base64,...)
            //   - raw base64 PNG
            const wrapped = wrapQrImageContent(rawContent);
            const preview = rawContent.length > 80
              ? rawContent.slice(0, 80) + `... [${rawContent.length} chars]`
              : rawContent;
            this.opts.host.logEvent({
              channelId: this._configId,
              channelType: 'wechat',
              kind: 'qr-url',
              message: `WeChat QR ready to scan (${rawContent.length} chars)`,
              data: { qrUrl: wrapped, qrRawPreview: preview },
            });
          },
          onScanned: () => {
            this.opts.host.logEvent({
              channelId: this._configId,
              channelType: 'wechat',
              kind: 'qr-scanned',
              message: 'WeChat QR scanned, awaiting confirmation',
            });
          },
          onExpired: () => {
            this.opts.host.logEvent({
              channelId: this._configId,
              channelType: 'wechat',
              kind: 'qr-expired',
              message: 'WeChat QR expired — requesting a new one',
            });
          },
        },
      });
    } catch (err) {
      // Login failed (network, iLink down, etc.). Surface to status + logEvent,
      // but DON'T re-throw — caller (/start-qr HTTP route) expects start() to
      // resolve normally so the admin SSE can still see the error event.
      this.updateStatus({ status: 'error', error: (err as Error).message });
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'start-failed',
        message: `login failed: ${(err as Error).message}`,
      });
      return;
    }

    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'wechat',
      kind: 'info',
      message: `WeChat logged in: accountId=${creds.accountId} userId=${creds.userId}`,
    });

    // ── Step 4: start polling AFTER login ───────────────────────────
    // bot.start() requires logged-in creds (otherwise throws). Reference
    // uses fire-and-forget with .catch() — we do the same.
    this.bot.start().catch((err: Error) => {
      this.updateStatus({ status: 'error', error: err.message });
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'error',
        message: `start() failed: ${err.message}`,
      });
    });

    this.updateStatus({ status: 'connected' });
    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'wechat',
      kind: 'connected',
      message: 'WeChat bot connected',
    });
  }

  private async startMockFlow(): Promise<void> {
    this.opts.host.logEvent({
      channelId: this._configId,
      channelType: 'wechat',
      kind: 'info',
      message: '[MOCK] WECHAT_MOCK_QR=1 — emitting synthetic events',
    });
    const mockQr = generateMockQrPng();
    this.mockTimers.push(setTimeout(() => {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'qr-url',
        message: '[MOCK] WeChat QR ready to scan',
        data: { qrUrl: mockQr, qrRawPreview: 'mock 1x1 PNG (synthetic)' },
      });
    }, 1000));
    this.mockTimers.push(setTimeout(() => {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'qr-scanned',
        message: '[MOCK] QR scanned',
      });
    }, 4000));
    this.mockTimers.push(setTimeout(() => {
      this.updateStatus({ status: 'connected' });
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'connected',
        message: '[MOCK] Login successful (simulated)',
      });
    }, 6000));
  }

  async stop(): Promise<void> {
    this.mockTimers.forEach((t) => clearTimeout(t));
    this.mockTimers = [];
    try {
      if (this.bot) {
        this.bot.stop();
      }
      this.bot = null;
      this.updateStatus({ status: 'stopped' });
    } catch (err) {
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'stop-failed',
        message: (err as Error).message,
      });
    }
  }

  isConnected(): boolean {
    return this._status.status === 'connected' && this.bot !== null;
  }

  async sendText(target: OutboundTarget, text: string): Promise<string> {
    if (!this.bot) throw new Error('adapter not started');
    const original = this.lastIncomingByChatId.get(target.chatId);

    // Pre-flight: ping session with sendTyping to keep iLink session alive.
    // The SDK caches typing_ticket for 24h, so this usually succeeds even
    // when context_token is stale.
    try {
      await this.bot.sendTyping(target.chatId);
    } catch {
      // Typing may fail with errcode -14 if session is truly dead. The
      // subsequent bot.reply / bot.send will surface the same error.
    }

    // SDK quick-start pattern (https://www.wechatbot.dev/zh/nodejs):
    //   bot.onMessage(async (msg) => {
    //     await bot.sendTyping(msg.userId)
    //     await bot.reply(msg, `Echo: ${msg.text}`)
    //   })
    // We mirror this exactly. bot.reply(msg, content) automatically uses the
    // original message's _contextToken and updates contextStore internally.
    try {
      if (original) {
        await this.bot.reply(original, { text });
      } else {
        // No original msg cached (system-initiated send) — bot.send needs
        // contextStore to already have the token.
        await this.bot.send(target.chatId, { text });
      }
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'info',
        message: `wechat reply sent (length=${text.length})`,
      });
      return original !== undefined ? `wechat-reply-${Date.now()}` : `wechat-sent-${Date.now()}`;
    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      const isSessionTimeout = /session.?timeout|errcode[\s:=]+-?14/i.test(errMsg);
      
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'error',
        message: `sendText failed: ${errMsg}${isSessionTimeout ? ' (session timeout detected)' : ''}`,
      });

      // Session timeout detected — try to re-login and retry once
      if (isSessionTimeout && !this._reconnecting) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'wechat',
          kind: 'info',
          message: 'Attempting auto re-login due to session timeout...',
        });
        try {
          await this.reconnect();
          // Retry the send after re-login
          if (original) {
            await this.bot!.reply(original, { text });
          } else {
            await this.bot!.send(target.chatId, { text });
          }
          this.opts.host.logEvent({
            channelId: this._configId,
            channelType: 'wechat',
            kind: 'info',
            message: `wechat reply sent after re-login (length=${text.length})`,
          });
          return original !== undefined ? `wechat-reply-${Date.now()}` : `wechat-sent-${Date.now()}`;
        } catch (retryErr) {
          this.opts.host.logEvent({
            channelId: this._configId,
            channelType: 'wechat',
            kind: 'error',
            message: `sendText retry after re-login failed: ${(retryErr as Error).message}`,
          });
          throw retryErr;
        }
      }
      throw err;
    }
  }

  private _reconnecting = false;

  private async reconnect(): Promise<void> {
    if (this._reconnecting) return;
    this._reconnecting = true;
    try {
      // Clear stale context_tokens
      const fsSync = require('node:fs');
      try { fsSync.rmSync(`${this.opts.storageDir}/context_tokens.json`, { force: true }); } catch {}

      // Stop existing bot
      if (this.bot) {
        try { this.bot.stop(); } catch {}
        this.bot = null;
      }

      this.updateStatus({ status: 'starting' });

      // Create new bot instance
      this.bot = new WeChatBot({
        storage: 'file',
        storageDir: this.opts.storageDir,
        logLevel: 'debug',
      });

      // Re-register handlers
      this.bot.onMessage((msg) => this.handleIncoming(msg));
      this.bot.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.updateStatus({ status: 'error', error: error.message });
        this.errHandler?.(this._configId, error);
      });

      // Re-login — try stored creds first (force: false), only QR if that fails
      try {
        await this.bot.login({
          force: false,
          callbacks: {
            onQrUrl: (rawContent: string) => {
              const wrapped = wrapQrImageContent(rawContent);
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'qr-url',
                message: `WeChat QR ready to scan (${rawContent.length} chars)`,
                data: { qrUrl: wrapped },
              });
            },
            onScanned: () => {
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'qr-scanned',
                message: 'WeChat QR scanned, awaiting confirmation',
              });
            },
          },
        });
      } catch (loginErr) {
        // Stored creds failed, try force QR
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'wechat',
          kind: 'info',
          message: `Stored login failed, trying QR: ${(loginErr as Error).message}`,
        });
        await this.bot.login({
          force: true,
          callbacks: {
            onQrUrl: (rawContent: string) => {
              const wrapped = wrapQrImageContent(rawContent);
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'qr-url',
                message: `WeChat QR ready to scan (${rawContent.length} chars)`,
                data: { qrUrl: wrapped },
              });
            },
            onScanned: () => {
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'qr-scanned',
                message: 'WeChat QR scanned, awaiting confirmation',
              });
            },
          },
        });
      }

      // Start polling
      this.bot.start().catch((err: Error) => {
        this.updateStatus({ status: 'error', error: err.message });
      });

      this.updateStatus({ status: 'connected' });
      this.opts.host.logEvent({
        channelId: this._configId,
        channelType: 'wechat',
        kind: 'connected',
        message: 'WeChat bot reconnected after session timeout',
      });
    } finally {
      this._reconnecting = false;
    }
  }

  async sendImage(target: OutboundTarget, localPath: string, caption?: string): Promise<string> {
    if (!this.bot) throw new Error('adapter not started');
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(localPath);
    await this.bot.send(target.chatId, { image: data, caption });
    return `wechat-img-${Date.now()}`;
  }

  async sendFile(target: OutboundTarget, localPath: string, caption?: string): Promise<string> {
    if (!this.bot) throw new Error('adapter not started');
    const fs = await import('node:fs/promises');
    const data = await fs.readFile(localPath);
    const fileName = localPath.split(/[\\/]/).pop() ?? 'file';
    await this.bot.send(target.chatId, { file: data, fileName, caption });
    return `wechat-file-${Date.now()}`;
  }

  getSystemPromptContext(_channelId: ChannelId, _chatId: ExternalChatId): string {
    return WECHAT_SYSTEM_PROMPT;
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

  private handleIncoming(msg: IncomingMessage): void {
    if (!this.msgHandler) return;
    // Cache so adapter.sendText() can use bot.reply() with the original
    // message (preserves context_token).
    this.lastIncomingByChatId.set(msg.userId, msg);

    // Show "typing..." indicator to user while agent processes the message.
    // Fire-and-forget — don't block inbound handling on typing API.
    this.bot?.sendTyping(msg.userId).catch(() => {});

    // Process attachments: download → upload → build placeholder text
    void this.processAttachmentsAndForward(msg);
  }

  private async processAttachmentsAndForward(msg: IncomingMessage): Promise<void> {
    if (!this.msgHandler) return;
    let text = msg.text;

    const hasAttachments = (msg.images && msg.images.length > 0)
      || (msg.files && msg.files.length > 0);

    if (hasAttachments && this.bot && this.opts.host.uploadAttachment && this.opts.host.ensureSession) {
      try {
        const sessionId = await this.opts.host.ensureSession(this._configId, msg.userId);

        // Download images via SDK MediaDownloader
        if (msg.images) {
          for (const img of msg.images) {
            if (!img.media) continue;
            try {
              const buf = await this.bot.downloader.download(img.media, img.aeskey);
              if (!buf || buf.length === 0) continue;
              const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
              const mimeType = sniffMime(bytes) ?? 'image/jpeg';
              const result = await this.opts.host.uploadAttachment!(sessionId, {
                bytes,
                mimeType,
              });
              text += ` [pi-attachment:${result.id}]`;
            } catch (err) {
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'warn',
                message: `image download failed: ${(err as Error).message}`,
              });
            }
          }
        }

        // Download files via SDK MediaDownloader
        if (msg.files) {
          for (const f of msg.files) {
            if (!f.media) continue;
            try {
              const buf = await this.bot.downloader.download(f.media);
              if (!buf || buf.length === 0) continue;
              const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
              const mimeType = sniffMime(bytes) ?? 'application/octet-stream';
              const result = await this.opts.host.uploadAttachment!(sessionId, {
                bytes,
                mimeType,
                filename: f.fileName,
              });
              text += ` [pi-attachment:${result.id}]`;
            } catch (err) {
              this.opts.host.logEvent({
                channelId: this._configId,
                channelType: 'wechat',
                kind: 'warn',
                message: `file download failed: ${(err as Error).message}`,
              });
            }
          }
        }
      } catch (err) {
        this.opts.host.logEvent({
          channelId: this._configId,
          channelType: 'wechat',
          kind: 'warn',
          message: `session creation failed for attachments: ${(err as Error).message}`,
        });
      }
    }

    this.msgHandler({
      channelId: this._configId,
      channelType: 'wechat',
      chatId: msg.userId,
      isGroup: false,
      senderId: msg.userId,
      text,
      timestamp: msg.timestamp.toISOString(),
    });
  }

  private updateStatus(patch: Partial<ChannelStatusSnapshot>): void {
    this._status = {
      ...this._status,
      ...patch,
      channelId: this._configId,
      channelType: 'wechat',
      since: new Date().toISOString(),
    };
    this.statusHandler?.(this._status);
  }
}