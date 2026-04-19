import { describe, expect, it, vi } from 'vitest';

import { type CoalescedMessage, MessageCoalescer } from '../../plugins/ai-chat/message-coalescer';
import type { HandlerContext } from '../../src/types';

function ctx(nick: string, channel: string, text = ''): HandlerContext {
  return {
    nick,
    ident: 'u',
    hostname: 'h',
    channel,
    text,
    source: 'public',
    flags: '',
    isAdmin: false,
    raw: '',
    replyPrivate: vi.fn(),
    reply: vi.fn(),
    reply_pm: vi.fn(),
    reply_notice: vi.fn(),
  } as unknown as HandlerContext;
}

describe('MessageCoalescer', () => {
  it('fires a single fragment after the window expires', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    coalescer.submit('#chan', 'dark', 'hello', ctx('dark', '#chan'), (m) => fired.push(m));
    expect(fired).toHaveLength(0);
    expect(coalescer.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe('hello');
    expect(fired[0].fragmentCount).toBe(1);
    expect(coalescer.pendingCount()).toBe(0);
    vi.useRealTimers();
  });

  it('merges multiple fragments arriving within the window', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    const onFire = (m: CoalescedMessage): void => {
      fired.push(m);
    };
    coalescer.submit('#chan', 'dark', 'one', ctx('dark', '#chan'), onFire);
    await vi.advanceTimersByTimeAsync(40);
    coalescer.submit('#chan', 'dark', 'two', ctx('dark', '#chan'), onFire);
    await vi.advanceTimersByTimeAsync(40);
    coalescer.submit('#chan', 'dark', 'three', ctx('dark', '#chan'), onFire);
    expect(fired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe('one two three');
    expect(fired[0].fragmentCount).toBe(3);
    vi.useRealTimers();
  });

  it('keeps separate bursts for different nicks in the same channel', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    const onFire = (m: CoalescedMessage): void => {
      fired.push(m);
    };
    coalescer.submit('#chan', 'alice', 'a1', ctx('alice', '#chan'), onFire);
    coalescer.submit('#chan', 'bob', 'b1', ctx('bob', '#chan'), onFire);
    coalescer.submit('#chan', 'alice', 'a2', ctx('alice', '#chan'), onFire);
    expect(coalescer.pendingCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(2);
    const byNick = new Map(fired.map((m) => [m.nick, m]));
    expect(byNick.get('alice')?.text).toBe('a1 a2');
    expect(byNick.get('bob')?.text).toBe('b1');
    vi.useRealTimers();
  });

  it('treats nicks case-insensitively for the burst key', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    coalescer.submit('#chan', 'Dark', 'one', ctx('Dark', '#chan'), (m) => fired.push(m));
    coalescer.submit('#chan', 'DARK', 'two', ctx('DARK', '#chan'), (m) => fired.push(m));
    coalescer.submit('#chan', 'dark', 'three', ctx('dark', '#chan'), (m) => fired.push(m));
    expect(coalescer.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe('one two three');
    vi.useRealTimers();
  });

  it('drops fragments past the byte cap rather than growing unbounded', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 12);
    const fired: CoalescedMessage[] = [];
    const onFire = (m: CoalescedMessage): void => {
      fired.push(m);
    };
    coalescer.submit('#chan', 'dark', 'aaaa', ctx('dark', '#chan'), onFire); // 4 bytes
    coalescer.submit('#chan', 'dark', 'bbbb', ctx('dark', '#chan'), onFire); // 8 bytes total
    coalescer.submit('#chan', 'dark', 'cccc', ctx('dark', '#chan'), onFire); // would be 12 — accepted
    coalescer.submit('#chan', 'dark', 'dddd', ctx('dark', '#chan'), onFire); // would be 16 — dropped
    await vi.advanceTimersByTimeAsync(100);
    expect(fired[0].text).toBe('aaaa bbbb cccc');
    vi.useRealTimers();
  });

  it('reuses the original onFire callback even if subsequent submits pass a different one', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const firstFired: CoalescedMessage[] = [];
    const secondFired: CoalescedMessage[] = [];
    coalescer.submit('#chan', 'dark', 'one', ctx('dark', '#chan'), (m) => firstFired.push(m));
    coalescer.submit('#chan', 'dark', 'two', ctx('dark', '#chan'), (m) => secondFired.push(m));
    await vi.advanceTimersByTimeAsync(100);
    expect(firstFired).toHaveLength(1);
    expect(firstFired[0].text).toBe('one two');
    expect(secondFired).toHaveLength(0);
    vi.useRealTimers();
  });

  it('teardown clears pending bursts without firing them', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    coalescer.submit('#chan', 'dark', 'one', ctx('dark', '#chan'), (m) => fired.push(m));
    coalescer.submit('#chan', 'alice', 'a', ctx('alice', '#chan'), (m) => fired.push(m));
    expect(coalescer.pendingCount()).toBe(2);
    coalescer.teardown();
    expect(coalescer.pendingCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(fired).toHaveLength(0);
    vi.useRealTimers();
  });

  it('starts a fresh burst after the previous one fires', async () => {
    vi.useFakeTimers();
    const coalescer = new MessageCoalescer(100, 8192);
    const fired: CoalescedMessage[] = [];
    coalescer.submit('#chan', 'dark', 'one', ctx('dark', '#chan'), (m) => fired.push(m));
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(1);
    expect(fired[0].text).toBe('one');
    coalescer.submit('#chan', 'dark', 'two', ctx('dark', '#chan'), (m) => fired.push(m));
    await vi.advanceTimersByTimeAsync(100);
    expect(fired).toHaveLength(2);
    expect(fired[1].text).toBe('two');
    expect(fired[1].fragmentCount).toBe(1);
    vi.useRealTimers();
  });
});
