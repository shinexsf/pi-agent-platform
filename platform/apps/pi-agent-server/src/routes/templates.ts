/**
 * /api/templates — saved agent configuration templates.
 *
 * Templates are global (not per-agent). A template is a snapshot of the seven
 * AgentConfig fields; `systemPrompt` is intentionally absent (applying a template
 * clears it so a copied prompt is never silently reused).
 */

import { Hono } from 'hono';
import type { TemplateRepo } from '../repos/template.repo.js';
import type { CreateTemplateRequest, UpdateTemplateRequest } from '@pi-agent-platform/api-types';
import { normalizeAgentConfig } from '@pi-agent-platform/shared-types';

export function createTemplatesRouter(templateRepo: TemplateRepo) {
  const router = new Hono();

  router.get('/', (c) => c.json(templateRepo.list()));

  router.get('/:id', (c) => {
    const template = templateRepo.get(c.req.param('id'));
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json(template);
  });

  router.post('/', async (c) => {
    const body = (await c.req.json()) as CreateTemplateRequest;
    const name = (body?.name ?? '').trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!body?.config || typeof body.config !== 'object') {
      return c.json({ error: 'config is required' }, 400);
    }
    if (templateRepo.findByName(name)) {
      return c.json({ error: `模板名 "${name}" 已存在` }, 409);
    }
    const template = templateRepo.create({
      name,
      description: body.description,
      config: normalizeAgentConfig(body.config),
    });
    return c.json(template, 201);
  });

  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as UpdateTemplateRequest;
    if (body?.name !== undefined && !body.name.trim()) {
      return c.json({ error: 'name cannot be empty' }, 400);
    }
    if (body?.name !== undefined) {
      const clash = templateRepo.findByName(body.name);
      if (clash && clash.id !== id) {
        return c.json({ error: `模板名 "${body.name.trim()}" 已存在` }, 409);
      }
    }
    const patch: UpdateTemplateRequest = { ...body };
    if (body?.config !== undefined) patch.config = normalizeAgentConfig(body.config);
    const template = templateRepo.update(id, patch);
    if (!template) return c.json({ error: 'Template not found' }, 404);
    return c.json(template);
  });

  router.delete('/:id', (c) => {
    const removed = templateRepo.remove(c.req.param('id'));
    if (!removed) return c.json({ error: 'Template not found' }, 404);
    return c.json({ ok: true });
  });

  return router;
}
