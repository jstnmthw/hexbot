import { describe, expect, it, vi } from 'vitest';

import { EventDispatcher, type VerificationProvider } from '../../src/dispatcher';
import type { HandlerContext } from '../../src/types';
import { requiresVerificationForFlags } from '../../src/utils/verify-flags';

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'testuser',
    ident: 'user',
    hostname: 'test.host.com',
    channel: '#test',
    text: '',
    command: '!op',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// requiresVerificationForFlags
// ---------------------------------------------------------------------------

describe('requiresVerificationForFlags', () => {
  const requireAccFor = ['+o', '+n'];

  it('returns false for no-flags bind (-)', () => {
    expect(requiresVerificationForFlags('-', requireAccFor)).toBe(false);
  });

  it('returns false for empty flags', () => {
    expect(requiresVerificationForFlags('', requireAccFor)).toBe(false);
  });

  it('returns true for op-level bind when +o is in require_acc_for', () => {
    expect(requiresVerificationForFlags('o', requireAccFor)).toBe(true);
  });

  it('returns true for owner-level bind', () => {
    expect(requiresVerificationForFlags('n', requireAccFor)).toBe(true);
  });

  it('returns true for master-level bind (above threshold)', () => {
    expect(requiresVerificationForFlags('m', requireAccFor)).toBe(true);
  });

  it('returns false for voice-level bind (below op threshold)', () => {
    expect(requiresVerificationForFlags('v', requireAccFor)).toBe(false);
  });

  it('returns false when require_acc_for is empty', () => {
    expect(requiresVerificationForFlags('o', [])).toBe(false);
  });

  it('returns false when require_acc_for has only unknown flags', () => {
    expect(requiresVerificationForFlags('o', ['+z'])).toBe(false);
  });

  it('returns false when bindFlags contains only unrecognized characters', () => {
    // 'x' is not in FLAG_LEVEL — bindLevel resolves to 0 via the ?? 0 fallback
    expect(requiresVerificationForFlags('x', ['+o'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher verification gating
// ---------------------------------------------------------------------------

describe('EventDispatcher verification gating', () => {
  // Permissive permissions provider — the verification-gate tests aren't
  // exercising the flag-check path, so return `true` unconditionally.
  // Dispatcher.checkFlags fails closed when no permissions is attached, so
  // this mock is required to even reach the verification pass.
  const passAllPermissions = { checkFlags: () => true };

  function makeVerificationProvider(
    overrides: Partial<VerificationProvider> = {},
  ): VerificationProvider {
    return {
      requiresVerificationForFlags: (flags) => flags !== '-' && flags !== '' && flags !== 'v',
      getAccountForNick: () => undefined, // unknown by default
      verifyUser: async () => ({ verified: true, account: 'TestAccount' }),
      ...overrides,
    };
  }

  it('passes handler when verification is not set', async () => {
    const dispatcher = new EventDispatcher(passAllPermissions);
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test');
  });

  it('passes handler when flags are - (no verification needed)', async () => {
    const dispatcher = new EventDispatcher(passAllPermissions);
    dispatcher.setVerification(makeVerificationProvider());
    const handler = vi.fn();
    dispatcher.bind('pub', '-', '!hello', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!hello' }));
    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test');
  });

  it('allows handler when account is known (fast path from account-notify)', async () => {
    const dispatcher = new EventDispatcher(passAllPermissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => 'SomeAccount',
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test');
  });

  it('blocks handler when account is known null (user not identified)', async () => {
    const dispatcher = new EventDispatcher(passAllPermissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => null, // known not identified
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(handler).not.toHaveBeenCalled();
    dispatcher.unbindAll('test');
  });

  it('falls back to NickServ when account is unknown (undefined)', async () => {
    const verifyUser = vi.fn().mockResolvedValue({ verified: true, account: 'TestAccount' });
    const dispatcher = new EventDispatcher(passAllPermissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => undefined,
        verifyUser,
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(verifyUser).toHaveBeenCalledWith('testuser');
    expect(handler).toHaveBeenCalledOnce();
    dispatcher.unbindAll('test');
  });

  it('blocks handler when NickServ fallback returns not verified', async () => {
    const dispatcher = new EventDispatcher(passAllPermissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => undefined,
        verifyUser: async () => ({ verified: false, account: null }),
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(handler).not.toHaveBeenCalled();
    dispatcher.unbindAll('test');
  });

  it('re-checks flags with the confirmed account after ACC verifies', async () => {
    // New second-pass guard: after verification, permissions.checkFlags is
    // called a second time with `ctx.account` bound to the verified account
    // so a weak hostmask record can't satisfy the gate just because "some
    // other account" happened to be identified.
    const checkFlags = vi.fn().mockReturnValue(true);
    const permissions = { checkFlags };
    const dispatcher = new EventDispatcher(permissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => undefined,
        verifyUser: async () => ({ verified: true, account: 'Confirmed' }),
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    // First call: initial flag gate. Second call: verification rescan with
    // `account: 'Confirmed'` attached.
    expect(checkFlags).toHaveBeenCalledTimes(2);
    expect(checkFlags.mock.calls[1][1].account).toBe('Confirmed');
    dispatcher.unbindAll('test');
  });

  it('blocks handler when the account rescan no longer matches the record', async () => {
    let callCount = 0;
    const permissions = {
      checkFlags: vi.fn(() => {
        callCount += 1;
        return callCount === 1; // pass the first gate, fail the rescan
      }),
    };
    const dispatcher = new EventDispatcher(permissions);
    dispatcher.setVerification(
      makeVerificationProvider({
        getAccountForNick: () => undefined,
        verifyUser: async () => ({ verified: true, account: 'Other' }),
      }),
    );
    const handler = vi.fn();
    dispatcher.bind('pub', 'o', '!op', handler, 'test');
    await dispatcher.dispatch('pub', makeCtx({ command: '!op' }));
    expect(handler).not.toHaveBeenCalled();
    dispatcher.unbindAll('test');
  });
});
