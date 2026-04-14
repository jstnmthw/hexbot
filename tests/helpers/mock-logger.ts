// Shared mock Logger for tests.
import { vi } from 'vitest';

import type { LoggerLike } from '../../src/logger';

/**
 * Create a mock logger where every method is a vi.fn() stub.
 * `child()` returns the same mock instance by default (self-referential).
 */
export function createMockLogger(): LoggerLike {
  const mock = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn<(prefix: string) => LoggerLike>(),
    setLevel: vi.fn(),
    getLevel: vi.fn<() => 'debug' | 'info' | 'warn' | 'error'>().mockReturnValue('info'),
  };
  mock.child.mockReturnValue(mock);
  return mock;
}
