/** A lock PIN: 4 to 8 digits. */
export const LOCK_PIN = /^\d{4,8}$/;

/** Lockdown, as the lock screen and Settings see it (never the PIN). */
export type LockStatus = {
  locked: boolean;
  hasPin: boolean;
  /** how many digits the PIN has (the lock screen opens as soon as you've typed that many) */
  digits: number | null;
  lockedAt: number | null;
  /** too many wrong PINs: how long until the next try */
  waitMs: number;
  /** lock when Windows locks or sleeps */
  onWindowsLock: boolean;
  /** locked: how many sessions need you (a number only, nothing about them) */
  needsYou?: number;
};
