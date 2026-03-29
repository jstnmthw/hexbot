// HexBot — IRC event type utilities
// Type guards and coercions for irc-framework event payloads.
// irc-framework emits events as untyped unknown values; these helpers provide
// safe, validated access without requiring casts at every call site.

/**
 * Coerce an IRC event argument to a plain-object event record.
 * Returns `{}` if `val` is not a non-null, non-array object,
 * matching the irc-framework contract that all event payloads are plain objects.
 */
export function toEventObject(val: unknown): Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

/** Validate that a single value is an irc-framework mode entry. */
function isModeEntry(m: unknown): m is { mode?: string; param?: string } {
  if (typeof m !== 'object' || m === null) return false;
  const rec = m as Record<string, unknown>;
  return rec.mode === undefined || typeof rec.mode === 'string';
}

/**
 * Validate that a value is an irc-framework modes array
 * (each element has an optional `mode: string` and optional `param: string`).
 */
export function isModeArray(val: unknown): val is Array<{ mode?: string; param?: string }> {
  return Array.isArray(val) && val.every(isModeEntry);
}

/**
 * Validate that a value is an array of plain objects
 * (irc-framework user list / who list entries).
 */
export function isObjectArray(val: unknown): val is Array<Record<string, unknown>> {
  return Array.isArray(val) && val.every((u) => typeof u === 'object' && u !== null);
}
