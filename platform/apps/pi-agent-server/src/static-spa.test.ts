import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createSpaFallback } from './static-spa.js';

const root = mkdtempSync(path.join(tmpdir(), 'pi-web-static-'));
mkdirSync(path.join(root, 'architecture'));
writeFileSync(path.join(root, 'index.html'), '<main>Web app</main>');
writeFileSync(path.join(root, 'architecture/viewer.html'), '<main>Architecture</main>');

const app = new Hono();
app.use('/web/*', serveStatic({ root, rewriteRequestPath: (p) => p.slice('/web'.length) }));
app.get('/web/*', createSpaFallback(path.join(root, 'index.html')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('Web UI static hosting', () => {
  it('serves the SPA for direct architecture navigation and refresh', async () => {
    const response = await app.request('/web/architecture', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<main>Web app</main>');
  });

  it('serves the standalone viewer before the SPA fallback', async () => {
    const response = await app.request('/web/architecture/viewer.html', { headers: { accept: 'text/html' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<main>Architecture</main>');
  });

  it.each(['/web/assets/missing.js', '/web/architecture/missing.html'])(
    'keeps missing assets at %s as 404', async (url) => {
      expect((await app.request(url, { headers: { accept: 'text/html' } })).status).toBe(404);
    },
  );

  it('does not rewrite non-navigation requests or POST requests', async () => {
    expect((await app.request('/web/unknown', { headers: { accept: 'application/json' } })).status).toBe(404);
    expect((await app.request('/web/architecture', { method: 'POST', headers: { accept: 'text/html' } })).status).toBe(404);
  });
});
