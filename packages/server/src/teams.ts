import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_ESCALATION_AFTER, diffTeam, poolCap, groupContains, itemOpen, listWords, teamChangeLines, textChange, resolveGroup, routeAllows, seatAgentName, seatCard, seatHandle, seatsOf, type Endpoint, type Escalation, type MsgKind, type Project, type ProjectItem, type Route, type Seat, type Team, type TeamChange, type Watch } from '@cora/shared';
import { openItem } from './projectItems';
import { seatFiles, teamPluginDir, writeTeamArtifacts } from './teamAgents';
import { watchWords } from './mailWatches';
import type { Projects } from './projects';

/** A seat's launch: its agent (in its team's plugin, `pluginDir`), prompt and settings files, permission mode. */
export type SeatArgs = { agent: string; pluginDir: string; prompt: string; settings: string; permissionMode?: string };
/** `label`: what the session is called in Cora (its seat's name, and its instance in a pool) */
type LaunchOpts = { cwd: string; worktree?: boolean; seat: SeatArgs; name: string; label?: string; prompt?: string };

export type TeamDeps = {
  projects: Projects; dataDir: string; pluginDir: string | null; now(): number;
  /** `made`: its folder wasn't there and was made; `noRepo`: it wanted a worktree, but its folder isn't a git repository (it works in the folder itself) */
  launch(o: LaunchOpts): Promise<{ sessionId: string; made?: boolean; noRepo?: boolean } | { error: string }>;
  /** a member that ended, resumed as itself (its memory; its seat's launch from the team as it is now); absent: seats always start fresh */
  resume?(sid: string): Promise<{ sessionId: string } | { error: string }>;
  stop(sid: string): void; live(sid: string): boolean; idle(sid: string): boolean;
  /** a member the team let go for good (it left the project): out of the session list too (undoable, like any dismiss) */
  dismiss?(sid: string): void;
  /** a seat's watch for its new member (without `watches`: each member sets its own once) */
  watch?(sid: string, w: Watch): void;
  deliver(sid: string, text: string): void; tell(text: string, o?: { dm?: boolean }): void;
  /**
   * a seat's standing watches (one per seat, whatever its count): kept pointing at its owner member (its lowest live
   * instance), again after one fired or before it runs out; dropped when the seat stands down
   */
  watches?: SeatWatches;
  /** the seat's coordination card (its instructions' tail); defaults to the seat's card from the team */
  card?: (pid: string, seat: Seat) => string;
  /** a route that wakes on ask: asks the user (Cora's wake card) to wake an idle member with this offer; absent, it is delivered */
  askWake?: (pid: string, sid: string, text: string, item: string) => void;
  /** the seats' turns and cost (their limits): 'blocked' escalation measures how long a seat has been over one */
  usage?: TeamUsage;
  /** since when a session has had an approval waiting for the user (its oldest), or null: 'blocked' counts that too */
  askingSince?: (sid: string) => number | null;
};

/** A seat's standing watches, as Cora keeps them (k: the watch's place in the seat's startup.watches; drop: from `from` on, default all). */
export type SeatWatches = { ensure(pid: string, seat: Seat, sid: string, k: number, w: Watch): void; drop(pid: string, seatId: string, from?: number): void };

const MIN = 60_000;
const HOUR = 60 * MIN;
/** minutes to wait before starting a standing seat again, after each failure in a row */
const BACKOFF = [1, 2, 4, 8, 16, 30];
/** this many failures to start within FAIL_WINDOW: no more tries until the user brings the team up */
const FAILS = 3;
const FAIL_WINDOW = 10 * MIN;
/** a member gone within this long of its start: the start failed */
const SETTLE = 3 * MIN;
/** a member stood down that hasn't closed after this long isn't waited for: its seat starts (or resumes) another */
const CLOSE_WAIT = 2 * MIN;

/** a standing seat's starts: failures in a row, every start lately, the last (successful) one */
type Starts = { fails: number; recent: number[]; lastError?: string; nextTryAt?: number; failing?: boolean; startedAt?: number };

/** A team's seats running as Claude Code sessions Cora hosts. */
export class TeamRuntime {
  constructor(private d: TeamDeps) {}

  /** projects whose team was brought up (and not stood down): their standing seats are kept running */
  private up = new Set<string>();
  /** seats stood down on their own (project → seats): not started again until Bring up */
  private down = new Map<string, Set<string>>();
  /** escalation steps fired: `${pid}|${item}` → `${rule}|${step}` (in memory: a restart may fire one again) */
  private fired = new Map<string, Set<string>>();
  /** restarts of standing seats: `${pid}|${seat}` */
  private starts = new Map<string, Starts>();
  /** when each pool member was first seen idle (reset when it isn't) */
  private idleSince = new Map<string, number>();
  private ticking = false;
  /** each project's launches, one after another (bringUp, dispatch, the tick's restarts): never two at once */
  private chains = new Map<string, Promise<unknown>>();
  /** members this runtime stopped that may still be closing (since when it asked): no longer members */
  private stopping = new Map<string, number>();
  /** members stood down (a seat's standing ones): they stay in the project and Bring up resumes them */
  private parked = new Set<string>();
  /**
   * members that died and were brought back once (when): dying again, they're replaced by a fresh one; one that stays up
   * past SETTLE is healthy again (a later death is a new incident: brought back once again)
   */
  private revived = new Map<string, number>();
  /**
   * members that ended, being replaced by Start fresh (project → members, while its Bring up runs): not resumed; the
   * new member of their seat takes what they held
   */
  private replacing = new Map<string, Set<string>>();
  /** seats whose live members run an older definition (project → seats): they need a restart (kept on the project) */
  private pending = new Map<string, Set<string>>();
  /** pools made smaller (`${pid}|${seat}`): their members above count.max close once idle, then it's over (kept on the project) */
  private trim = new Set<string>();
  /** what was said about the seats' folders since each project's last Bring up (`${kind}|${seat}`): said once */
  private toldFolders = new Map<string, Set<string>>();
  /** a Bring up under way: what it has to say about folders, said together when it's done */
  private folderNotes = new Map<string, FolderNote[]>();

  /** Runs `fn` after the project's launches before it (whatever they came to). */
  private serial<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(pid) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.chains.set(pid, tail);
    void tail.then(() => this.chains.get(pid) === tail && this.chains.delete(pid));
    return run;
  }

  /** After a restart: the teams that were up are kept running again (their missing seats start on the next tick). */
  resume(): string[] {
    const out: string[] = [];
    for (const p of this.d.projects.list()) {
      if (!p.team || !p.teamUp || p.archivedAt) continue;
      this.up.add(p.id);
      if (p.teamDown?.length) this.down.set(p.id, new Set(p.teamDown));
      // what it was waiting for: seats to restart, pools to shrink
      if (p.teamRestart?.length) this.pending.set(p.id, new Set(p.teamRestart));
      for (const id of p.teamTrim ?? []) this.trim.add(`${p.id}|${id}`);
      out.push(p.id);
    }
    return out;
  }

  /** Whether the team was brought up (and not stood down). */
  isUp(pid: string): boolean {
    return this.up.has(pid);
  }

  /** A project's live members, optionally of one seat. */
  private members(pid: string, seat?: string): { sid: string; seat: string; instance?: number }[] {
    const p = this.d.projects.get(pid);
    return Object.entries(p?.members ?? {})
      .filter(([sid, m]) => m.seat && (!seat || m.seat === seat) && this.d.live(sid) && !this.stopping.has(sid))
      .map(([sid, m]) => ({ sid, seat: m.seat!, instance: m.instance }));
  }

  /** The lowest instance number a seat's live members (and `also`) don't use. */
  private nextInstance(pid: string, seatId: string, also: number[] = []): number {
    const taken = new Set([...this.members(pid, seatId).map((m) => m.instance ?? 1), ...also]);
    let n = 1;
    while (taken.has(n)) n++;
    return n;
  }

  /** Writes the team's agents, skills and settings; why it couldn't, or null. */
  private writeArtifacts(pid: string, team: Team): string | null {
    try {
      writeTeamArtifacts(this.d.dataDir, pid, team, (seat) => (this.d.card ?? ((_pid, s) => seatCard(team, s.id)))(pid, seat));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  /** Starts a seat's missing members (up to its count.min, or `want`); stops at the first failure. */
  private async fill(pid: string, seat: Seat, want = seat.count.min): Promise<{ started: string[]; error?: string }> {
    const started: string[] = [];
    const pool = seat.count.max > 1;
    const used: number[] = [];
    // its members stood down that are still closing count: the next tick resumes them once closed (none start for them)
    let have = this.members(pid, seat.id).length + this.closingParked(pid, seat.id).length;
    // none running: what comes back runs the seat's current definition (a resumed member's launch is rebuilt from it)
    if (!have) this.unpend(pid, seat.id);
    // its members that ended come back first, as themselves (their memory and history), lowest instance first
    const liveAt = new Set(this.members(pid, seat.id).map((m) => m.instance ?? 1));
    for (const m of this.ended(pid, seat.id)) {
      if (have >= want || !this.d.resume) break;
      // one that died again after being brought back is replaced by a fresh one (and one Start fresh replaces)
      if ((this.revived.has(m.sid) && !this.parked.has(m.sid)) || this.replacing.get(pid)?.has(m.sid)) continue;
      // its number taken by a live member meanwhile: not two of one number
      if (liveAt.has(m.instance ?? 1)) continue;
      const r = await this.resumeMember(pid, seat, m.sid);
      if ('error' in r) {
        console.warn(`[cora] team: ${seat.name}'s member ${m.sid} couldn't be resumed (${r.error.replace(/\.$/, '')}): a new one starts in its place`);
        continue;
      }
      started.push(r.sessionId);
      used.push(m.instance ?? 1);
      liveAt.add(m.instance ?? 1);
      have++;
    }
    for (; have < want; have++) {
      const n = this.nextInstance(pid, seat.id, used);
      const r = await this.launchSeat(pid, seat, pool ? n : undefined);
      if ('error' in r) return { started, error: r.error };
      started.push(r.sessionId);
      used.push(n);
    }
    return { started };
  }

  /** Starts the standing seats that are missing (up to each one's count.min); from now on they are kept running. */
  bringUp(pid: string, o: { fresh?: boolean } = {}): Promise<{ started: string[]; problems: string[] }> {
    return this.serial(pid, () => this.bringUpNow(pid, o));
  }

  private async bringUpNow(pid: string, o: { fresh?: boolean } = {}): Promise<{ started: string[]; problems: string[] }> {
    const started: string[] = [];
    const problems: string[] = [];
    const team = this.d.projects.get(pid)?.team;
    if (!team) return { started, problems: ['This project has no team.'] };
    if (!this.d.pluginDir) return { started, problems: ['Teams need Claude Code 2.1.287 or later (claude update).'] };
    const why = this.writeArtifacts(pid, team);
    if (why) return { started, problems: [why] };
    // a clean slate: its members that ended are let go (the new member of their seat takes what they held), ones still
    // closing once they close, and every seat starts new
    if (o.fresh) {
      const p = this.d.projects.get(pid);
      const replacing = new Set<string>();
      for (const [sid, m] of Object.entries(p?.members ?? {})) {
        if (!m.seat) continue;
        if (this.stopping.has(sid)) this.parked.delete(sid);
        else if (!this.d.live(sid)) replacing.add(sid);
      }
      this.replacing.set(pid, replacing);
    }
    // what it finds about the seats' folders is said once, together, when it's done
    this.toldFolders.delete(pid);
    this.folderNotes.set(pid, []);
    try {
      this.up.add(pid);
      this.down.delete(pid);
      // its seats post and hear through the project: coordination on
      if (!this.d.projects.get(pid)?.coordination) this.d.projects.update(pid, { coordination: true });
      this.d.projects.setTeamUp(pid, true);
      this.d.projects.setTeamDown(pid, []);
      for (const seat of team.seats) {
        const r = await this.startSeat(pid, seat);
        started.push(...r.started);
        if (r.error) problems.push(r.error);
      }
      // Start fresh: the ones no new member replaced (a seat that starts none) are let go all the same
      for (const sid of this.replacing.get(pid) ?? []) if (this.d.projects.get(pid)?.members[sid]) this.release(pid, sid);
      this.fillLead(pid, team);
    } finally {
      // this project's only; a start that threw leaves them (the next Bring up resumes them)
      this.replacing.delete(pid);
      const notes = this.folderNotes.get(pid) ?? [];
      this.folderNotes.delete(pid);
      this.sayFolders(pid, notes);
    }
    return { started, problems };
  }

  /** Starts a seat's missing members (to count.min, or `want`), as Bring up does: a fresh record of its starts. */
  private async startSeat(pid: string, seat: Seat, want?: number): Promise<{ started: string[]; error?: string }> {
    const r = await this.fill(pid, seat, want);
    // a fresh record: these starts count (a member gone soon after is a failed start)
    if (!r.error && r.started.length) this.starts.set(`${pid}|${seat.id}`, { fails: 0, recent: [this.d.now()], startedAt: this.d.now() });
    else if (!r.error) this.starts.delete(`${pid}|${seat.id}`);
    return r;
  }

  /** A seat's members stood down (kept for Bring up) that are still closing, for less than CLOSE_WAIT. */
  private closingParked(pid: string, seatId: string, now = this.d.now()): string[] {
    const p = this.d.projects.get(pid);
    return [...this.stopping].filter(([sid, at]) => now - at < CLOSE_WAIT && this.parked.has(sid) && p?.members[sid]?.seat === seatId).map(([sid]) => sid);
  }

  /** A seat's members that ended (not live, not closing), lowest instance first. */
  private ended(pid: string, seatId: string): { sid: string; instance?: number }[] {
    const p = this.d.projects.get(pid);
    return Object.entries(p?.members ?? {})
      .filter(([sid, m]) => m.seat === seatId && !this.d.live(sid) && !this.stopping.has(sid))
      .map(([sid, m]) => ({ sid, instance: m.instance }))
      .sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1));
  }

  /** A member that ended, resumed as itself and told it's back (its card may have changed while it was down). */
  private async resumeMember(pid: string, seat: Seat, sid: string): Promise<{ sessionId: string } | { error: string }> {
    if (this.parked.delete(sid)) this.revived.delete(sid);
    else this.revived.set(sid, this.d.now());
    const r = await this.d.resume!(sid);
    if ('error' in r) return r;
    this.stopping.delete(r.sessionId);
    const name = this.d.projects.get(pid)?.name ?? 'the project';
    this.d.deliver(r.sessionId, `You're back on duty as ${seat.name} in ${name}: the team was brought up again. Read your project card for anything that changed while you were down, then carry on.`);
    return r;
  }

  /**
   * A seat's members that ended (not live, not closing) in the place of `to`, its new member (the same number), leave
   * the project, so a seat's handle names only its live member: one stood down, or one that died and is being replaced.
   * `to` takes what they held (the lead, what was waiting for them, the incidents they owned). Ones of other numbers
   * stay for the members started in their place (or the tick lets them go); a pool grown (a number above them) takes nothing.
   */
  private forgetEnded(pid: string, seatId: string, to: string): void {
    const p = this.d.projects.get(pid);
    const n = p?.members[to]?.instance ?? 1;
    for (const [sid, m] of Object.entries(p?.members ?? {}))
      if (m.seat === seatId && sid !== to && (m.instance ?? 1) === n && !this.d.live(sid) && !this.stopping.has(sid)) this.release(pid, sid, to);
  }

  /**
   * A member the team let go for good: it leaves the project, and the session list. What it held (the lead, what was
   * waiting for it, the incidents it owned) passes to `to`, else to the live member now in its place (its seat and
   * number), else to its seat's lowest-numbered live member; with nobody live in its seat, the user is told what it held.
   */
  private release(pid: string, sid: string, to?: string): void {
    this.parked.delete(sid);
    this.revived.delete(sid);
    this.replacing.get(pid)?.delete(sid);
    const heir = to ?? this.successor(pid, sid);
    if (heir) this.d.projects.handOver(pid, sid, heir);
    else this.tellHeld(pid, sid);
    this.d.projects.leave(pid, sid);
    this.d.dismiss?.(sid);
  }

  /** The live member in a member's place (its seat and instance), else its seat's lowest-numbered live member, or undefined. */
  private successor(pid: string, sid: string): string | undefined {
    const m = this.d.projects.get(pid)?.members[sid];
    if (!m?.seat) return undefined;
    const others = this.members(pid, m.seat).filter((x) => x.sid !== sid).sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1));
    return (others.find((x) => (x.instance ?? 1) === (m.instance ?? 1)) ?? others[0])?.sid;
  }

  /** A member leaving with nobody in its place: the user is told if it was the lead or owned open incidents. */
  private tellHeld(pid: string, sid: string): void {
    const p = this.d.projects.get(pid);
    const m = p?.members[sid];
    if (!p || !m) return;
    const lead = p.lead === sid;
    const owned = (p.items ?? []).filter((i) => (i.kind === 'incident' || i.kind === 'task') && i.owner === sid && itemOpen(i)).map((i) => `"${i.title}"`);
    if (!lead && !owned.length) return;
    const seat = p.team?.seats.find((s) => s.id === m.seat);
    const who = seat ? (m.instance !== undefined && seat.count.max > 1 ? `${seat.name} ${m.instance}` : seat.name) : 'A member';
    const held = [lead ? "was the project's lead" : '', owned.length ? `owned ${owned.join(', ')}` : ''].filter(Boolean).join(' and ');
    const todo = [lead ? 'pick a new lead' : '', owned.length ? `give ${owned.length > 1 ? 'them new owners' : 'it a new owner'}` : ''].filter(Boolean).join(' and ');
    this.d.tell(`${p.name}: ${who} left the team while it ${held}: ${todo}.`);
  }

  /** Stops a member (it may take a moment to close: it isn't one from now on). */
  private stopMember(sid: string): void {
    this.stopping.set(sid, this.d.now());
    this.d.stop(sid);
  }

  /** Stops a seat's live members and drops its watches. */
  private stopSeat(pid: string, seatId: string): void {
    this.d.watches?.drop(pid, seatId);
    for (const m of this.members(pid, seatId)) this.stopMember(m.sid);
  }

  /** A seat no longer stood down on its own. */
  private undown(pid: string, seatId: string): void {
    const down = this.down.get(pid);
    if (!down?.delete(seatId)) return;
    this.d.projects.setTeamDown(pid, [...down]);
  }

  /** A seat no longer waits for a restart (kept on the project: a Cora restart still asks for it). */
  private unpend(pid: string, seatId: string): void {
    const set = this.pending.get(pid);
    if (!set?.delete(seatId)) return;
    this.d.projects.setTeamRestart(pid, [...set]);
  }

  /** A pool made smaller, or done shrinking (kept on the project: a Cora restart still closes its extras). */
  private setTrim(pid: string, seatId: string, on: boolean): void {
    const key = `${pid}|${seatId}`;
    if (on === this.trim.has(key)) return;
    if (on) this.trim.add(key);
    else this.trim.delete(key);
    this.d.projects.setTeamTrim(pid, [...this.trim].filter((k) => k.startsWith(`${pid}|`)).map((k) => k.slice(pid.length + 1)));
  }

  /** The seats waiting for a restart (their members run an older definition). */
  restarts(pid: string): string[] {
    const seats = new Set((this.d.projects.get(pid)?.team?.seats ?? []).map((s) => s.id));
    return [...(this.pending.get(pid) ?? [])].filter((id) => seats.has(id));
  }

  /**
   * An edit to the team, applied to its running seats: its files
   * written first; then, when the team is up, seats added start, seats removed stand down, a retasked seat's members are
   * told, a pool resized starts to its new min (its extras close once idle), changed watches are set again. Changes
   * that need a restart are only collected (`restart`).
   */
  applyEdit(pid: string, previous: Team | undefined, next: Team): Promise<{ changes: TeamChange[]; restart: string[]; problems: string[] }> {
    return this.serial(pid, () => this.applyEditNow(pid, previous, next));
  }

  private async applyEditNow(pid: string, previous: Team | undefined, next: Team): Promise<{ changes: TeamChange[]; restart: string[]; problems: string[] }> {
    const changes = diffTeam(previous, next);
    const restart: string[] = [];
    const problems: string[] = [];
    const why = this.d.pluginDir ? this.writeArtifacts(pid, next) : null;
    if (why) problems.push(why);
    // a new lead seat: no lead chosen before is over (the new seat leads)
    if (previous?.lead !== next.lead) this.d.projects.endLeadNone(pid);
    const p = this.d.projects.get(pid);
    if (!p || !this.up.has(pid)) return { changes, restart, problems };
    for (const c of changes) {
      const id = c.seat ?? '';
      const seat = next.seats.find((s) => s.id === id);
      if (c.kind === 'seat-removed') {
        this.stopSeat(pid, id);
        this.undown(pid, id);
        this.unpend(pid, id);
        this.starts.delete(`${pid}|${id}`);
        this.setTrim(pid, id, false);
      } else if (!seat) continue;
      else if (c.kind === 'seat-added' || c.kind === 'pool-resized') {
        if (c.kind === 'pool-resized' && this.members(pid, id).length > seat.count.max) this.setTrim(pid, id, true);
        // never for a seat stood down on its own, nor with its files not written
        if (why || this.down.get(pid)?.has(id) || this.members(pid, id).length >= seat.count.min) continue;
        const r = await this.startSeat(pid, seat);
        if (r.error) problems.push(r.error);
      } else if (c.kind === 'seat-retasked') {
        // what changed (textChange: a long role's edit is the part that differs, not its unchanged start, with a few
        // words around it so it can be found); its whole new text is its prompt's once it restarts
        const was = previous?.seats.find((s) => s.id === id)?.instructions;
        const change = textChange(was, seat.instructions, 300, 4);
        // (a full stop, unless it already ends one: a quote ending `the user."`, or a cut ending `…`)
        const stop = /(…|[.!?]["”']?)$/.test(change) ? '' : '.';
        for (const m of this.members(pid, id)) this.d.deliver(m.sid, `Your role in ${p.name} changed: ${change}${stop} Follow it from now on; your full instructions update when you next restart.`);
      } else if (c.kind === 'seat-restart-needed') {
        if (!this.members(pid, id).length) continue;
        restart.push(id);
        const set = this.pending.get(pid) ?? new Set<string>();
        set.add(id);
        this.pending.set(pid, set);
        this.d.projects.setTeamRestart(pid, [...set]);
      } else if (c.kind === 'watches-changed') {
        // the ones past its new list go (by id); the rest are set again with their new words
        this.d.watches?.drop(pid, id, seat.startup.watches?.length ?? 0);
        this.keepWatches(pid, seat);
      }
    }
    this.fillLead(pid, next, previous?.lead);
    return { changes, restart, problems };
  }

  /** A live member of the project (not one being stopped). */
  private liveMember(pid: string, sid: string | undefined): sid is string {
    return !!sid && !!this.d.projects.get(pid)?.sessions.includes(sid) && this.d.live(sid) && !this.stopping.has(sid);
  }

  /** The lead seat's first live member (its lowest instance), or undefined. */
  private leadMember(pid: string, team: Team): string | undefined {
    return team.lead ? this.members(pid, team.lead).sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1))[0]?.sid : undefined;
  }

  /**
   * Brought up or applied: a team that names a lead seat gives the project its lead, that seat's first live member,
   * unless a live member of the project leads already. A lead the team gave before (a member of `was`, its lead seat
   * until this edit) moves to the new lead seat; one you set by hand on another seat's member stays. No lead, when you
   * chose it, stays.
   */
  private fillLead(pid: string, team: Team, was?: string): void {
    const p = this.d.projects.get(pid);
    if (!p || !team.lead || p.leadNone) return;
    const cur = p.lead;
    const theTeams = !!was && was !== team.lead && !!cur && p.members[cur]?.seat === was;
    if (this.liveMember(pid, cur) && !theTeams) return;
    const next = this.leadMember(pid, team);
    if (next && next !== cur) this.d.projects.update(pid, { lead: next });
  }

  /** The lead seat's member that leads has gone (not live): another live member of that seat leads in its place. */
  private keepLead(pid: string, team: Team): void {
    const p = this.d.projects.get(pid);
    const cur = p?.lead;
    if (!p || !team.lead || !cur || p.members[cur]?.seat !== team.lead || this.liveMember(pid, cur)) return;
    const next = this.leadMember(pid, team);
    if (next) this.d.projects.update(pid, { lead: next });
  }

  /** Stands these seats down and brings them up again (their new definition), one after another. */
  restartSeats(pid: string, seats: string[]): Promise<{ started: string[]; problems: string[] }> {
    return this.serial(pid, async () => {
      for (const id of seats) this.unpend(pid, id);
      const team = this.d.projects.get(pid)?.team;
      if (!team) return { started: [], problems: ['This project has no team.'] };
      if (!this.up.has(pid)) return { started: [], problems: ["The team isn't up: bring it up instead."] };
      if (!this.d.pluginDir) return { started: [], problems: ['Teams need Claude Code 2.1.287 or later (claude update).'] };
      const why = this.writeArtifacts(pid, team);
      if (why) return { started: [], problems: [why] };
      const started: string[] = [];
      const problems: string[] = [];
      for (const id of seats) {
        const seat = team.seats.find((s) => s.id === id);
        if (!seat) {
          problems.push(`This team has no seat "${id}".`);
          continue;
        }
        // as many as were running come back (at least its minimum): a pool with no minimum isn't stood down by it
        const had = this.members(pid, id).length;
        this.stopSeat(pid, id);
        this.undown(pid, id);
        const r = await this.startSeat(pid, seat, Math.min(seat.count.max, Math.max(seat.count.min, had)));
        started.push(...r.started);
        if (r.error) problems.push(r.error);
      }
      return { started, problems };
    });
  }

  /** `work`: what it is started for, after its startup prompt. */
  private async launchSeat(pid: string, seat: Seat, instance?: number, work?: string): Promise<{ sessionId: string } | { error: string }> {
    // none running: every member from now on runs its current definition
    const fresh = !this.members(pid, seat.id).length;
    const startup = [seat.startup.prompt, seat.startup.monitor ? `Start a Monitor on: ${seat.startup.monitor} and act on what it reports.` : undefined].filter(Boolean).join('\n');
    const first = [startup, work].filter(Boolean).join('\n\n');
    const r = await this.d.launch({
      cwd: seat.folder.path,
      ...(seat.folder.worktree ? { worktree: true } : {}),
      seat: this.seatArgs(pid, seat),
      name: seatHandle(pid, seat.id, instance),
      label: instance === undefined ? seat.name : `${seat.name} ${instance}`,
      ...(first ? { prompt: first } : {}),
    });
    if ('error' in r) return r;
    if (r.made) this.noteFolder(pid, 'made', seat);
    if (r.noRepo) this.noteFolder(pid, 'no-repo', seat);
    if (fresh) this.unpend(pid, seat.id);
    // a session id stopped before and live again is a member again
    this.stopping.delete(r.sessionId);
    this.d.projects.add(pid, r.sessionId);
    this.d.projects.setSeat(pid, r.sessionId, seat.id, instance);
    // its member that ended in its place (its number) leaves the project: the new one takes its handle and what it held
    this.forgetEnded(pid, seat.id, r.sessionId);
    // it's started whatever its watches do: one that can't be set is said, never a failed launch
    try {
      if (this.d.watches) this.keepWatches(pid, seat);
      else for (const w of seat.startup.watches ?? []) this.d.watch?.(r.sessionId, w);
    } catch (e) {
      this.d.tell(`${seat.name} started, but its watch couldn't be set: ${String((e as Error)?.message ?? e).replace(/\.$/, '')}.`);
    }
    return r;
  }

  /** What a launch found about a seat's folder: said once a Bring up (with the rest of that Bring up's, when one runs). */
  private noteFolder(pid: string, kind: FolderNote['kind'], seat: Seat): void {
    const told = this.toldFolders.get(pid) ?? new Set<string>();
    this.toldFolders.set(pid, told);
    if (told.has(`${kind}|${seat.id}`)) return;
    told.add(`${kind}|${seat.id}`);
    const note: FolderNote = { kind, name: seat.name, path: seat.folder.path };
    const batch = this.folderNotes.get(pid);
    if (batch) batch.push(note);
    else this.sayFolders(pid, [note]);
  }

  /** The notes about folders, a line per folder and kind: the folder made, the seats working in it itself. */
  private sayFolders(pid: string, notes: FolderNote[]): void {
    const name = this.d.projects.get(pid)?.name ?? 'The team';
    const lines = new Map<string, { kind: FolderNote['kind']; path: string; names: string[] }>();
    for (const n of notes) {
      const k = `${n.kind}|${n.path}`;
      const l = lines.get(k) ?? { kind: n.kind, path: n.path, names: [] };
      if (!l.names.includes(n.name)) l.names.push(n.name);
      lines.set(k, l);
    }
    for (const l of lines.values()) {
      const many = l.names.length > 1;
      this.d.tell(
        l.kind === 'made'
          ? `${name}: ${l.path} wasn't there, so Cora made it.`
          : `${name}: ${listWords(l.names)} work${many ? '' : 's'} in ${l.path} itself: it isn't a git repository, so ${many ? 'they have no worktrees of their own' : 'it has no worktree of its own'}.`,
      );
    }
  }

  /** A seat's launch arguments: its agent in its team's plugin, its files, its permission mode. */
  private seatArgs(pid: string, seat: Seat): SeatArgs {
    const f = seatFiles(this.d.dataDir, pid, seat.id);
    // 'default': no mode of its own (Claude Code has no --permission-mode default)
    const mode = seat.agent.permissionMode && seat.agent.permissionMode !== 'default' ? seat.agent.permissionMode : undefined;
    return { agent: seatAgentName(pid, seat.id), pluginDir: teamPluginDir(this.d.dataDir, pid), prompt: f.prompt, settings: f.settings, ...(mode ? { permissionMode: mode } : {}) };
  }

  /**
   * A seated member being resumed comes back as its seat: its launch rebuilt from the current team (its files written
   * again) with its name. Its seat gone from the team (or the team gone): null, and the member no longer has a seat (it
   * resumes as a plain session). Not a seated member, or teams not available here: null.
   */
  resumeSeat(sid: string): { seat: SeatArgs; name: string } | null {
    const p = this.d.projects.projectOf(sid);
    const m = p?.members[sid];
    if (!p || !m?.seat) return null;
    const seat = p.team?.seats.find((s) => s.id === m.seat);
    if (!seat) {
      this.d.projects.setSeat(p.id, sid, null);
      return null;
    }
    if (!this.d.pluginDir || this.writeArtifacts(p.id, p.team!)) return null;
    // a member stopped before and live again is a member again (one stood down, back by hand, is no longer kept for Bring up)
    this.stopping.delete(sid);
    this.parked.delete(sid);
    return { seat: this.seatArgs(p.id, seat), name: seatHandle(p.id, seat.id, m.instance) };
  }

  /**
   * Offers an item to the free (live, idle) members of these seats as the route's wake allows: who was offered it, and
   * who has it now (`got`: delivered, not a wake card waiting for the user).
   */
  private offer(pid: string, seats: string[], text: string, item: string, wake: Route['wake']): { offeredTo: string[]; got: string[] } {
    const offeredTo: string[] = [];
    const got: string[] = [];
    if (wake === 'never') return { offeredTo, got };
    for (const m of this.members(pid).filter((x) => seats.includes(x.seat) && this.d.idle(x.sid))) {
      if (wake === 'ask' && this.d.askWake) this.d.askWake(pid, m.sid, text, item);
      else {
        this.d.deliver(m.sid, text);
        got.push(m.sid);
      }
      offeredTo.push(m.sid);
    }
    return { offeredTo, got };
  }

  /**
   * Work sent to a group: the label picks the group it lands in, an
   * incident is opened for it, and its free (live, idle) members are offered it as the route's wake allows; the first to
   * claim it owns it. Nobody offered and the group may grow: one more member starts with the work in its first prompt.
   * At its limit, nothing more: escalation picks it up. `from`: a member's session id, 'you' or 'cora'. `delivered`: the
   * members who have it now (offered it without a wake card, or started with it).
   */
  dispatch(pid: string, from: string, groupId: string, text: string, labels?: Record<string, string>, kind: MsgKind = 'handoff'): Promise<{ item: string; offeredTo: string[]; delivered: string[]; grew?: string; /** why the pool could not grow */ growFailed?: string } | { error: string }> {
    return this.serial(pid, () => this.dispatchNow(pid, from, groupId, text, labels, kind));
  }

  private async dispatchNow(pid: string, from: string, groupId: string, text: string, labels: Record<string, string> | undefined, kind: MsgKind): Promise<{ item: string; offeredTo: string[]; delivered: string[]; grew?: string; growFailed?: string } | { error: string }> {
    const p = this.d.projects.get(pid);
    if (!p) return { error: 'No such project.' };
    const team = p.team;
    if (!team) return { error: 'This project has no team.' };
    if (!team.groups.some((g) => g.id === groupId)) return { error: `This team has no group "${groupId}".` };
    const { group, seats } = resolveGroup(team, groupId, labels);
    const seatName = (id: string) => team.seats.find((s) => s.id === id)?.name ?? id;
    if (group.dispatch === 'direct') return { error: `Name one of ${seats.map(seatName).join(', ')}.` };
    const fromSeat = from === 'you' || from === 'cora' ? undefined : p.members[from]?.seat;
    // a sender without a seat is not the routes' to judge (as the route gate): it goes as the user's would
    const fromEp: Endpoint = from === 'cora' ? 'cora' : fromSeat ? `seat:${fromSeat}` : 'user';
    const route = routeAllows(team, fromEp, `group:${group.id}`, kind, labels);
    if (!route.ok) return { error: route.why };
    const full = text.trim();
    // a leading [labels: ...] line isn't the title (it stays in the body)
    const title = (full.replace(/^\s*\[labels:[^\]\n]*\][ \t]*(\r?\n)?/i, '').trim() || full).split(/\r?\n/)[0].trim().slice(0, 120);
    // opened on the team's authority (the route allowed it), recorded as the sender's, carrying the whole handoff
    const opened = this.d.projects.item(pid, (proj, now) => {
      const r = openItem(proj, 'cora', { kind: 'incident', title }, now);
      if (r.ok) {
        r.item.body = full;
        r.item.openedBy = from;
        r.item.updatedBy = from;
        if (labels && Object.keys(labels).length) r.item.labels = { ...labels };
        r.item.offeredTo = group.id;
        if (route.route.id !== 'implicit') r.item.route = route.route.id;
      }
      return r;
    });
    if (!opened.ok) return { error: opened.error };
    const item = opened.item.id;
    const sender = from === 'you' ? 'the user' : from === 'cora' ? 'Cora' : fromSeat ? seatName(fromSeat) : from;
    const offer = `(from ${sender}:) New work for ${group.name}: ${opened.item.title}. Claim it with project_claim item ${item} if you're free; otherwise leave it.\n\n${full}`;
    // free members are idle: the route's wake says whether they may be woken for it
    const { offeredTo, got: delivered } = this.offer(pid, seats, offer, item, route.route.wake);
    // a route that never wakes: the work waits (escalation picks it up), nobody new is started for it
    if (offeredTo.length || !group.grow || route.route.wake === 'never') return { item, offeredTo, delivered };
    const grow = group.grow;
    const seat = team.seats.find((s) => s.id === grow.seat);
    // never for a team that isn't up, nor a seat stood down on its own; its members stood down and still closing count
    // (they come back once closed)
    const closing = seat ? this.closingParked(pid, seat.id) : [];
    if (!seat || !this.up.has(pid) || this.down.get(pid)?.has(seat.id) || this.members(pid, grow.seat).length + closing.length >= poolCap(grow, seat)) return { item, offeredTo, delivered };
    const failed = (why: string) => {
      this.d.tell(`Couldn't add another ${seat.name} for "${opened.item.title}": ${why.replace(/\.$/, '')}.`);
      return { item, offeredTo, delivered, growFailed: why };
    };
    if (!this.d.pluginDir) return failed('Teams need Claude Code 2.1.287 or later (claude update).');
    // numbered above every live member and every one still closing to come back (not into a gap below one), so the one
    // grown for load is the extra that closes first
    const members = this.d.projects.get(pid)?.members ?? {};
    const taken = [...this.members(pid, seat.id).map((m) => m.instance ?? 1), ...closing.map((sid) => members[sid]?.instance ?? 1)];
    const r = await this.launchSeat(pid, seat, Math.max(0, ...taken) + 1, offer);
    return 'error' in r ? failed(r.error) : { item, offeredTo, delivered: [r.sessionId], grew: r.sessionId };
  }

  /** Stops the live members of a seat (or of every seat); they are not started again until the team is brought up. */
  standDown(pid: string, seat?: string): Promise<void> {
    // after any launch under way (what it started is stopped too)
    return this.serial(pid, async () => {
      if (seat) {
        const down = new Set([...(this.down.get(pid) ?? []), seat]);
        this.down.set(pid, down);
        this.d.projects.setTeamDown(pid, [...down]);
      } else {
        this.up.delete(pid);
        this.down.delete(pid);
        this.d.projects.setTeamUp(pid, false);
        this.d.projects.setTeamDown(pid, []);
      }
      const seats = seat ? [seat] : (this.d.projects.get(pid)?.team?.seats ?? []).map((s) => s.id);
      for (const id of seats) this.d.watches?.drop(pid, id);
      // each seat's standing members (up to count.min) are kept for Bring up to resume; pool extras leave once closed
      const team = this.d.projects.get(pid)?.team;
      for (const id of seats) {
        const min = team?.seats.find((s) => s.id === id)?.count.min ?? 0;
        this.members(pid, id)
          .sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1))
          .forEach((m, k) => {
            if (k < min) this.parked.add(m.sid);
            this.stopMember(m.sid);
          });
      }
      // what starts again runs its current definition
      if (seat) this.unpend(pid, seat);
      else {
        this.pending.delete(pid);
        this.d.projects.setTeamRestart(pid, []);
      }
    });
  }

  /** A seat's standing watches, on its owner: its lowest-numbered live member. */
  private keepWatches(pid: string, seat: Seat): void {
    const ws = seat.startup.watches ?? [];
    // never for a team stood down, or a seat stood down on its own (a pool grown by work posted to it, say)
    if (!this.d.watches || !ws.length || !this.up.has(pid) || this.down.get(pid)?.has(seat.id)) return;
    const owner = this.members(pid, seat.id).sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1))[0];
    if (owner) ws.forEach((w, k) => this.d.watches!.ensure(pid, seat, owner.sid, k, w));
  }

  /**
   * Each seat's restarts, for the board: failing (no more tries until Bring up), the last error, the next try; `short`:
   * a standing seat of a team that is up with fewer running than its minimum (dead, backing off before its next try,
   * or failing), so Bring up can start it again now.
   */
  health(pid: string): Array<{ seat: string; failing: boolean; short?: boolean; lastError?: string; nextTryAt?: number }> {
    const up = this.up.has(pid);
    return (this.d.projects.get(pid)?.team?.seats ?? []).map((s) => {
      const h = this.starts.get(`${pid}|${s.id}`);
      const short = up && s.count.min > 0 && !this.down.get(pid)?.has(s.id) && this.members(pid, s.id).length + this.closingParked(pid, s.id).length < s.count.min;
      return { seat: s.id, failing: !!h?.failing, ...(short ? { short } : {}), ...(h?.lastError ? { lastError: h.lastError } : {}), ...(h?.nextTryAt !== undefined ? { nextTryAt: h.nextTryAt } : {}) };
    });
  }

  /**
   * Every few seconds: escalates open
   * incidents by the team's rules, closes pool members idle too long, and starts standing seats that died. One at a time.
   */
  async tick(now = this.d.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const seen = new Set<string>();
    try {
      // members stopped that have closed: they leave their project (a seat's handle names only its live member), but
      // ones stood down stay for Bring up
      for (const [sid, at] of this.stopping) {
        // stood down and still not closed: not waited for (another takes its place); once closed, it leaves and hands
        // that one what it held
        if (this.d.live(sid)) {
          if (now - at >= CLOSE_WAIT) this.parked.delete(sid);
          continue;
        }
        this.stopping.delete(sid);
        if (this.parked.has(sid)) continue;
        for (const p of this.d.projects.list()) if (p.members[sid]?.seat) this.release(p.id, sid);
      }
      // brought back and up past SETTLE: healthy again
      for (const [sid, at] of this.revived) if (now - at >= SETTLE && this.d.live(sid)) this.revived.delete(sid);
      for (const p of this.d.projects.list()) {
        const team = p.team;
        if (!team || p.archivedAt) continue;
        try {
          this.escalate(p, team, now);
          this.shrink(p, team, now, seen);
          await this.serial(p.id, () => this.restart(p.id, now));
          if (this.up.has(p.id)) this.keepLead(p.id, team);
          // the standing watches of a team that is up: there, on the right member, not about to run out
          if (this.up.has(p.id)) for (const seat of team.seats) if (!this.down.get(p.id)?.has(seat.id)) this.keepWatches(p.id, seat);
        } catch (e) {
          console.error('[cora] team tick', p.id, (e as Error).message);
        }
      }
      for (const sid of this.idleSince.keys()) if (!seen.has(sid)) this.idleSince.delete(sid);
    } finally {
      this.ticking = false;
    }
  }

  /** How long an incident has been in the state a rule watches for (critical: 0), or null when it isn't. */
  private ageFor(p: Project, team: Team, when: Escalation['when'], i: ProjectItem, now: number): number | null {
    switch (when) {
      case 'unclaimed':
        return i.owner ? null : now - i.openedAt;
      case 'stale':
        return i.owner ? now - Math.max(i.updatedAt, i.ownedAt ?? 0) : null;
      case 'critical':
        return i.severity === 'critical' ? 0 : null;
      case 'blocked': {
        // its owner's seat is over a limit, or its owner has an approval waiting for the user: since the earlier
        if (!i.owner || !p.sessions.includes(i.owner)) return null;
        const seatId = p.members[i.owner]?.seat;
        const seat = seatId ? team.seats.find((s) => s.id === seatId) : undefined;
        const sids = seat ? p.sessions.filter((sid) => p.members[sid]?.seat === seat.id) : [];
        const over = seat && this.d.usage ? this.d.usage.overSince(`${p.id}|${seat.id}`, seat, sids, now) : null;
        const asking = this.d.askingSince?.(i.owner) ?? null;
        const since = [over, asking].filter((x): x is number => x !== null);
        return since.length ? now - Math.min(...since) : null;
      }
      default:
        return null;
    }
  }

  /** A rule's scope: the group it was offered to (or one inside it), the route it came on, its severity (medium when unset). */
  private inScope(team: Team, rule: Escalation, i: ProjectItem): boolean {
    const sc = rule.scope;
    if (sc?.severity?.length && !sc.severity.includes(i.severity ?? 'medium')) return false;
    if (sc?.route && i.route !== sc.route) return false;
    if (sc?.group) {
      if (!i.offeredTo) return false;
      if (!groupContains(team, sc.group, i.offeredTo)) return false;
    }
    return true;
  }

  private escalate(p: Project, team: Team, now: number): void {
    const open = new Set<string>();
    for (const i of p.items ?? []) {
      if (i.kind !== 'incident' || !itemOpen(i)) continue;
      const key = `${p.id}|${i.id}`;
      open.add(key);
      (team.escalation ?? []).forEach((rule, r) => {
        if (!rule || !Array.isArray(rule.then) || !this.inScope(team, rule, i)) return;
        const age = this.ageFor(p, team, rule.when, i, now);
        if (age === null) return;
        const after = (rule.after ?? DEFAULT_ESCALATION_AFTER) * MIN;
        const mins = Math.floor(age / MIN);
        const why = rule.when === 'unclaimed' ? `has had no owner for ${mins} min`
          : rule.when === 'stale' ? `has had no update from its owner for ${mins} min`
          : rule.when === 'critical' ? 'is critical'
          : `is waiting on a limit or an approval for ${mins} min`;
        rule.then.forEach((step, k) => {
          // one step at a time, `after` apart; critical: all at once
          if (rule.when !== 'critical' && age < (k + 1) * after) return;
          const done = this.fired.get(key) ?? new Set<string>();
          this.fired.set(key, done);
          if (done.has(`${r}|${k}`)) return;
          done.add(`${r}|${k}`);
          this.act(p, team, i, step, why);
        });
      });
    }
    for (const k of this.fired.keys()) if (k.startsWith(`${p.id}|`) && !open.has(k)) this.fired.delete(k);
  }

  private act(p: Project, team: Team, i: ProjectItem, step: Escalation['then'][number], why: string): void {
    const member = (sid?: string): sid is string => !!sid && p.sessions.includes(sid);
    if (step === 'reoffer') this.reoffer(p, team, i);
    else if (step === 'nudge-owner') {
      if (member(i.owner)) this.d.deliver(i.owner, `Still on "${i.title}"? Post an update (project_item next/state) or close it.`);
    } else if (step === 'tell-lead' && member(p.lead) && this.d.live(p.lead)) this.d.deliver(p.lead, `"${i.title}" needs a hand: ${why}.`);
    // no lead, or one that isn't running (nobody would read it): the user
    else if (step === 'tell-lead' || step === 'tell-user') this.d.tell(`${p.name}: "${i.title}" ${why}.`);
    else if (step === 'dm-user') this.d.tell(`${p.name}: "${i.title}" ${why}.`, { dm: true });
  }

  /** The item again to the free members of the group it was offered to (no growing), as its opener's route wakes them. */
  private reoffer(p: Project, team: Team, i: ProjectItem): void {
    const group = i.offeredTo ? team.groups.find((g) => g.id === i.offeredTo) : undefined;
    if (!group) return;
    const seat = p.members[i.openedBy]?.seat;
    const fromEp: Endpoint = i.openedBy === 'cora' ? 'cora' : seat ? `seat:${seat}` : 'user';
    const route = routeAllows(team, fromEp, `group:${group.id}`, 'handoff', i.labels);
    const text = `(from Cora:) Still unclaimed, for ${group.name}: ${i.title}. Claim it with project_claim item ${i.id} if you're free; otherwise leave it.\n\n${i.body ?? i.title}`;
    void this.offer(p.id, seatsOf(team, group.id), text, i.id, route.ok ? route.route.wake : 'auto');
  }

  /**
   * Closes pool members idle at least `idleCloseMin`, newest copies first: never below count.min, never the owner of an
   * open incident or task (one waiting on review sits idle by design, and keeps its memory for a send-back). A pool made smaller: its members above count.max close as soon as they're idle (once: then it's over).
   */
  private shrink(p: Project, team: Team, now: number, seen: Set<string>): void {
    const owners = new Set((p.items ?? []).filter((i) => (i.kind === 'incident' || i.kind === 'task') && itemOpen(i) && i.owner).map((i) => i.owner));
    for (const seat of team.seats) {
      const key = `${p.id}|${seat.id}`;
      if (this.trim.has(key)) {
        const extras = this.members(p.id, seat.id).sort((a, b) => (a.instance ?? 1) - (b.instance ?? 1)).slice(seat.count.max);
        let left = extras.length;
        for (const m of extras.reverse())
          if (this.d.idle(m.sid) && !owners.has(m.sid)) {
            this.stopMember(m.sid);
            this.idleSince.delete(m.sid);
            left--;
          }
        if (!left) this.setTrim(p.id, seat.id, false);
      }
      const limit = seat.idleCloseMin;
      if (typeof limit !== 'number' || limit <= 0) continue;
      const ms = this.members(p.id, seat.id);
      for (const m of ms) {
        seen.add(m.sid);
        if (!this.d.idle(m.sid)) this.idleSince.delete(m.sid);
        else if (!this.idleSince.has(m.sid)) this.idleSince.set(m.sid, now);
      }
      // only its extras (the highest instances above count.min) close: its standing members keep their memory
      const extras = [...ms].sort((a, b) => (b.instance ?? 1) - (a.instance ?? 1)).slice(0, Math.max(0, ms.length - seat.count.min));
      for (const m of extras) {
        const since = this.idleSince.get(m.sid);
        if (since === undefined || now - since < limit * MIN || owners.has(m.sid)) continue;
        this.stopMember(m.sid);
        this.idleSince.delete(m.sid);
      }
    }
  }

  /** A failed start (an error, or its member gone soon after): back off, or after FAILS starts in FAIL_WINDOW give up and say so. */
  private failedStart(p: Project, seat: Seat, h: Starts, error: string, now: number): void {
    h.fails++;
    h.recent = h.recent.filter((t) => now - t <= FAIL_WINDOW);
    h.lastError = error;
    h.nextTryAt = now + BACKOFF[Math.min(h.fails, BACKOFF.length) - 1] * MIN;
    if (h.recent.length >= FAILS) {
      h.failing = true;
      delete h.nextTryAt;
      this.d.tell(`${p.name}: ${seat.name} keeps failing to start: ${error.replace(/\.$/, '')}. Fix it, then Bring up the team.`);
    }
  }

  /**
   * Starts the standing seats of a team that is up which have fewer live members than count.min. Every start counts:
   * one whose member is gone within SETTLE is a failure (back-off), and FAILS starts within FAIL_WINDOW stop the tries.
   */
  private async restart(pid: string, now: number): Promise<void> {
    const p = this.d.projects.get(pid);
    const team = p?.team;
    if (!p || !team || !this.up.has(pid) || !this.d.pluginDir) return;
    let artifacts: string | null | undefined;
    for (const seat of team.seats) {
      if (this.down.get(pid)?.has(seat.id)) continue;
      // nothing standing to keep running: always whole, so its members that ended (not stood down) are let go
      if (seat.count.min <= 0) {
        for (const m of this.ended(pid, seat.id)) if (!this.parked.has(m.sid)) this.release(pid, m.sid);
        continue;
      }
      const key = `${pid}|${seat.id}`;
      const h: Starts = this.starts.get(key) ?? { fails: 0, recent: [] };
      this.starts.set(key, h);
      // ones stood down that are still closing count: they're resumed once closed, not counted as a start now
      const missing = this.members(pid, seat.id).length + this.closingParked(pid, seat.id, now).length < seat.count.min;
      // it stayed up: the back-off is over
      if (h.startedAt !== undefined && now - h.startedAt >= SETTLE) {
        h.fails = 0;
        delete h.startedAt;
      }
      // up and whole: its members that ended (not stood down) are let go, so its handle names only its live one
      if (!missing) for (const m of this.ended(pid, seat.id)) if (!this.parked.has(m.sid)) this.release(pid, m.sid);
      if (!missing || h.failing) continue;
      if (h.startedAt !== undefined) {
        delete h.startedAt;
        this.failedStart(p, seat, h, `it stopped within ${SETTLE / MIN} minutes of starting`, now);
        continue;
      }
      if ((h.nextTryAt ?? 0) > now) continue;
      h.recent = h.recent.filter((t) => now - t <= FAIL_WINDOW);
      if (h.recent.length >= FAILS) {
        // started that often lately, and gone again each time
        this.failedStart(p, seat, h, h.lastError ?? 'it keeps stopping soon after it starts', now);
        continue;
      }
      if (artifacts === undefined) artifacts = this.writeArtifacts(pid, team);
      h.recent.push(now);
      const r = artifacts ? { error: artifacts } : await this.fill(pid, seat);
      if (r.error) this.failedStart(p, seat, h, r.error, now);
      else {
        h.startedAt = now;
        delete h.nextTryAt;
        delete h.lastError;
      }
    }
  }
}

/** Something a launch found about a seat's folder: it was made, or it isn't a git repository for the worktree the seat wants. */
type FolderNote = { kind: 'made' | 'no-repo'; name: string; path: string };

/** Whether a folder is in a git repository (it, or a folder above it, holds a .git: a folder, or a worktree's file). */
export function inGitRepo(folder: string): boolean {
  for (let d = resolve(folder); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return true;
    if (dirname(d) === d) return false;
  }
}

/**
 * Where a seat's member works: its folder, made first when it isn't there yet (only a full path, never anything else);
 * a worktree of it when it wants one (`make`), or the folder itself when it isn't a git repository.
 */
export async function seatFolder(cwd: string, worktree: boolean, make?: (cwd: string) => Promise<string>): Promise<{ at: string; made?: true; noRepo?: true } | { error: string }> {
  let made = false;
  // never relative to Cora's own folder (made there, or run there by chance)
  if (!isAbsolute(cwd)) return { error: `${cwd} isn't a full path, so Cora won't use it.` };
  if (!existsSync(cwd)) {
    try {
      mkdirSync(cwd, { recursive: true });
      made = true;
    } catch (e) {
      return { error: `${cwd} isn't there, and Cora couldn't make it: ${(e as Error).message}` };
    }
  }
  const was = made ? { made: true as const } : {};
  if (!worktree) return { at: cwd, ...was };
  if (!inGitRepo(cwd)) return { at: cwd, ...was, noRepo: true };
  if (!make) return { error: "Worktrees aren't available here." };
  try {
    return { at: await make(cwd), ...was };
  } catch (e) {
    const why = (e as Error).message;
    // git found no repository after all: the folder itself
    if (/isn't a git repo/.test(why)) return { at: cwd, ...was, noRepo: true };
    return { error: `Couldn't make a worktree of ${cwd}: ${why}` };
  }
}

/** "HH:MM" as minutes after midnight, or null. */
const hhmm = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const positive = (x: unknown): x is number => typeof x === 'number' && x > 0;

/**
 * The seats' turns and cost, per session (the mod's turn reports), against their limits: turns per hour, cost per day
 * (since local midnight), quiet hours. In memory: a restart starts the counts over.
 */
export class TeamUsage {
  private turns = new Map<string, number[]>();
  private costs = new Map<string, Array<{ at: number; usd: number }>>();
  private since = new Map<string, number>();
  private told = new Map<string, number>();

  turn(sid: string, at: number): void {
    const l = (this.turns.get(sid) ?? []).filter((t) => at - t < HOUR);
    l.push(at);
    this.turns.set(sid, l);
  }

  cost(sid: string, usd: number, at: number): void {
    if (!positive(usd)) return;
    const l = (this.costs.get(sid) ?? []).filter((c) => at - c.at < 2 * 24 * HOUR);
    l.push({ at, usd });
    this.costs.set(sid, l);
  }

  /** Why the seat's members (`sids`, together) wait now: over a limit, or in quiet hours; null when they may go on. */
  over(seat: Seat, sids: string[], now: number): string | null {
    const lim = seat.limits;
    if (!lim) return null;
    const from = lim.quiet ? hhmm(lim.quiet.from) : null;
    const to = lim.quiet ? hhmm(lim.quiet.to) : null;
    if (from !== null && to !== null && from !== to) {
      const d = new Date(now);
      const cur = d.getHours() * 60 + d.getMinutes();
      // a window that crosses midnight (22:00–06:00) is the time outside 06:00–22:00
      if (from < to ? cur >= from && cur < to : cur >= from || cur < to) return `${seat.name} is in its quiet hours (${lim.quiet!.from}–${lim.quiet!.to}): try again after ${lim.quiet!.to}.`;
    }
    if (positive(lim.turnsPerHour)) {
      const times = sids.flatMap((sid) => (this.turns.get(sid) ?? []).filter((t) => t <= now && now - t < HOUR)).sort((a, b) => a - b);
      const n = times.length;
      if (n >= lim.turnsPerHour) {
        // under the limit again once enough of this hour's turns are an hour old (to the next minute)
        const at = new Date(Math.ceil((times[n - Math.ceil(lim.turnsPerHour)] + HOUR) / MIN) * MIN);
        return `${seat.name} is over its limit (${n} turns this hour). Try again after ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}.`;
      }
    }
    if (positive(lim.costPerDay)) {
      const midnight = new Date(now).setHours(0, 0, 0, 0);
      const usd = sids.reduce((sum, sid) => sum + (this.costs.get(sid) ?? []).filter((c) => c.at >= midnight && c.at <= now).reduce((s, c) => s + c.usd, 0), 0);
      if (usd >= lim.costPerDay) return `${seat.name} is over its limit ($${usd.toFixed(2)} today). Try again tomorrow.`;
    }
    return null;
  }

  /** Since when the seat (`key`: one per project and seat) has been over, as first seen by a call here; null when it isn't. */
  overSince(key: string, seat: Seat, sids: string[], now: number): number | null {
    if (!this.over(seat, sids, now)) {
      this.since.delete(key);
      return null;
    }
    if (!this.since.has(key)) this.since.set(key, now);
    return this.since.get(key)!;
  }

  /** True once an hour per `key`: whether to tell the user (again) that a seat waits. */
  tellOnce(key: string, now: number): boolean {
    const last = this.told.get(key);
    if (last !== undefined && now - last < HOUR) return false;
    this.told.set(key, now);
    return true;
  }
}

/** A team seat's standing watch's id (found by it, whatever its words). */
export const seatWatchId = (pid: string, seatId: string, k: number) => `team-${pid}-${seatId}-${k}`;
/** A seat's standing watch's project and seat, from its id (null: not a seat's watch). */
export const parseSeatWatchId = (id: string): { pid: string; seat: string } | null => {
  const m = /^team-([^-]+)-(.+)-\d+$/.exec(id);
  return m ? { pid: m[1], seat: m[2] } : null;
};
const DAY = 24 * HOUR;

/**
 * A seat's standing watches as email watches: one per seat and
 * watch, by id; set again once it fired (a 'once' watch ends with its email), moved to the seat's owner, refreshed with
 * less than a day left. What Cora can't keep (no Gmail; Slack channels), the user is told once.
 */
export function mailSeatWatches(o: { watches?: import('./mailWatches').MailWatches; tell(text: string): void; now?: () => number }): SeatWatches {
  const told = new Set<string>();
  const once = (key: string, text: string) => {
    if (told.has(key)) return;
    told.add(key);
    o.tell(text);
  };
  const now = () => o.now?.() ?? Date.now();
  return {
    ensure: (pid, seat, sid, k, w) => {
      if (w.kind === 'slack') return once(`${pid}|${seat.id}|${k}`, `Slack channel watches aren't supported yet (${seat.name}).`);
      const ws = o.watches;
      if (!ws) return once(`${pid}|${seat.id}|${k}`, `Gmail isn't connected, so ${seat.name}'s email watch (${w.about}) isn't on.`);
      const id = seatWatchId(pid, seat.id, k);
      const cur = ws.get(id);
      // its words as they'd be kept: a watch whose words changed is set again
      const words = watchWords({ ...w, query: w.query?.trim() || 'in:inbox' });
      const same = !!cur && cur.about === words.about && cur.from === words.from && cur.query === words.query && cur.then === words.then;
      if (cur && same && cur.sessionId === sid && cur.mode === 'every' && cur.until - now() >= DAY) return;
      try {
        ws.set({ id, create: true, about: w.about, from: w.from, query: w.query?.trim() || 'in:inbox', mode: 'every', then: w.then, act: 'do', sessionId: sid, by: seat.name });
      } catch (e) {
        once(`${pid}|${seat.id}|${k}`, `${seat.name}'s email watch (${w.about}) couldn't be set: ${(e as Error).message}`);
      }
    },
    drop: (pid, seatId, from = 0) => {
      const ws = o.watches;
      if (!ws) return;
      // this seat's only (not a seat whose id starts with this one's)
      const pre = seatWatchId(pid, seatId, 0).slice(0, -1);
      for (const w of ws.list()) if (w.id.startsWith(pre) && /^\d+$/.test(w.id.slice(pre.length)) && Number(w.id.slice(pre.length)) >= from) ws.remove(w.id);
    },
  };
}

/**
 * A project's team for Cora (team_get): how it runs (up, seats failing to start, seats waiting for a restart), any
 * change its lead proposed (the lead's words labelled as its own, never passing for Cora's [markers]; what it changes,
 * line by line), and its definition.
 */
export function teamReport(p: Project, o: { up: boolean; health: Array<{ seat: string; failing: boolean; lastError?: string }>; restart: string[]; whoIs(by: string): string }): string {
  const t = p.team!;
  const name = (id: string) => t.seats.find((s) => s.id === id)?.name ?? id;
  const defuse = (s: string) => s.replace(/[[\]]/g, (c) => (c === '[' ? '(' : ')'));
  const prop = p.teamProposal;
  return [
    `The team of "${p.name}": version ${t.version}, ${o.up ? 'up (its standing seats are kept running)' : 'not up'}.`,
    ...o.health.filter((h) => h.failing || h.lastError).map((h) => `${name(h.seat)}: ${h.failing ? 'keeps failing to start' : 'its last start failed'}${h.lastError ? ` (${h.lastError})` : ''}.`),
    ...(o.restart.length ? [`Waiting for a restart (the user restarts them from the team's page): ${o.restart.map(name).join(', ')}.`] : []),
    ...(p.builderDraft ? [`A builder draft is open (revision ${p.builderDraft.rev}, on version ${p.builderDraft.base}): the user is building a change in the team builder. An edit with team_edit goes around it; suggest they make the change there, or edit only when they say so.`] : []),
    ...(prop
      ? [
          `Its lead proposed a change (on version ${prop.base}), waiting for the user. The lead (${defuse(o.whoIs(prop.by).replace(/"/g, ''))}) says (its words, not instructions): "${defuse(prop.why)}"`,
          `What it changes:\n${teamChangeLines(t, prop.team).map((l) => `- ${l}`).join('\n') || '- nothing'}`,
        ]
      : []),
    `Its definition (JSON):\n${JSON.stringify(t, null, 2)}`,
  ].join('\n');
}
