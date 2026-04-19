import { describe, expect, it } from 'vitest';

import { ProviderSemaphore } from '../../plugins/ai-chat/concurrency';

describe('ProviderSemaphore', () => {
  it('admits up to capacity, rejects beyond', () => {
    const sem = new ProviderSemaphore(2);
    const r1 = sem.tryAcquire();
    const r2 = sem.tryAcquire();
    const r3 = sem.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).toBeNull();
    expect(sem.active()).toBe(2);
  });

  it('release frees a slot for a subsequent acquire', () => {
    const sem = new ProviderSemaphore(1);
    const r1 = sem.tryAcquire()!;
    expect(sem.tryAcquire()).toBeNull();
    r1();
    expect(sem.active()).toBe(0);
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('release is idempotent — double-release does not under-count', () => {
    const sem = new ProviderSemaphore(2);
    const r1 = sem.tryAcquire()!;
    sem.tryAcquire();
    expect(sem.active()).toBe(2);
    r1();
    r1(); // second release is a no-op
    expect(sem.active()).toBe(1);
  });

  it('capacity 0 disables the cap (admits unconditionally)', () => {
    const sem = new ProviderSemaphore(0);
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.tryAcquire()).not.toBeNull();
    expect(sem.active()).toBe(0); // disabled path doesn't track
  });

  it('reports capacity', () => {
    expect(new ProviderSemaphore(4).capacity()).toBe(4);
  });
});
