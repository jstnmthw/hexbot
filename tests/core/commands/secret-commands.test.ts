import { describe, expect, it } from 'vitest';

import { SECRET_COMMANDS, redactCommandLine } from '../../../src/core/commands/secret-commands';

describe('redactCommandLine', () => {
  it('redacts the arguments of a dot-form secret command', () => {
    expect(redactCommandLine('.chpass hunter2')).toBe('.chpass [redacted]');
    expect(redactCommandLine('.chpass alice s3cr3t')).toBe('.chpass [redacted]');
  });

  it('redacts the arguments of a bare secret command', () => {
    expect(redactCommandLine('chpass hunter2')).toBe('chpass [redacted]');
  });

  it('is case-insensitive on the verb but preserves the dot form', () => {
    expect(redactCommandLine('.CHPASS hunter2')).toBe('.chpass [redacted]');
    expect(redactCommandLine('.ChPass  hunter2')).toBe('.chpass [redacted]');
  });

  it('leaves a secret command with no arguments intact (nothing to hide)', () => {
    expect(redactCommandLine('.chpass')).toBe('.chpass');
    expect(redactCommandLine('chpass')).toBe('chpass');
  });

  it('never leaks the password no matter the surrounding whitespace', () => {
    const redacted = redactCommandLine('   .chpass   my hunter2 s3cr3t-token   ');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('s3cr3t-token');
    expect(redacted).toContain('[redacted]');
  });

  it('passes non-secret commands through unchanged', () => {
    expect(redactCommandLine('.status')).toBe('.status');
    expect(redactCommandLine('.say #chan hello world')).toBe('.say #chan hello world');
    // A non-secret command whose args happen to contain "chpass" is untouched.
    expect(redactCommandLine('.say #chan chpass is the command')).toBe(
      '.say #chan chpass is the command',
    );
  });

  it('exposes chpass as a known secret command', () => {
    expect(SECRET_COMMANDS.has('chpass')).toBe(true);
  });
});
