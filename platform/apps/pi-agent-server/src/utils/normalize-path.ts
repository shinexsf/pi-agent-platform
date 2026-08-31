/**
 * Path normalization for cross-OS compatibility.
 *
 * Rules (per doc/architecture/current/pi-agent-server_db-schema.md):
 * 1. Convert \ to /
 * 2. Lowercase Windows drive letter (C: → c:)
 * 3. Strip trailing / (keep root /)
 *
 * NOT normalized (preserved):
 * - Path-segment casing (case-sensitive on Linux)
 * - UNC paths (\\server\share) — not supported in MVP
 */
export function normalizePath(p: string): string {
  let normalized = p.replace(/\\/g, '/');
  if (/^[A-Z]:/.test(normalized)) {
    const first = normalized[0];
    if (first) {
      normalized = first.toLowerCase() + normalized.slice(1);
    }
  }
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}