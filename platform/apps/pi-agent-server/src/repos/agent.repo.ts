/**
 * Agent repository — drizzle-based data access.
 * Path fields MUST be normalized via normalizePath() before write.
 */

import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/init.js';
import { agents } from '../db/schema.js';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import { normalizePath } from '../utils/normalize-path.js';

function rowToDTO(row: typeof agents.$inferSelect): AgentDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workspacePath: row.workspacePath,
    model: row.model,
    thinkingLevel: row.thinkingLevel ?? undefined,
    // systemPrompt / tools can be null in DB (= "use pi defaults"); surface
    // as undefined so the AgentDTO shape stays "absent means default".
    systemPrompt: row.systemPrompt ?? undefined,
    appendSystemPrompt: row.appendSystemPrompt ?? undefined,
    tools: row.tools ? (JSON.parse(row.tools) as string[]) : undefined,
    config: row.config ? (JSON.parse(row.config) as Record<string, unknown>) : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createAgentRepo(db: DB) {
  return {
    /**
     * List agents, optionally filtered by workspacePath (exact match after normalization).
     * Server normalizes the input on the route layer; we normalize again here defensively
     * so stored (already-normalized) rows compare correctly regardless of caller.
     */
    list(filter?: { workspacePath?: string }): AgentDTO[] {
      let rows = db.select().from(agents).all();
      if (filter?.workspacePath) {
        const target = normalizePath(filter.workspacePath);
        rows = rows.filter((r) => r.workspacePath === target);
      }
      return rows.map(rowToDTO);
    },

    get(id: string): AgentDTO | undefined {
      const row = db.select().from(agents).where(eq(agents.id, id)).get();
      return row ? rowToDTO(row) : undefined;
    },

    create(input: Omit<AgentDTO, 'id' | 'createdAt' | 'updatedAt'>): AgentDTO {
      const now = Date.now();
      const id = randomUUID();
      const row = {
        id,
        name: input.name,
        description: input.description ?? null,
        workspacePath: normalizePath(input.workspacePath),
        model: input.model,
        thinkingLevel: input.thinkingLevel ?? null,
        // Null / empty / undefined all collapse to NULL — meaning "use pi default".
        systemPrompt: input.systemPrompt?.trim() ? input.systemPrompt : null,
        appendSystemPrompt: input.appendSystemPrompt?.trim() ? input.appendSystemPrompt : null,
        tools: input.tools && input.tools.length > 0 ? JSON.stringify(input.tools) : null,
        config: input.config ? JSON.stringify(input.config) : null,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(agents).values(row).run();
      return this.get(id)!;
    },

    update(id: string, patch: Partial<Omit<AgentDTO, 'id' | 'createdAt'>>): AgentDTO | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;
      const now = Date.now();
      const updates: Partial<typeof agents.$inferInsert> = { updatedAt: now };
      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.description !== undefined) updates.description = patch.description;
      if (patch.workspacePath !== undefined) updates.workspacePath = normalizePath(patch.workspacePath);
      if (patch.model !== undefined) updates.model = patch.model;
      if (patch.thinkingLevel !== undefined) updates.thinkingLevel = patch.thinkingLevel;
      // Empty / whitespace string also clears back to NULL (= pi default).
      if (patch.systemPrompt !== undefined) updates.systemPrompt = patch.systemPrompt.trim() ? patch.systemPrompt : null;
      if (patch.appendSystemPrompt !== undefined) updates.appendSystemPrompt = patch.appendSystemPrompt.trim() ? patch.appendSystemPrompt : null;
      if (patch.tools !== undefined) updates.tools = patch.tools.length > 0 ? JSON.stringify(patch.tools) : null;
      if (patch.config !== undefined) updates.config = JSON.stringify(patch.config);

      db.update(agents).set(updates).where(eq(agents.id, id)).run();
      return this.get(id);
    },

    delete(id: string): boolean {
      const result = db.delete(agents).where(eq(agents.id, id)).run();
      return result.changes > 0;
    },
  };
}

export type AgentRepo = ReturnType<typeof createAgentRepo>;