const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const DEFAULT_MAX_ENTRIES = 10_000;

interface LoginThrottleEntry {
  failures: number[];
  lockedUntil: number | null;
}

export interface LoginThrottle {
  check(username: string, sourceAddress: string, now: Date): boolean;
  recordFailure(username: string, sourceAddress: string, now: Date): void;
  recordSuccess(username: string, sourceAddress: string, now: Date): void;
}

interface LoginThrottleOptions {
  maxEntries?: number;
}

export function createLoginThrottle(options: LoginThrottleOptions = {}): LoginThrottle {
  const attempts = new Map<string, LoginThrottleEntry>();
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let nextExpiryAt = Number.POSITIVE_INFINITY;

  return {
    check(username, sourceAddress, now) {
      cleanupExpiredEntries(now);
      const key = keyFor(username, sourceAddress);
      const entry = attempts.get(key);
      if (!entry) return attempts.size < maxEntries;
      return entry.lockedUntil === null;
    },

    recordFailure(username, sourceAddress, now) {
      cleanupExpiredEntries(now);
      const key = keyFor(username, sourceAddress);
      const existingEntry = attempts.get(key);
      if (!existingEntry && attempts.size >= maxEntries) return;
      const entry = existingEntry ?? { failures: [], lockedUntil: null };
      if (entry.lockedUntil !== null) return;
      entry.failures.push(now.getTime());
      if (entry.failures.length >= MAX_FAILURES) entry.lockedUntil = now.getTime() + WINDOW_MS;
      attempts.set(key, entry);
      nextExpiryAt = Math.min(nextExpiryAt, expiryFor(entry));
    },

    recordSuccess(username, sourceAddress, now) {
      cleanupExpiredEntries(now);
      attempts.delete(keyFor(username, sourceAddress));
    },
  };

  function cleanupExpiredEntries(now: Date): void {
    if (now.getTime() < nextExpiryAt) return;

    nextExpiryAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of attempts) {
      if (entry.lockedUntil !== null) {
        if (entry.lockedUntil <= now.getTime()) {
          attempts.delete(key);
          continue;
        }
      } else {
        pruneFailures(entry, now);
        if (entry.failures.length === 0) {
          attempts.delete(key);
          continue;
        }
      }
      nextExpiryAt = Math.min(nextExpiryAt, expiryFor(entry));
    }
  }
}

function keyFor(username: string, sourceAddress: string): string {
  return `${username}\0${sourceAddress}`;
}

function pruneFailures(entry: LoginThrottleEntry, now: Date): void {
  const cutoff = now.getTime() - WINDOW_MS;
  entry.failures = entry.failures.filter((timestamp) => timestamp >= cutoff);
}

function expiryFor(entry: LoginThrottleEntry): number {
  if (entry.lockedUntil !== null) return entry.lockedUntil;
  // A failure exactly 15 minutes old is still inside the window.
  return (entry.failures[0] ?? Number.POSITIVE_INFINITY) + WINDOW_MS + 1;
}
