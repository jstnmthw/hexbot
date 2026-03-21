import { vi } from 'vitest';

// Suppress console output during tests to keep output clean.
// Tests that need to assert on console calls can still use vi.spyOn().
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
