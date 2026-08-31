/**
 * QrLoginDialog component tests (new: setup form + scan flow).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
import QrLoginDialog from '../QrLoginDialog.vue';

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(kind: string, h: (e: MessageEvent) => void) {
    if (!this.listeners.has(kind)) this.listeners.set(kind, []);
    this.listeners.get(kind)!.push(h);
  }
  close() { this.closed = true; }
  _trigger(kind: string, data: unknown) {
    const e = { data: JSON.stringify(data) } as MessageEvent;
    if (kind === 'message' && this.onmessage) this.onmessage(e);
    this.listeners.get(kind)?.forEach((h) => h(e));
  }
}

(globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;

// Mock fetch (apiFetch goes through window.__channelAdminHost.apiFetch)
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => [],
});
(globalThis as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

function setupHost(): void {
  (window as unknown as {
    __channelAdminHost: {
      apiFetch: (method: string, path: string, body?: unknown) => Promise<unknown>;
      showToast: (opts: { message: string; variant?: string }) => void;
      showConfirmDialog: (opts: { title: string; message: string }) => Promise<boolean>;
      useI18n: () => { t: (k: string) => string };
    };
  }).__channelAdminHost = {
    apiFetch: mockFetch,
    showToast: () => undefined,
    showConfirmDialog: async () => true,
    useI18n: () => ({ t: (k) => k }),
  };
}

describe('QrLoginDialog (setup + scan flow)', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    mockFetch.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      // Default agents list with a couple of entries so v-model= tests work
      json: async () => [
        { id: 'agent-1', name: 'Agent 1', model: 'test-model', description: 'test' },
        { id: 'a1', name: 'A1', model: 'm', description: '' },
      ],
    });
    setupHost();
    // Clear any leftover DOM from previous test
    document.body.innerHTML = '';
  });
  afterEach(async () => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    // Stop any lingering MockEventSource
    MockEventSource.instances.forEach((es) => es.close());
    MockEventSource.instances = [];
  });

  it('renders setup form when open=true (wechat)', async () => {
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    expect(document.body.querySelector('.setup-form')).not.toBeNull();
    expect(document.body.querySelector('input[placeholder*="客服"]')).not.toBeNull();
    expect(document.body.querySelector('select')).not.toBeNull();
    wrapper.unmount();
  });

  it('renders Agent dropdown for both channels', async () => {
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'qq' },
      attachTo: document.body,
    });
    await nextTick();
    expect(document.body.querySelector('select')).not.toBeNull();
    wrapper.unmount();
  });

  it('validates required fields', async () => {
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    const submitBtn = document.body.querySelector('button.primary') as HTMLButtonElement;
    submitBtn.click();
    await flushPromises();
    expect(document.body.innerHTML).toContain('必填');
    // loadAgents calls fetch('/api/agents') on dialog open, so mockFetch IS
    // called once (for the agents list). The submit must NOT call apiFetch.
    expect(mockFetch).not.toHaveBeenCalledWith('POST', '/qr-login');
    wrapper.unmount();
  });

  it('submits setup form and transitions to scan phase', async () => {
    vi.useFakeTimers();
    // 1st: loadAgents fetch (agents list); 2nd: qr-login apiFetch (channelId)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => [{ id: 'agent-1', name: 'Agent 1', model: 'm' }],
    });
    mockFetch.mockResolvedValueOnce({ channelId: 'new-ch-id' });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test-bot');
    setVal('select', 'agent-1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledWith('POST', '/qr-login', {
      displayName: 'test-bot',
      defaultAgentId: 'agent-1',
    });
    await flushPromises();
    expect(document.body.querySelector('.scan-panel')).not.toBeNull();
    wrapper.unmount();
  });

  it('after setup, subscribes to SSE THEN triggers start-qr', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-123' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 150));
    await flushPromises();
    expect(MockEventSource.instances.length).toBe(1);
    expect(MockEventSource.instances[0]!.url).toContain('channelId=ch-123');
    // After loadAgents consumed one fetch, calls are:
    //   [0] fetch('/api/agents')
    //   [1] apiFetch('/qr-login', body)
    //   [2] apiFetch('/channels/<id>/start-qr')
    const third = mockFetch.mock.calls[2]!;
    expect(third[0]).toBe('POST');
    expect(third[1]).toBe('/channels/ch-123/start-qr');
    wrapper.unmount();
  });

  it('shows QR image when qr-url event arrives', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 150));
    const es = MockEventSource.instances[0]!;
    // Emit a URL string (typical iLink response); the dialog should render it
    // through the qrcode lib into a data: URL.
    es._trigger('qr-url', {
      channelId: 'ch-1', channelType: 'wechat', kind: 'qr-url',
      data: { qrUrl: 'https://liteapp.weixin.qq.com/q/abc?qrcode=xyz&bot_type=3' },
      timestamp: new Date().toISOString(),
    });
    // Wait for async QRCode.toDataURL() to resolve
    await new Promise((r) => setTimeout(r, 200));
    await flushPromises();
    const img = document.body.querySelector('img.qr-image');
    expect(img).not.toBeNull();
    // The rendered src should be a data: URL produced by the qrcode lib,
    // not the raw iLink URL.
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    wrapper.unmount();
  });

  it('appends events to log list (newest first)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 150));
    const es = MockEventSource.instances[0]!;
    const ts1 = new Date().toISOString();
    const ts2 = new Date(Date.now() + 1000).toISOString();
    es._trigger('qr-url', { channelId: 'ch-1', channelType: 'wechat', kind: 'qr-url', timestamp: ts1 });
    es._trigger('qr-scanned', { channelId: 'ch-1', channelType: 'wechat', kind: 'qr-scanned', timestamp: ts2 });
    await flushPromises();
    const items = document.body.querySelectorAll('.log-list li');
    expect(items.length).toBe(2);
    expect(items[0]!.textContent).toContain('qr-scanned');
    expect(items[1]!.textContent).toContain('qr-url');
    wrapper.unmount();
  });

  it('transitions to scanned state on qr-scanned event', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 150));
    const es = MockEventSource.instances[0]!;
    es._trigger('qr-url', { channelId: 'ch-1', channelType: 'wechat', kind: 'qr-url', data: { qrUrl: 'https://x.com/q.png' }, timestamp: new Date().toISOString() });
    es._trigger('qr-scanned', { channelId: 'ch-1', channelType: 'wechat', kind: 'qr-scanned', timestamp: new Date().toISOString() });
    await flushPromises();
    expect(document.body.innerHTML).toContain('已扫码');
    wrapper.unmount();
  });

  it('auto-closes on connected event after 1.5s', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await vi.runAllTimersAsync();
    const es = MockEventSource.instances[0]!;
    es._trigger('connected', { channelId: 'ch-1', channelType: 'wechat', kind: 'connected', timestamp: new Date().toISOString() });
    await flushPromises();
    expect(document.body.innerHTML).toContain('登录成功');
    await vi.runAllTimersAsync();
    expect(wrapper.emitted('update:open')).toBeTruthy();
    expect(wrapper.emitted('update:open')![0]).toEqual([false]);
    expect(wrapper.emitted('connected')).toBeTruthy();
  });

  it('shows error on start-failed event', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 150));
    const es = MockEventSource.instances[0]!;
    es._trigger('start-failed', { channelId: 'ch-1', channelType: 'wechat', kind: 'start-failed', message: 'QR expired', timestamp: new Date().toISOString() });
    await flushPromises();
    expect(document.body.innerHTML).toContain('QR expired');
    wrapper.unmount();
  });

  it('closes SSE on unmount', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => [{ id: 'a1', name: 'A1', model: 'm' }] }).mockResolvedValueOnce({ channelId: 'ch-1' }).mockResolvedValueOnce({ ok: true });
    const wrapper = mount(QrLoginDialog, {
      props: { open: true, channelType: 'wechat' },
      attachTo: document.body,
    });
    await nextTick();
    await flushPromises(); // wait for loadAgents to populate <select>
    const setVal = (sel: string, val: string) => {
      const el = document.body.querySelector(sel) as HTMLInputElement;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setVal('input[placeholder*="客服"]', 'test');
    setVal('select', 'a1');
    (document.body.querySelector('button.primary') as HTMLButtonElement).click();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(150);
    const es = MockEventSource.instances[0]!;
    wrapper.unmount();
    expect(es.closed).toBe(true);
  });
});