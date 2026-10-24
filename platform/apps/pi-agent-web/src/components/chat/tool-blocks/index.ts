/**
 * Tool block surface consumed by MessageItem (and, later, user scripts).
 *
 * Dispatch is by tool name — see `registry.ts`.
 */
export { resolveToolBlock } from './registry'
export { default as DefaultCard } from './cards/DefaultCard.vue'
export { default as ReadCard } from './cards/ReadCard.vue'
export { default as EditCard } from './cards/EditCard.vue'
export { default as WriteCard } from './cards/WriteCard.vue'
export { default as BashCard } from './cards/BashCard.vue'
export { default as SearchCard } from './cards/SearchCard.vue'
export { default as FetchCard } from './cards/FetchCard.vue'
export { default as ToolCard } from './ToolCard.vue'
export type { ToolBlockBinding, ToolBlockProps, ToolCall } from './types'
