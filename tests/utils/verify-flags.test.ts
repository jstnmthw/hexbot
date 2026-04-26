// `validateRequireAccFor` must warn on unknown flag characters at config
// load so an operator typo like `["+O"]` is surfaced instead of silently
// defaulting to level 0 (which disables the ACC verification gate for that
// flag).
import { describe, expect, it } from 'vitest';

import type { LoggerLike } from '../../src/logger';
import { validateRequireAccFor } from '../../src/utils/verify-flags';

describe('validateRequireAccFor: warns on unknown flags', () => {
  it('filters unknown flags and logs a warning', () => {
    const warns: string[] = [];
    const logger: LoggerLike = {
      info: () => {},
      warn: (msg: string) => warns.push(msg),
      debug: () => {},
      error: () => {},
      child: () => logger,
      setLevel: () => {},
      getLevel: () => 'info',
    };
    // `+Q` is nonsense; `+o` is valid.
    const result = validateRequireAccFor(['+o', '+Q'], logger);
    expect(result).toEqual(['+o']);
    expect(warns.some((m) => m.includes('+Q'))).toBe(true);
  });

  it('passes recognized flags through unchanged', () => {
    const result = validateRequireAccFor(['+n', '+m', '+o', '+v'], null);
    expect(result).toEqual(['+n', '+m', '+o', '+v']);
  });
});
