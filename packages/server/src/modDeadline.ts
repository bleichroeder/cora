/**
 * A seat Cora just started takes what Cora has for it (its first prompt, offers, a "back on duty" note) through its
 * mod, once the mod first asks. A mod that hasn't come after `waitMs` (the plugin didn't load, a version skew) would
 * leave it all waiting: what waits is taken back and typed into its terminal instead, and the user is told. Until what
 * waited is in, anything more for it waits behind it (never typed into a terminal that isn't ready yet). What can't be
 * typed in (a question on its screen, an error) is never lost: it goes back to wait for the mod, and is tried again.
 */
export type ModDeadlineDeps = {
  waitMs: number;
  /** its mod has asked (it takes what waits itself) */
  modded(sid: string): boolean;
  /** what waits for its mod, taken off the queue (nothing: nothing to do) */
  take(sid: string): string[];
  /** what wasn't typed in, back at the front of the queue for its mod, in order */
  putBack(sid: string, items: string[]): void;
  /** typed into its terminal as one prompt, once it's ready for one: whether it went in, and why not */
  typeIn(sid: string, text: string): Promise<{ sent: boolean; why?: string }>;
  /** the user hears that its mod hadn't come, once what waited is in */
  tell(sid: string): void;
  /** the user hears (once) that what waits couldn't be typed in, and why: it's tried again */
  stuck(sid: string, why: string): void;
  /** what waited is in: from now on it's given things as a session without a mod */
  done(sid: string): void;
  log?(m: string): void;
};

export function modDeadline(o: ModDeadlineDeps): { arm(sid: string): void; armed(sid: string): boolean; typing(sid: string): boolean; add(sid: string, text: string): void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** sessions whose waiting things are being typed in: what came for them since, in order */
  const typing = new Map<string, string[]>();
  /** sessions the user was told couldn't be typed into (said once) */
  const toldStuck = new Set<string>();
  const arm = (sid: string) => {
    if (timers.has(sid) || typing.has(sid)) return;
    const t = setTimeout(() => void fire(sid), o.waitMs);
    t.unref?.();
    timers.set(sid, t);
  };
  const fire = async (sid: string) => {
    timers.delete(sid);
    if (o.modded(sid)) return;
    const items = o.take(sid);
    if (!items.length) return;
    typing.set(sid, []);
    let told = false;
    for (let next = items; next.length; next = typing.get(sid)!.splice(0)) {
      let r: { sent: boolean; why?: string };
      try {
        r = await o.typeIn(sid, next.join('\n\n'));
      } catch (e) {
        r = { sent: false, why: (e as Error)?.message ?? String(e) };
        o.log?.(`team: typing into ${sid.slice(0, 8)} failed: ${r.why}`);
      }
      if (!r.sent) {
        // never lost: back for its mod (or the next try), in order, with what came behind it
        o.putBack(sid, [...next, ...typing.get(sid)!]);
        typing.delete(sid);
        if (!toldStuck.has(sid)) {
          toldStuck.add(sid);
          o.stuck(sid, r.why ?? 'it was not ready for a prompt');
        }
        return arm(sid);
      }
      if (!told) {
        told = true;
        o.tell(sid);
      }
    }
    typing.delete(sid);
    toldStuck.delete(sid);
    o.done(sid);
  };
  return {
    /** Something waits for this session's mod: it's given `waitMs` to come (from the first thing that waits). */
    arm,
    armed: (sid) => timers.has(sid),
    /** What waited for its mod is being typed in now. */
    typing: (sid) => typing.has(sid),
    /** Something more for it while that's typed in: typed in after it. */
    add(sid, text) {
      typing.get(sid)?.push(text);
    },
  };
}

/** What the user is told once what waited for a seat's mod was typed in. */
export function lateModWords(name: string, waitMs: number): string {
  return `${name}'s Cora mod hadn't connected after ${Math.round(waitMs / 1000)} seconds, so what Cora had for it was typed into its terminal instead.`;
}

/** What the user is told when it couldn't be typed in: why, and that it isn't lost. */
export function stuckModWords(name: string, waitMs: number, why: string): string {
  return `${name}'s Cora mod hadn't connected after ${Math.round(waitMs / 1000)} seconds, and what Cora has for it couldn't be typed into its terminal (${why.replace(/\.$/, '')}). It isn't lost: its mod takes it when it connects, or Cora tries typing it in again.`;
}
