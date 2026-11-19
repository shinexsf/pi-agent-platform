/**
 * Worker-side IPC method registry.
 *
 * Lives in its own module (not `index.ts`) because BOTH the dispatcher (`index.ts`)
 * and the session/plugin layer (`session.ts`) need it, and `session.ts` must not
 * import the entry point (that would be a cycle).
 *
 * Two kinds of entries live here:
 *  - `core` methods registered by `index.ts` at module load (the 14 forward methods)
 *  - plugin methods registered at session-creation time via `registerPluginMethod`
 *
 * Plugin methods are ALWAYS `plugin.<pluginId>.<name>` (enforced by the registry's
 * prefix check). Ownership is the `source` field — never parsed out of the string.
 */

import { IpcMethodRegistry, type IpcHandler } from '@pi-agent-platform/ipc-protocol';

/** The one registry every forward method (core + plugin) is dispatched through. */
export const forwardRegistry = new IpcMethodRegistry();

/** Full method name for a plugin-contributed forward method. */
export function pluginMethodName(pluginId: string, name: string): string {
  return `plugin.${pluginId}.${name}`;
}

/**
 * Register one plugin-contributed forward method.
 *
 * Returns `false` when the registry refused it (name collision or a name that does
 * not carry the plugin's own prefix). A refusal is logged by the caller — it must
 * never be silent.
 */
export function registerPluginMethod(
  pluginId: string,
  name: string,
  handler: (args: unknown[], ctx: string | undefined) => unknown,
): boolean {
  const entry = forwardRegistry.register(
    pluginMethodName(pluginId, name),
    {
      direction: 'forward',
      source: `plugin:${pluginId}`,
      kind: 'plugin',
      description: `plugin ${pluginId}: ${name}`,
    },
    (args, ctx) => handler(args, ctx as string | undefined),
  );
  return entry !== undefined;
}

/**
 * Dispatch a plugin method from inside this worker.
 *
 * Used by the session layer for the one built-in plugin downlink (`emit`), so it
 * goes through exactly the same path a master-initiated call would.
 */
export async function callPluginMethod(
  pluginId: string,
  name: string,
  args: unknown[],
): Promise<unknown> {
  const resolved = forwardRegistry.resolve(pluginMethodName(pluginId, name));
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.handler(args);
}

/** Does this plugin currently have a handler for `name`? */
export function hasPluginMethod(pluginId: string, name: string): boolean {
  return forwardRegistry.resolve(pluginMethodName(pluginId, name)).ok;
}
