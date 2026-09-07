import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';
import path from 'node:path';

/** Run after static assets: history-mode navigation returns the SPA entry. */
export function createSpaFallback(indexPath: string): MiddlewareHandler {
  const serveIndex = serveStatic({ path: indexPath });
  return async (c, next) => {
    // Missing assets and API-style requests must retain their real 404 status.
    if (path.extname(c.req.path) || !c.req.header('accept')?.includes('text/html')) {
      return next();
    }
    return serveIndex(c, next);
  };
}
