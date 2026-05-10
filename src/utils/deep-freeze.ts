/**
 * Recursively freeze an object so every nested object/array is also
 * `Object.freeze`d. Plain `Object.freeze({ ...x })` is shallow — a nested
 * array or object remains mutable, which breaks the API-immutability
 * contract documented in SECURITY.md §4.1 (a plugin holding a frozen view
 * can still mutate `view.list.length = 0` to clear an inner array shared
 * by reference with core).
 *
 * Walks own keys only (mirroring `Object.freeze`'s contract). Skips
 * primitives, `null`, and already-frozen objects so the recursion
 * terminates on cycles. Returns the input value (now frozen) for
 * convenient inline use.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  const obj = value as Record<string | number | symbol, unknown>;
  for (const key of Reflect.ownKeys(obj)) {
    deepFreeze(obj[key as keyof typeof obj]);
  }
  return Object.freeze(value);
}
