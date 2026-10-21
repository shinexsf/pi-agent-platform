/**
 * Agent template repository — saved configuration snapshots (global list).
 *
 * A template stores exactly the seven AgentConfig fields; `normalizeAgentConfig`
 * is applied by the route layer before create/update so every stored snapshot is
 * self-contained (missing = empty), matching the single-layer config semantics.
 */

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/init.js';
import { agentTemplates } from '../db/schema.js';
import type { AgentTemplateDTO, AgentConfig } from '@pi-agent-platform/shared-types';

function rowToDTO(row: typeof agentTemplates.$inferSelect): AgentTemplateDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    config: JSON.parse(row.config) as AgentConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createTemplateRepo(db: DB) {
  return {
    list(): AgentTemplateDTO[] {
      return db.select().from(agentTemplates).all().map(rowToDTO);
    },

    get(id: string): AgentTemplateDTO | undefined {
      const row = db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).get();
      return row ? rowToDTO(row) : undefined;
    },

    /** Case-insensitive name lookup — used to reject duplicates. */
    findByName(name: string): AgentTemplateDTO | undefined {
      const target = name.trim().toLowerCase();
      const row = db
        .select()
        .from(agentTemplates)
        .all()
        .find((r) => r.name.trim().toLowerCase() === target);
      return row ? rowToDTO(row) : undefined;
    },

    create(input: { name: string; description?: string; config: AgentConfig }): AgentTemplateDTO {
      const now = Date.now();
      const row = {
        id: randomUUID(),
        name: input.name.trim(),
        description: input.description?.trim() || null,
        config: JSON.stringify(input.config),
        createdAt: now,
        updatedAt: now,
      };
      db.insert(agentTemplates).values(row).run();
      return rowToDTO(row as typeof agentTemplates.$inferSelect);
    },

    update(
      id: string,
      patch: { name?: string; description?: string; config?: AgentConfig },
    ): AgentTemplateDTO | undefined {
      const existing = db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).get();
      if (!existing) return undefined;
      const next = {
        name: patch.name !== undefined ? patch.name.trim() : existing.name,
        description:
          patch.description !== undefined ? patch.description.trim() || null : existing.description,
        config: patch.config !== undefined ? JSON.stringify(patch.config) : existing.config,
        updatedAt: Date.now(),
      };
      db.update(agentTemplates).set(next).where(eq(agentTemplates.id, id)).run();
      return rowToDTO({ ...existing, ...next });
    },

    remove(id: string): boolean {
      const existing = db.select().from(agentTemplates).where(eq(agentTemplates.id, id)).get();
      if (!existing) return false;
      db.delete(agentTemplates).where(eq(agentTemplates.id, id)).run();
      return true;
    },
  };
}

export type TemplateRepo = ReturnType<typeof createTemplateRepo>;
