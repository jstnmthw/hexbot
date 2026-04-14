// Duration parsing and formatting utilities for ban durations and other time-based features.

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Upper bound on a parsed duration: one year of milliseconds. Anything
 * larger is almost certainly an admin typo (`.ban user 9999999d`) and,
 * critically, `setTimeout` wraps around `2**31 - 1` ms (~24.8 days) and
 * fires after 1 ms when that happens. Clamping here keeps callers from
 * accidentally scheduling an instant-fire timer.
 */
const MAX_DURATION_MS = 365 * 86_400_000;

/**
 * Parse a human-readable duration string into milliseconds.
 * Supports: bare number (minutes for backward compat), `Nm`, `Nh`, `Nd`, `0` (permanent → 0).
 * Returns null for invalid input.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  // "0" means permanent
  if (trimmed === '0') return 0;

  // Suffixed format: 5m, 2h, 1d
  const match = trimmed.match(/^(\d+)([mhd])$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    if (value === 0) return 0;
    const unit = match[2].toLowerCase();
    return Math.min(value * UNIT_MS[unit], MAX_DURATION_MS);
  }

  // Bare number → minutes (backward compat with chanmod)
  const num = parseInt(trimmed, 10);
  if (!Number.isNaN(num) && String(num) === trimmed && num >= 0) {
    if (num === 0) return 0;
    return Math.min(num * UNIT_MS.m, MAX_DURATION_MS);
  }

  return null;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Returns "permanent" for 0, "expired" for negative values.
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return 'permanent';
  if (ms < 0) return 'expired';

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);

  return parts.join(' ');
}
