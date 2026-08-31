/**
 * channel-wechat integration tests.
 *
 * Two layers:
 *  - Unit tests for routes (CRUD via Hono test client, no real SDK)
 *  - Unit tests for WechatAdapter — mocked @wechatbot/wechatbot module via vi.mock
 *  - Integration test: full route → start (mock bot) → message arrival → reply dispatched
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createWechatRoutes } from '../routes.js';
import { WechatAdapter, wrapQrImageContent } from '../adapter.js';
import type { ChannelAdapter, ChannelHost, ChannelConfig, InboundMessage, ChannelMessageHandler } from '@pi-agent-platform/channel-types';

// ─── Mock @wechatbot/wechatbot via vi.mock ───────────────────────────────────
const { mockBot } = vi.hoisted(() => {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const bot = {
    onMessage: (h: ChannelMessageHandler) => { (handlers.message ??= []).push(h as never); return bot; },
    on: (event: string, h: (...args: unknown[]) => void) => { (handlers[event] ??= []).push(h); return bot; },
    login: vi.fn(async () => ({ appId: 'mock-app-id', openId: 'mock-open-id' })),
    start: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    getCredentials: vi.fn(() => ({ appId: 'mock', openId: 'mock' })),
    _handlers: handlers,
    _triggerMessage: (msg: unknown) => handlers.message?.forEach((h) => h(msg)),
    _triggerError: (err: unknown) => handlers.error?.forEach((h) => h(err)),
  };
  return { mockBot: bot };
});

vi.mock('@wechatbot/wechatbot', () => ({
  WeChatBot: vi.fn(() => mockBot),
}));

// ─── Test helpers ────────────────────────────────────────────────────────────
function makeTestHost() {
  const configs = new Map<string, ChannelConfig>();
  const events: unknown[] = [];
  const host: ChannelHost = {
    executeMigration: () => undefined,
    query: (_sql: string) => [],
    exec: () => undefined,
    registerRoutes: () => undefined,
    getChannelConfig: (id) => configs.get(id) ?? null,
    listChannelConfigs: () => Array.from(configs.values()),
    updateChannelConfig: (c) => { configs.set(c.id, c); },
    createChannelConfig: (input) => {
      // Respect the id passed by the caller (e.g. /qr-login passes its own id)
      const id = (input as { id?: string }).id ?? crypto.randomUUID();
      const c = { ...input, id } as ChannelConfig;
      configs.set(id, c);
      return c;
    },
    deleteChannelConfig: (id) => { configs.delete(id); },
    getSessionMeta: () => null,
    touchSession: () => undefined,
    setCurrentSession: () => undefined,
    getCurrentSession: () => null,
    seedSessionFromConfig: () => undefined,
    prompt: async () => undefined,
    killWorker: async () => undefined,
    handleInbound: async () => undefined,
    parseCommand: (t) => t.trim().startsWith('/') ? { kind: 'command', name: t.slice(1), args: '' } : { kind: 'text', text: t },
    runBuiltinCommand: async () => null,
    onChannelLog: () => undefined,
    logEvent: (e) => { events.push(e); },
  };
  return { host, configs, events };
}

// ─── Routes tests (no real SDK) ──────────────────────────────────────────────
describe(' routes CRUD', () => {
  let host: ReturnType<typeof makeTestHost>['host'];
  let app: Hono;
  let activeAdapters: Map<string, ChannelAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    const t = makeTestHost();
    host = t.host;
    const { router, state } = createWechatRoutes(host);
    activeAdapters = state.activeAdapters;
    app = new Hono();
    app.route('/api/im/wechat', router);
  });

  it('POST /channels creates a channel', async () => {
    const res = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: '客服小助手',
        defaultAgentId: 'agent-1',
        storageDir: '/tmp/wechat/clawbot1',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as ChannelConfig;
    expect(body.type).toBe('wechat');
    expect(body.displayName).toBe('客服小助手');
  });

  it('POST /channels with missing field returns 400', async () => {
    const res = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'test' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /channels returns the list', async () => {
    await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'A', defaultAgentId: 'agent-1', storageDir: '/tmp/a',
      }),
    });
    const res = await app.request('/api/im/wechat/channels');
    const body = await res.json() as { channels: ChannelConfig[] };
    expect(body.channels.length).toBe(1);
    expect(body.channels[0]!.type).toBe('wechat');
  });

  it('POST /channels/:id/start creates real WechatAdapter, calls login+start', async () => {
    const createRes = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'test', defaultAgentId: 'agent-1', storageDir: '/tmp/test',
      }),
    });
    const created = await createRes.json() as ChannelConfig;
    const startRes = await app.request(`/api/im/wechat/channels/${created.id}/start`, { method: 'POST' });
    expect(startRes.status).toBe(200);
    expect(mockBot.login).toHaveBeenCalledOnce();
    expect(mockBot.start).toHaveBeenCalledOnce();
    expect(activeAdapters.has(created.id)).toBe(true);
  });

  it('POST /channels/:id/start twice returns 409', async () => {
    const createRes = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'test', defaultAgentId: 'agent-1', storageDir: '/tmp/test',
      }),
    });
    const created = await createRes.json() as ChannelConfig;
    await app.request(`/api/im/wechat/channels/${created.id}/start`, { method: 'POST' });
    const res = await app.request(`/api/im/wechat/channels/${created.id}/start`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('POST /qr-login creates row with auto storageDir and returns channelId', async () => {
    const res = await app.request('/api/im/wechat/qr-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'qr-bot', defaultAgentId: 'agent-1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { channelId: string };
    expect(body.channelId).toMatch(/^[0-9a-f-]+$/);
    // Verify the row was created with auto-storageDir
    const detail = host.getChannelConfig(body.channelId);
    expect(detail?.displayName).toBe('qr-bot');
    expect((detail?.extra as { storageDir?: string })?.storageDir).toBeTruthy();
  });

  it('POST /qr-login validates required fields', async () => {
    const res = await app.request('/api/im/wechat/qr-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'x' }), // missing defaultAgentId
    });
    expect(res.status).toBe(400);
  });

  it('POST /channels/:id/start-qr triggers SDK login (mocked bot)', async () => {
    // First create via qr-login
    const createRes = await app.request('/api/im/wechat/qr-login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'start-qr-bot', defaultAgentId: 'agent-1' }),
    });
    const created = await createRes.json() as { channelId: string };

    const res = await app.request(`/api/im/wechat/channels/${created.channelId}/start-qr`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    // adapter should be in active set after a tick (start is async)
    await new Promise((r) => setTimeout(r, 50));
    expect(activeAdapters.has(created.channelId)).toBe(true);
  });

  it('POST /channels/:id/stop stops the running adapter', async () => {
    const createRes = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'test', defaultAgentId: 'agent-1', storageDir: '/tmp/test',
      }),
    });
    const created = await createRes.json() as ChannelConfig;
    await app.request(`/api/im/wechat/channels/${created.id}/start`, { method: 'POST' });
    const res = await app.request(`/api/im/wechat/channels/${created.id}/stop`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(activeAdapters.has(created.id)).toBe(false);
  });

  it('DELETE /channels/:id removes the config', async () => {
    const createRes = await app.request('/api/im/wechat/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'test', defaultAgentId: 'agent-1', storageDir: '/tmp/test',
      }),
    });
    const created = await createRes.json() as ChannelConfig;
    const res = await app.request(`/api/im/wechat/channels/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(host.getChannelConfig(created.id)).toBeNull();
  });

  it('GET /channels/:id with unknown id returns 404', async () => {
    const res = await app.request('/api/im/wechat/channels/non-existent');
    expect(res.status).toBe(404);
  });
});

// ─── wrapQrImageContent unit tests ─────────────────────────────────────────
describe('wrapQrImageContent', () => {
  it('passes through data: URLs as-is', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAA==';
    expect(wrapQrImageContent(dataUrl)).toBe(dataUrl);
  });

  it('passes through http(s) URLs as-is', () => {
    const url = 'https://ilinkai.weixin.qq.com/qrcode/abc.png';
    expect(wrapQrImageContent(url)).toBe(url);
  });

  it('passes through relative URLs as-is', () => {
    expect(wrapQrImageContent('/api/qr/abc.png')).toBe('/api/qr/abc.png');
  });

  it('prefixes raw base64 with data:image/png;base64', () => {
    const raw = 'iVBORw0KGgoAAANSUhEUgAAAAUA';
    const wrapped = wrapQrImageContent(raw);
    expect(wrapped).toBe(`data:image/png;base64,${raw}`);
  });

  it('strips whitespace inside base64', () => {
    const raw = 'iVBORw0KGgo\nAAANSUhEUg==';
    expect(wrapQrImageContent(raw)).toBe('data:image/png;base64,iVBORw0KGgoAAANSUhEUg==');
  });

  it('returns raw value unchanged if it is not a recognizable format', () => {
    const weird = 'not-a-url-and-not-base64-$$$';
    expect(wrapQrImageContent(weird)).toBe(weird);
  });

  it('returns empty string unchanged', () => {
    expect(wrapQrImageContent('')).toBe('');
  });
});

// ─── WechatAdapter tests with mocked SDK ─────────────────────────────────────
describe('WechatAdapter (real SDK, mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBot._handlers.message = [];
    mockBot._handlers.error = [];
  });

  it('start() invokes bot.login + bot.start, transitions to connected (async)', async () => {
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/test-adapter',
    });
    await adapter.start();
    // start() is now fire-and-forget; the SDK's login() + start() chain runs
    // asynchronously. Wait a tick for the microtask to flush.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockBot.login).toHaveBeenCalledOnce();
    expect(mockBot.start).toHaveBeenCalledOnce();
    expect(adapter.getStatus().status).toBe('connected');
    expect(adapter.isConnected()).toBe(true);
  });

  it('start() failure transitions to error state (async login rejected)', async () => {
    mockBot.login.mockRejectedValueOnce(new Error('qr-expired'));
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    // start() no longer awaits login() — it returns immediately. The rejected
    // promise from login() is caught inside the adapter and updates status to
    // 'error'. We wait a tick for the microtask to flush.
    await adapter.start();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapter.getStatus().status).toBe('error');
    expect(adapter.getStatus().error).toBe('qr-expired');
  });

  it('stop() clears bot reference and transitions to stopped', async () => {
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    await adapter.start();
    await adapter.stop();
    expect(adapter.isConnected()).toBe(false);
    expect(adapter.getStatus().status).toBe('stopped');
  });

  it('inbound message from SDK → adapter.onMessage handler dispatched', async () => {
    const received: InboundMessage[] = [];
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    adapter.onMessage(async (msg) => { received.push(msg); });
    await adapter.start();

    // Simulate SDK firing an incoming message
    mockBot._triggerMessage({
      userId: 'openid-123',
      text: 'hello',
      type: 'text',
      timestamp: new Date(),
      images: [], voices: [], files: [], videos: [],
      raw: {},
      _contextToken: 'tok',
    });
    expect(received.length).toBe(1);
    expect(received[0]!.chatId).toBe('openid-123');
    expect(received[0]!.text).toBe('hello');
    expect(received[0]!.isGroup).toBe(false);
    expect(received[0]!.channelType).toBe('wechat');
  });

  it('SDK error event → adapter error handler dispatched', async () => {
    const errors: Array<{ channelId: string; err: Error }> = [];
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    adapter.onError((channelId, err) => { errors.push({ channelId, err }); });
    await adapter.start();

    mockBot._triggerError(new Error('ws-disconnected'));
    expect(errors.length).toBe(1);
    expect(errors[0]!.err.message).toBe('ws-disconnected');
    expect(adapter.getStatus().status).toBe('error');
  });

  it('sendText() invokes bot.send with text content', async () => {
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    await adapter.start();
    await adapter.sendText({ channelId: 't', chatId: 'openid-1' }, 'reply text');
    expect(mockBot.send).toHaveBeenCalledWith('openid-1', { text: 'reply text' });
  });

  it('getSystemPromptContext returns WeChat rules', () => {
    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    const ctx = adapter.getSystemPromptContext('t', 'openid-1');
    expect(ctx).toContain('WeChat');
    expect(ctx).toMatch(/mobile/i);
  });

  it('sendImage/sendFile read local file and call bot.send', async () => {
    const fs = await import('node:fs/promises');
    await fs.writeFile('/tmp/test-image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile('/tmp/test-doc.pdf', Buffer.from('%PDF-1.4\n'));

    const adapter = new WechatAdapter({
      config: { id: 't', type: 'wechat', displayName: 't', enabled: true },
      host: { logEvent: () => undefined },
      storageDir: '/tmp/t',
    });
    await adapter.start();
    await adapter.sendImage({ channelId: 't', chatId: 'openid-1' }, '/tmp/test-image.png', 'cap');
    await adapter.sendFile({ channelId: 't', chatId: 'openid-1' }, '/tmp/test-doc.pdf');

    expect(mockBot.send).toHaveBeenCalledWith('openid-1', expect.objectContaining({ image: expect.any(Buffer), caption: 'cap' }));
    expect(mockBot.send).toHaveBeenCalledWith('openid-1', expect.objectContaining({ file: expect.any(Buffer), fileName: 'test-doc.pdf' }));

    await fs.unlink('/tmp/test-image.png').catch(() => undefined);
    await fs.unlink('/tmp/test-doc.pdf').catch(() => undefined);
  });
});