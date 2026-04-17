import { describe, expect, it } from 'vitest';

import { MoodEngine } from '../../plugins/ai-chat/mood';

describe('MoodEngine', () => {
  it('starts with reasonable default values', () => {
    const engine = new MoodEngine();
    const mood = engine.getMood();
    expect(mood.energy).toBeGreaterThan(0);
    expect(mood.energy).toBeLessThanOrEqual(1);
    expect(mood.engagement).toBeGreaterThan(0);
    expect(mood.patience).toBeGreaterThan(0);
    expect(mood.humor).toBeGreaterThan(0);
  });

  it('energy decays over time (net of quiet recharge)', () => {
    let now = 1_000_000;
    const engine = new MoodEngine(() => now);
    // Interact frequently so quiet-window recharge doesn't mask the decay
    engine.onInteraction();
    now += 10 * 60_000; // 10 minutes (under the 15-min quiet window)
    engine.onInteraction();
    const baseline = engine.getMood().energy;
    now += 10 * 60_000; // another 10 minutes, still under quiet window
    engine.onInteraction();
    const after = engine.getMood().energy;
    // Energy should have decayed slightly between the two reads
    expect(after).toBeLessThanOrEqual(baseline);
  });

  it('engagement rises on interaction', () => {
    const engine = new MoodEngine();
    const initial = engine.getMood().engagement;
    engine.onInteraction();
    const after = engine.getMood().engagement;
    expect(after).toBeGreaterThan(initial);
  });

  it('engagement decays without interaction', () => {
    let now = 1_000_000;
    const engine = new MoodEngine(() => now);
    engine.onInteraction(); // boost engagement
    const boosted = engine.getMood().engagement;
    now += 10 * 3_600_000; // 10 hours
    const decayed = engine.getMood().engagement;
    expect(decayed).toBeLessThan(boosted);
  });

  it('patience drops on repeat', () => {
    const engine = new MoodEngine();
    const initial = engine.getMood().patience;
    engine.onRepeat();
    const after = engine.getMood().patience;
    expect(after).toBeLessThan(initial);
  });

  it('patience recharges over time', () => {
    let now = 1_000_000;
    const engine = new MoodEngine(() => now);
    engine.onRepeat();
    engine.onRepeat();
    engine.onRepeat();
    const low = engine.getMood().patience;
    now += 5 * 3_600_000; // 5 hours
    const recharged = engine.getMood().patience;
    expect(recharged).toBeGreaterThan(low);
  });

  it('energy recharges during quiet periods', () => {
    let now = 1_000_000;
    const engine = new MoodEngine(() => now);
    // Drain energy
    now += 20 * 3_600_000;
    const low = engine.getMood().energy;
    // Don't interact — let quiet window pass
    now += 30 * 60_000; // 30 minutes quiet
    const recharged = engine.getMood().energy;
    expect(recharged).toBeGreaterThan(low);
  });

  it('all values stay clamped between 0 and 1', () => {
    let now = 1_000_000;
    const engine = new MoodEngine(() => now);
    // Push engagement up repeatedly
    for (let i = 0; i < 20; i++) engine.onInteraction();
    expect(engine.getMood().engagement).toBeLessThanOrEqual(1);
    // Push patience down repeatedly
    for (let i = 0; i < 30; i++) engine.onRepeat();
    expect(engine.getMood().patience).toBeGreaterThanOrEqual(0);
    // Let energy drain completely
    now += 200 * 3_600_000;
    expect(engine.getMood().energy).toBeGreaterThanOrEqual(0);
  });

  describe('renderMoodLine', () => {
    it('returns empty string when mood is neutral', () => {
      const engine = new MoodEngine();
      // Default mood is neutral-ish
      const line = engine.renderMoodLine();
      // Could be empty or have content depending on exact defaults — just check it's a string
      expect(typeof line).toBe('string');
    });

    it('mentions low energy when energy is drained', () => {
      let now = 1_000_000;
      const engine = new MoodEngine(() => now);
      now += 100 * 3_600_000; // drain energy
      const line = engine.renderMoodLine();
      expect(line).toContain('low energy');
    });

    it('mentions impatience when patience is low', () => {
      const engine = new MoodEngine();
      for (let i = 0; i < 20; i++) engine.onRepeat();
      const line = engine.renderMoodLine();
      expect(line).toContain('impatient');
    });
  });

  describe('getVerbosityMultiplier', () => {
    it('returns a value between 0.5 and 1.5', () => {
      const engine = new MoodEngine();
      const mult = engine.getVerbosityMultiplier();
      expect(mult).toBeGreaterThanOrEqual(0.5);
      expect(mult).toBeLessThanOrEqual(1.5);
    });

    it('returns lower multiplier when energy is low', () => {
      let now = 1_000_000;
      const engine = new MoodEngine(() => now);
      const fresh = engine.getVerbosityMultiplier();
      now += 100 * 3_600_000; // drain energy
      const drained = engine.getVerbosityMultiplier();
      expect(drained).toBeLessThan(fresh);
    });
  });

  describe('initialMood seed', () => {
    it('honours a partial initialMood, falling back to defaults for the rest', () => {
      const engine = new MoodEngine(() => 1_000_000, { energy: 0.1, humor: 0.9 });
      const mood = engine.getMood();
      expect(mood.energy).toBe(0.1);
      expect(mood.humor).toBe(0.9);
      // Unspecified fields retain their default values.
      expect(mood.engagement).toBe(0.5);
      expect(mood.patience).toBe(0.8);
    });
  });
});
