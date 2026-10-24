/**
 * Tool card registry (change: session-streaming-runtime, group 6).
 *
 * Dispatch is **by tool name**: every entry in `CARD_BY_NAME` maps one exact
 * tool name to one card component. Tools without an entry fall back to
 * `DefaultCard` (which also covers the whole `mcp__<server>__<tool>` namespace —
 * MCP names are shown verbatim, never re-parsed).
 *
 * Why names instead of categories: a category is only knowable for first-party
 * tools. A third-party tool arrives with an arbitrary name, and a user-script
 * provided card will be registered by name too — so name is the one key that
 * always exists.
 */

import type { Component } from 'vue'
import BashCard from './cards/BashCard.vue'
import DefaultCard from './cards/DefaultCard.vue'
import EditCard from './cards/EditCard.vue'
import FetchCard from './cards/FetchCard.vue'
import ReadCard from './cards/ReadCard.vue'
import SearchCard from './cards/SearchCard.vue'
import WriteCard from './cards/WriteCard.vue'
import type { ToolBlockBinding } from './types'

/** Exact tool name → card. Add a line here to give a tool its own card. */
const CARD_BY_NAME: Record<string, Component> = {
  // pi core tools
  read: ReadCard,
  write: WriteCard,
  edit: EditCard,
  bash: BashCard,
  shell: BashCard,
  powershell: BashCard,
  grep: SearchCard,
  find: SearchCard,
  ls: SearchCard,
  // extension tools with a stable, known name
  fetch: FetchCard,
  web_fetch: FetchCard,
  web_search: FetchCard,
  read_image: FetchCard,
  view_image: FetchCard,
}

/** Prefix → card, for generated namespaces that cannot be enumerated. */
const PREFIX_CARDS: Array<{ prefix: string; component: Component }> = [
  // `mcp__<server>__<tool>` — infinite names, one generic card.
  { prefix: 'mcp__', component: DefaultCard },
  // pi-web-access tools are prefixed `web_*`.
  { prefix: 'web_', component: FetchCard },
]

export function resolveToolBlock(name: string): ToolBlockBinding {
  const exact = CARD_BY_NAME[name]
  if (exact) return { component: exact, label: name }

  for (const rule of PREFIX_CARDS) {
    if (name.startsWith(rule.prefix)) return { component: rule.component, label: name }
  }

  return { component: DefaultCard, label: name }
}
