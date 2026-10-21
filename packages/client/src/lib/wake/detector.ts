/** A wake-word hit: the score at or over the threshold `patience` chunks in a row, then quiet for `cooldownMs`. */
export class WakeDetector {
  private run = 0;
  private until = 0;
  constructor(private o: { threshold: number; patience?: number; cooldownMs?: number }) {}
  set threshold(t: number) {
    this.o.threshold = t;
  }
  /** One chunk's score; true when it's a hit. */
  score(s: number, now: number): boolean {
    if (now < this.until) return (this.run = 0), false;
    this.run = s >= this.o.threshold ? this.run + 1 : 0;
    if (this.run < (this.o.patience ?? 2)) return false;
    this.run = 0;
    this.until = now + (this.o.cooldownMs ?? 2000);
    return true;
  }
}
