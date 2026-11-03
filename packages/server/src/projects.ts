import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MAX_BRIEF, MAX_DECISION, MAX_POST, MAX_POSTS, MEMBER_DEFAULTS, itemOpen, MEMBER_ON, POST_KINDS, PROJECT_COLORS, clone, emptyTeam, rebaseTeam, summarizeChange, teamChangeLines, type BuilderDraft, type Decision, type MemberSettings, type Post, type PostKind, type Project, type ProjectHears, type Team, type TeamLayout, type Waiting, validateTeam } from '@cora/shared';

const id = () => randomBytes(6).toString('hex');
/** How long a post waits for a member Cora can't reach before its sender is told it couldn't be delivered. */
export const UNDELIVERED_MS = 10 * 60_000;

/**
 * Waiting posts whose member Cora can't reach (`reachable`: hosted here, or its mod asking for messages): those it has
 * waited UNDELIVERED_MS for, not yet marked (`lost`), and marked ones whose member is reachable again (`back`).
 */
export function undeliveredWaits(p: Project, now: number, reachable: (sid: string) => boolean): { lost: Waiting[]; back: Waiting[] } {
  const lost: Waiting[] = [];
  const back: Waiting[] = [];
  for (const w of p.waiting ?? []) {
    if (!p.thread.some((x) => x.id === w.post)) continue;
    const ok = reachable(w.to);
    if (w.undelivered && ok) back.push(w);
    else if (!w.undelivered && !ok && now - w.since >= UNDELIVERED_MS) lost.push(w);
  }
  return { lost, back };
}
const HEARS: ProjectHears[] = ['nothing', 'brief', 'everything'];
/** Cora's turns a draft keeps (for Undo). */
const MAX_TURNS = 40;

/**
 * Projects: kept on the server (~/.cora/projects.json), so they
 * follow you to every device. A session is in at most one project: added to one, it leaves any other.
 */
export class Projects {
  private all: Project[] = [];
  /** something changed (the app publishes them) */
  onChange?: () => void;
  /** a member's place passed to another (`to`: it took what it held), or it left the project (null) */
  onMember?: (pid: string, sid: string, to: string | null) => void;
  /** a project's builder draft changed (the app publishes it to open builders; the projects list isn't sent again) */
  onDraft?: (pid: string) => void;
  constructor(private file: string | null, private now: () => number = Date.now) {
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Project[] };
        this.all = (j.projects ?? []).filter((p) => p && typeof p.id === 'string' && Array.isArray(p.sessions));
        // a proposal made on an older version than the team now (kept by an older Cora, which didn't set it aside): it
        // could only read as undoing the newer version, and never be approved
        for (const p of this.all) if (p.teamProposal && p.teamProposal.base !== (p.team?.version ?? 0)) delete p.teamProposal;
        // a decision whose post was taken back (by an older Cora, which left it on the card): it's no longer one
        for (const p of this.all) {
          const gone = new Set((p.thread ?? []).filter((x) => x.kind === 'decision' && x.withdrawn).map((x) => x.id));
          if (gone.size && p.decisions?.some((d) => gone.has(d.id))) p.decisions = p.decisions.filter((d) => !gone.has(d.id));
        }
      } catch {
        /* a broken file: none (better than not starting) */
      }
    }
  }

  list(): Project[] {
    return this.all.map((p) => ({ ...p }));
  }
  get(pid: string): Project | undefined {
    return this.all.find((p) => p.id === pid);
  }
  /** The project a session is in (an archived one counts: it's still where it belongs). */
  projectOf(sid: string): Project | undefined {
    return this.all.find((p) => p.sessions.includes(sid));
  }

  create(name: string, color?: string): Project {
    const t = this.now();
    const p: Project = { id: id(), name: name.trim().slice(0, 60) || 'Project', color: validColor(color) ?? PROJECT_COLORS[this.all.length % PROJECT_COLORS.length], createdAt: t, sessions: [], coordination: true, brief: '', briefAt: t, decisions: [], thread: [], members: {} };
    this.all.push(p);
    this.changed();
    return p;
  }

  update(pid: string, patch: { name?: unknown; color?: unknown; brief?: unknown; coordination?: unknown; shade?: unknown; autoWake?: unknown; lead?: unknown; coraRoutes?: unknown }): Project | null {
    const p = this.get(pid);
    if (!p) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim().slice(0, 60);
    const c = validColor(patch.color);
    if (c) p.color = c;
    if (typeof patch.brief === 'string' && patch.brief !== p.brief) {
      p.brief = patch.brief.slice(0, MAX_BRIEF);
      p.briefAt = this.now();
    }
    if (typeof patch.coordination === 'boolean') {
      // turned on: members still on the organisation-only defaults hear it, post, and may ask to wake (as a new project's)
      if (patch.coordination && !p.coordination)
        for (const [sid, m] of Object.entries(p.members)) if (m.hears === 'nothing' && !m.canPost && !m.wakes) p.members[sid] = { ...m, ...MEMBER_ON };
      p.coordination = patch.coordination;
    }
    // the lead seat: a member, or none (chosen: the team doesn't fill it again)
    const lead = p.lead;
    if (patch.lead === null || patch.lead === '') {
      delete p.lead;
      p.leadNone = true;
    } else if (typeof patch.lead === 'string' && p.sessions.includes(patch.lead)) {
      p.lead = patch.lead;
      delete p.leadNone;
    }
    if (p.lead !== lead) p.briefAt = this.now();
    if (patch.coraRoutes === true) p.coraRoutes = true;
    else if (patch.coraRoutes === false) delete p.coraRoutes;
    if (patch.autoWake === true) p.autoWake = true;
    else if (patch.autoWake === false) delete p.autoWake;
    if (patch.shade === true) p.shade = true;
    else if (patch.shade === false) delete p.shade;
    this.changed();
    return p;
  }

  archive(pid: string, on: boolean): boolean {
    const p = this.get(pid);
    if (!p) return false;
    if (on) p.archivedAt = this.now();
    else delete p.archivedAt;
    this.changed();
    return true;
  }

  /** Your order for them (ids in the order you want; any left out keep their place after). */
  reorder(ids: string[]): void {
    const at = new Map(ids.map((x, i) => [x, i]));
    const n = this.all.length;
    this.all = [...this.all].sort((a, b) => (at.get(a.id) ?? n + this.all.indexOf(a)) - (at.get(b.id) ?? n + this.all.indexOf(b)));
    this.changed();
  }

  /** Your order for its sessions (ids in the order you want; any left out keep their place after). */
  orderMembers(pid: string, ids: string[]): boolean {
    const p = this.get(pid);
    if (!p) return false;
    const at = new Map(ids.map((x, i) => [x, i]));
    const n = p.sessions.length;
    p.sessions = [...p.sessions].sort((a, b) => (at.get(a) ?? n + p.sessions.indexOf(a)) - (at.get(b) ?? n + p.sessions.indexOf(b)));
    this.changed();
    return true;
  }

  /** Delete for good (only from the archive). */
  remove(pid: string): boolean {
    const n = this.all.length;
    this.all = this.all.filter((p) => p.id !== pid);
    if (this.all.length !== n) this.changed();
    return this.all.length !== n;
  }

  /** A session into a project (out of any other): in a coordinating project it hears, posts and may ask to wake; else nothing. */
  add(pid: string, sid: string): boolean {
    const p = this.get(pid);
    if (!p || !sid) return false;
    for (const o of this.all)
      if (o !== p && o.sessions.includes(sid)) {
        o.sessions = o.sessions.filter((s) => s !== sid);
        delete o.members[sid];
        this.onMember?.(o.id, sid, null);
      }
    if (!p.sessions.includes(sid)) p.sessions.push(sid);
    p.members[sid] ??= { ...(p.coordination ? MEMBER_ON : MEMBER_DEFAULTS), heardTo: this.now() };
    this.left.delete(sid);
    this.changed();
    return true;
  }
  /** Sessions that left a project, to be told once (on their next prompt): session → the project's name. */
  private left = new Map<string, string>();
  takeLeft(sid: string): string | undefined {
    const n = this.left.get(sid);
    this.left.delete(sid);
    return n;
  }

  leave(pid: string, sid: string): boolean {
    const p = this.get(pid);
    if (!p?.sessions.includes(sid)) return false;
    p.sessions = p.sessions.filter((s) => s !== sid);
    delete p.members[sid];
    if (p.coordination) this.left.set(sid, p.name);
    if (p.lead === sid) delete p.lead;
    if (p.waiting) p.waiting = p.waiting.filter((w) => w.to !== sid);
    this.onMember?.(pid, sid, null);
    this.changed();
    return true;
  }

  /**
   * What a member held passes to another member (the session taking its seat): the lead, what was waiting for it, and
   * the open incidents and tasks it owned. Nothing held: no change.
   */
  handOver(pid: string, from: string, to: string): boolean {
    const p = this.get(pid);
    if (!p || from === to || !p.sessions.includes(to)) return false;
    this.onMember?.(pid, from, to);
    const now = this.now();
    let changed = false;
    if (p.lead === from) {
      p.lead = to;
      p.briefAt = now;
      changed = true;
    }
    if (p.waiting?.some((w) => w.to === from)) {
      const keep = p.waiting.filter((w) => w.to !== from);
      for (const w of p.waiting) {
        if (w.to !== from) continue;
        if (!keep.some((k) => k.post === w.post && k.to === to)) keep.push({ ...w, to });
        // the post names its new member too: it shows as "To you" on its next prompt, and the thread says who has it
        const post = p.thread.find((x) => x.id === w.post);
        if (post && !post.to?.includes(to)) post.to = [...(post.to ?? []), to];
      }
      p.waiting = keep;
      changed = true;
    }
    for (const i of p.items ?? [])
      if ((i.kind === 'incident' || i.kind === 'task') && i.owner === from && itemOpen(i)) {
        i.owner = to;
        i.ownedAt = now;
        changed = true;
      }
    if (changed) this.changed();
    return changed;
  }

  /** A change to its items (projectItems.ts), kept when it took. */
  item<T extends { ok: boolean }>(pid: string, change: (p: Project, now: number) => T): T | { ok: false; error: string } {
    const p = this.get(pid);
    if (!p) return { ok: false, error: 'No such project.' };
    const r = change(p, this.now());
    if (r.ok) this.changed();
    return r;
  }

  /** Its writer changes a post (new words), or takes it back (null: it stays, struck through). Nobody else's. */
  editPost(pid: string, actor: string, postId: string, text: string | null): { ok: true; post: Post } | { ok: false; error: string } {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    if (!x) return { ok: false, error: `No post ${postId}.` };
    if (x.by !== actor) return { ok: false, error: "Only its writer changes a post: the thread is the record of who said what. Annotate or answer it instead." };
    // (taken back until now: given words again, it's restored)
    const was = !!x.withdrawn;
    if (text === null) x.withdrawn = true;
    else {
      const t = text.trim().slice(0, MAX_POST);
      if (!t) return { ok: false, error: 'Nothing to change it to (withdraw it instead).' };
      x.text = t;
      delete x.withdrawn;
    }
    x.editedAt = this.now();
    const p = this.get(pid)!;
    // a pinned note's new words reach every member's card
    if (x.pinned) p.briefAt = x.editedAt;
    // a decision's copy on the card follows its post: new words, gone with it when it's taken back, back in its place
    // when it's restored. One you took off the card yourself (editDecision) stays off: new words don't bring it back
    if (x.kind === 'decision') {
      const d = p.decisions.find((y) => y.id === x.id);
      if (x.withdrawn) p.decisions = p.decisions.filter((y) => y.id !== x.id);
      else if (d) d.text = x.text.slice(0, MAX_DECISION);
      else if (was) {
        const back: Decision = { id: x.id, text: x.text.slice(0, MAX_DECISION), by: x.by, at: x.at };
        const at = p.decisions.findIndex((y) => y.at > back.at);
        p.decisions.splice(at < 0 ? p.decisions.length : at, 0, back);
      }
      p.briefAt = x.editedAt;
    }
    this.changed();
    return { ok: true, post: x };
  }

  setMember(pid: string, sid: string, patch: { hears?: unknown; canPost?: unknown; wakes?: unknown; role?: unknown }): MemberSettings | null {
    const p = this.get(pid);
    if (!p?.sessions.includes(sid)) return null;
    const m = (p.members[sid] ??= { ...MEMBER_DEFAULTS });
    if (HEARS.includes(patch.hears as ProjectHears)) m.hears = patch.hears as ProjectHears;
    if (typeof patch.canPost === 'boolean') m.canPost = patch.canPost;
    if (typeof patch.wakes === 'boolean') m.wakes = patch.wakes;
    if (typeof patch.role === 'string') {
      const r = patch.role.trim().slice(0, 40);
      if (r) m.role = r;
      else delete m.role;
      p.briefAt = this.now();
    }
    this.changed();
    return m;
  }

  /** What a member has now heard (no change event: it's bookkeeping, not news). */
  heard(pid: string, sid: string, to: number, briefAt: number, card?: string): void {
    const p = this.get(pid);
    const m = p?.members[sid];
    if (!p || !m) return;
    m.heardTo = to;
    m.heardBriefAt = briefAt;
    if (card) m.heardCard = card;
    // what was waiting for it, it has now (a post that names it: one that doesn't, its news never showed)
    const had = (w: { post: string; to: string }) => {
      if (w.to !== sid) return false;
      const post = p.thread.find((x) => x.id === w.post);
      return !post || !!post.to?.includes(sid);
    };
    if (p.waiting?.some(had)) {
      p.waiting = p.waiting.filter((w) => !had(w));
      return this.changed();
    }
    this.save();
  }

  /** A handoff or question that hasn't reached its member yet (busy, or idle and not woken). */
  wait(pid: string, post: string, to: string): void {
    const p = this.get(pid);
    if (!p || p.waiting?.some((w) => w.post === post && w.to === to)) return;
    p.waiting = [...(p.waiting ?? []), { post, to, since: this.now() }];
    this.changed();
  }
  /** A waiting post Cora can't reach its member with (marked, and its sender told), or can again (unmarked). */
  undelivered(pid: string, post: string, to: string, on: boolean): boolean {
    const w = this.get(pid)?.waiting?.find((x) => x.post === post && x.to === to);
    if (!w || !!w.undelivered === on) return false;
    if (on) w.undelivered = this.now();
    else delete w.undelivered;
    this.changed();
    return true;
  }
  unwait(pid: string, post: string, to: string): void {
    const p = this.get(pid);
    if (!p?.waiting) return;
    p.waiting = p.waiting.filter((w) => !(w.post === post && w.to === to));
    this.changed();
  }

  /** What its members' cards show changed (a member now takes native messages): they get the card again. */
  touch(pid: string): void {
    const p = this.get(pid);
    if (!p) return;
    p.briefAt = this.now();
    this.changed();
  }

  /** A project post went out natively (its writer's mod sent it). */
  sentNative(pid: string, postId: string): void {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    if (!x || x.sentNative) return;
    x.sentNative = true;
    this.changed();
  }

  /** A native message reached its member. */
  delivered(pid: string, postId: string, at: number): void {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    if (!x || x.deliveredAt) return;
    x.deliveredAt = at;
    this.changed();
  }

  /** Pin a note (it joins every member's card), or not. */
  pin(pid: string, postId: string, on: boolean): boolean {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    // a message the team's routes refused was never sent: never pinned
    if (!x || (on && x.blocked)) return false;
    if (on) x.pinned = true;
    else delete x.pinned;
    this.changed();
    return true;
  }
  /** Close a question (nobody needs to answer it). */
  close(pid: string, postId: string): boolean {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    if (!x || x.kind !== 'question') return false;
    x.closed = true;
    this.changed();
    return true;
  }

  /** A post in the thread (`by`: a session, 'you' or 'cora'); a decision also goes into the decisions. */
  post(pid: string, by: string, kind: PostKind, text: string, to?: string[], re?: string, extra: { item?: string; native?: boolean; deliveredAt?: number; labels?: Record<string, string>; blocked?: boolean } = {}): Post | null {
    const p = this.get(pid);
    const body = text.trim().slice(0, MAX_POST);
    if (!p || !body || !POST_KINDS.includes(kind)) return null;
    const who = (to ?? []).filter((s) => s === 'user' || (p.sessions.includes(s) && s !== by));
    const answers = re && p.thread.some((y) => y.id === re) ? re : undefined;
    const post: Post = { id: id(), by, kind, text: body, at: this.now(), ...(who.length ? { to: who } : {}), ...(answers ? { re: answers } : {}), ...(extra.item ? { item: extra.item } : {}), ...(extra.native ? { native: true } : {}), ...(extra.deliveredAt ? { deliveredAt: extra.deliveredAt } : {}), ...(extra.labels && Object.keys(extra.labels).length ? { labels: extra.labels } : {}), ...(extra.blocked ? { blocked: true as const } : {}), ...(p.members[by]?.seat ? { seat: p.members[by].seat } : {}) };
    p.thread.push(post);
    if (p.thread.length > MAX_POSTS) p.thread = p.thread.slice(-MAX_POSTS);
    if (kind === 'decision') {
      p.decisions.push({ id: post.id, text: body.slice(0, MAX_DECISION), by, at: post.at });
      p.briefAt = post.at;
    }
    this.changed();
    return post;
  }

  /** A decision changed or taken back (null). */
  editDecision(pid: string, did: string, text: string | null): boolean {
    const p = this.get(pid);
    const d = p?.decisions.find((x) => x.id === did);
    if (!p || !d) return false;
    if (text == null || !text.trim()) p.decisions = p.decisions.filter((x) => x.id !== did);
    else d.text = text.trim().slice(0, MAX_DECISION);
    p.briefAt = this.now();
    this.changed();
    return true;
  }

  decide(pid: string, by: string, text: string): Decision | null {
    const post = this.post(pid, by, 'decision', text);
    return post ? (this.get(pid)!.decisions.find((d) => d.id === post.id) ?? null) : null;
  }

  /** Set a project's team: validated, versioned, the old one kept. */
  /**
   * A lead's proposal waiting then was made on the version before: it's set aside (`dropped`), as it would read as
   * undoing this one and could never be approved.
   */
  setTeam(pid: string, team: unknown, by: string, expectVersion?: number): { ok: true; team: Team; previous?: Team; dropped?: NonNullable<Project['teamProposal']> } | { ok: false; error: string; problems?: string[] } {
    const p = this.get(pid);
    if (!p) return { ok: false, error: 'No such project.' };
    const cur = p.team?.version ?? 0;
    if (expectVersion !== undefined && expectVersion !== cur) return { ok: false, error: `Changed since you opened it: version ${cur}` };
    const v = validateTeam(team);
    if (!v.ok) return { ok: false, error: 'The team has problems.', problems: v.problems };
    const t = this.now();
    const previous = p.team;
    // (its own copy: whoever holds the team as it was can't change the history)
    if (previous) p.teamHistory = [...(p.teamHistory ?? []), { version: previous.version, at: t, by, team: clone(previous) }].slice(-50);
    p.team = { ...v.team, version: cur + 1 };
    // a different team (no seat in common with the one before): the one you stood down is gone, and so is its flag
    if (p.teamStoodDown && !p.team.seats.some((s) => previous?.seats.some((x) => x.id === s.id))) delete p.teamStoodDown;
    const dropped = p.teamProposal;
    delete p.teamProposal;
    p.briefAt = t;
    this.changed();
    return { ok: true, team: p.team, ...(previous ? { previous } : {}), ...(dropped ? { dropped } : {}) };
  }
  /** Re-apply an earlier version as a new one. */
  rollbackTeam(pid: string, version: number, by: string): ReturnType<Projects['setTeam']> {
    const p = this.get(pid);
    const old = p?.team?.version === version ? p.team : p?.teamHistory?.find((h) => h.version === version)?.team;
    if (!old) return { ok: false, error: `No version ${version}.` };
    return this.setTeam(pid, old, by);
  }
  /** Whether its team is up (Bring up / Stand down): kept, so a restart keeps the team running. Up, then not: stood down. */
  setTeamUp(pid: string, on: boolean): void {
    const p = this.get(pid);
    if (!p || !!p.teamUp === on) return;
    if (on) {
      p.teamUp = true;
      delete p.teamStoodDown;
    } else {
      delete p.teamUp;
      p.teamStoodDown = true;
    }
    this.changed();
  }
  /** The seats stood down on their own (none: the field goes). */
  setTeamDown(pid: string, seats: string[]): void {
    this.setSeats(pid, 'teamDown', seats);
  }
  /** The seats waiting for a restart (none: the field goes). */
  setTeamRestart(pid: string, seats: string[]): void {
    this.setSeats(pid, 'teamRestart', seats);
  }
  /** The pools made smaller still closing their extras (none: the field goes). */
  setTeamTrim(pid: string, seats: string[]): void {
    this.setSeats(pid, 'teamTrim', seats);
  }
  private setSeats(pid: string, key: 'teamDown' | 'teamRestart' | 'teamTrim', seats: string[]): void {
    const p = this.get(pid);
    if (!p || (p[key] ?? []).join('|') === seats.join('|')) return;
    if (seats.length) p[key] = [...seats];
    else delete p[key];
    this.changed();
  }
  /** No lead chosen (Crew) no longer holds: the team's lead seat changed. */
  endLeadNone(pid: string): void {
    const p = this.get(pid);
    if (!p?.leadNone) return;
    delete p.leadNone;
    this.changed();
  }
  /** A team change the lead proposes (replacing any before it), or none (null). */
  setTeamProposal(pid: string, proposal: Project['teamProposal'] | null): boolean {
    const p = this.get(pid);
    if (!p) return false;
    if (proposal) p.teamProposal = proposal;
    else if (p.teamProposal) delete p.teamProposal;
    else return true;
    this.changed();
    return true;
  }
  /** A member's team seat (null clears it). */
  setSeat(pid: string, sid: string, seat: string | null, instance?: number): boolean {
    const p = this.get(pid);
    if (!p?.sessions.includes(sid)) return false;
    const m = (p.members[sid] ??= { ...MEMBER_DEFAULTS });
    if (seat === null) {
      delete m.seat;
      delete m.instance;
    } else {
      m.seat = seat;
      if (instance !== undefined) m.instance = instance;
      else delete m.instance;
    }
    this.changed();
    return true;
  }

  /** Where the builder draws the team: beside it, never a version or a history entry. False: not a layout. */
  setTeamLayout(pid: string, layout: unknown): boolean {
    const p = this.get(pid);
    const l = cleanLayout(layout);
    if (!p || !l) return false;
    if (!Object.keys(l.pos).length && !l.color) return true; // nothing usable in it: what is saved stays
    p.teamLayout = l;
    this.changed();
    return true;
  }

  /** The project's builder draft, if any. */
  draft(pid: string): BuilderDraft | undefined {
    return this.get(pid)?.builderDraft;
  }
  /** The project whose builder session this is (null: none). */
  builderOf(sid: string): string | null {
    return this.all.find((p) => p.builderDraft?.session === sid)?.id ?? null;
  }

  /**
   * A change to the draft (made when there's none), as a new revision. `expect`: the revision it was made on (a newer
   * one there: refused). Cora's change is also a turn, with the team before and after it.
   */
  setDraft(pid: string, team: Team, by: 'you' | 'cora', o: { expect?: number; base?: number } = {}): { ok: true; draft: BuilderDraft } | { ok: false; error: string; rev?: number } {
    const p = this.get(pid);
    if (!p) return { ok: false, error: 'No such project.' };
    const d = p.builderDraft;
    if (o.expect !== undefined && (d ? o.expect !== d.rev : o.expect > 0)) {
      const rev = d?.rev ?? p.builderRev ?? 0;
      return { ok: false, error: `The draft changed since (revision ${rev}).`, rev };
    }
    if (o.base !== undefined && o.base !== (d?.base ?? p.team?.version ?? 0)) return { ok: false, error: `The team is on version ${p.team?.version ?? 0} now, not ${o.base}.` };
    return this.put(p, team, by);
  }
  /** The draft as a new revision (revisions only go up, even across a discard); `undo`: turns marked undone in the same write. */
  private put(p: Project, team: Team, by: 'you' | 'cora', undo: string[] = []): { ok: true; draft: BuilderDraft } {
    const d = p.builderDraft;
    const base = d?.base ?? p.team?.version ?? 0;
    const before = d?.team ?? p.team ?? emptyTeam(base);
    const now = this.now();
    const rev = Math.max(d?.rev ?? 0, p.builderRev ?? 0) + 1;
    const turns = (d?.turns ?? []).map((x) => (undo.includes(x.id) ? { ...x, undone: true as const } : x));
    const next: BuilderDraft = { team: { ...clone(team), version: base }, rev, by, base, at: now, turns, ...(d?.session ? { session: d.session } : {}) };
    if (by === 'cora') next.turns = [...next.turns, { id: id(), at: now, summary: summarizeChange(before, next.team), before: clone(before), after: clone(next.team) }].slice(-MAX_TURNS);
    p.builderDraft = next;
    p.builderRev = rev;
    this.drafted(p.id);
    return { ok: true, draft: next };
  }

  /** The draft goes (applied, or thrown away): what it was. */
  discardDraft(pid: string): BuilderDraft | undefined {
    const p = this.get(pid);
    const d = p?.builderDraft;
    if (!p || !d) return undefined;
    delete p.builderDraft;
    // its session's id was on the projects list (screens hide it): they hear the list again
    if (d.session) this.onChange?.();
    this.drafted(pid);
    return d;
  }

  /** The builder's session for a project (null: none now). A draft is made from the team (revision 0) when there is none. */
  setDraftSession(pid: string, sid: string | null): boolean {
    const p = this.get(pid);
    if (!p) return false;
    if (sid) p.builderDraft = { ...(p.builderDraft ?? this.freshDraft(p)), session: sid };
    else if (p.builderDraft) delete p.builderDraft.session;
    this.onChange?.();
    this.drafted(pid);
    return true;
  }
  private freshDraft(p: Project): BuilderDraft {
    const base = p.team?.version ?? 0;
    return { team: clone(p.team ?? emptyTeam(base)), rev: p.builderRev ?? 0, by: 'you', base, at: this.now(), turns: [] };
  }

  /** Cora's turns taken back off the draft as it is now (your later edits stay), as a new revision of yours. */
  undoTurns(pid: string, ids: string[]): { ok: true; draft: BuilderDraft } | { ok: false; error: string } {
    const d = this.get(pid)?.builderDraft;
    if (!d) return { ok: false, error: 'There is no draft.' };
    const turns = d.turns.filter((x) => ids.includes(x.id) && !x.undone);
    if (!turns.length) return { ok: false, error: 'Nothing to undo there.' };
    // turn by turn, the last first: an edit of yours made between two of them stays
    const team = turns.reduceRight((cur, t) => rebaseTeam(t.after, t.before, cur).team, d.team);
    const fresh = newProblems(d.team, team);
    if (fresh.length) return { ok: false, error: `Taking that back would break the draft (${fresh.join('; ')}), so it stays as it is.` };
    return this.put(this.get(pid)!, team, 'you', ids);
  }

  /**
   * The draft put on top of the team as it is now (an Apply was refused: someone changed it). `dry`: only what they
   * changed, the conflicts and any problem the rebase would add; otherwise the draft is rebased (yours kept where you both changed something).
   */
  rebaseDraft(pid: string, dry: boolean): { ok: true; theirs: string[]; conflicts: string[]; problems?: string[]; draft?: BuilderDraft } | { ok: false; error: string; theirs?: string[]; conflicts?: string[]; problems?: string[] } {
    const p = this.get(pid);
    const d = p?.builderDraft;
    if (!p || !d) return { ok: false, error: 'There is no draft.' };
    const cur = p.team?.version ?? 0;
    if (d.base === cur) return { ok: false, error: `The draft is already on version ${cur}.` };
    const old = d.base === 0 ? emptyTeam(0) : p.teamHistory?.find((h) => h.version === d.base)?.team;
    if (!old) return { ok: false, error: `Version ${d.base} is no longer kept, so the draft can't be rebased: Discard draft (under Start over) starts again from version ${cur}.` };
    const theirs = p.team ?? emptyTeam(cur);
    const r = rebaseTeam(old, theirs, d.team);
    const lines = teamChangeLines(old, theirs);
    const next = { ...r.team, version: cur };
    const problems = newProblems(d.team, next);
    if (dry) return { ok: true, theirs: lines, conflicts: r.conflicts, ...(problems.length ? { problems } : {}) };
    if (problems.length) return { ok: false, error: `Your draft and their changes don't fit together (${problems.join('; ')}): fix the draft by hand, or Discard draft (under Start over) to start again from version ${cur}.`, theirs: lines, conflicts: r.conflicts, problems };
    const rev = Math.max(d.rev, p.builderRev ?? 0) + 1;
    p.builderDraft = { ...d, team: next, base: cur, rev, by: 'you', at: this.now() };
    p.builderRev = rev;
    this.drafted(pid);
    return { ok: true, theirs: lines, conflicts: r.conflicts, draft: p.builderDraft };
  }

  private drafted(pid: string): void {
    this.save();
    this.onDraft?.(pid);
  }

  private changed(): void {
    this.save();
    this.onChange?.();
  }
  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ projects: this.all }));
    renameSync(tmp, this.file);
  }
}

function validColor(c: unknown): string | null {
  return typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;
}

/** A layout as the builder sends it, kept to what it may hold: whole-number positions and colours, by id. */
function cleanLayout(x: unknown): TeamLayout | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as { pos?: unknown; color?: unknown };
  if (!o.pos || typeof o.pos !== 'object' || Array.isArray(o.pos)) return null;
  const pos: TeamLayout['pos'] = {};
  for (const [k, v] of Object.entries(o.pos as Record<string, unknown>).slice(0, 500)) {
    const p = v as { x?: unknown; y?: unknown } | null;
    if (k.length <= 80 && p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos[k] = { x: Math.round(p.x as number), y: Math.round(p.y as number) };
  }
  const color: Record<string, string> = {};
  for (const [k, v] of Object.entries((o.color ?? {}) as Record<string, unknown>).slice(0, 500)) {
    const c = validColor(v);
    if (c && k.length <= 80) color[k] = c;
  }
  return { pos, ...(Object.keys(color).length ? { color } : {}) };
}

/** The problems `after` has that `before` didn't (an unfinished draft may have its own: only what an operation adds counts). */
export function newProblems(before: Team, after: Team): string[] {
  const had = new Set((() => { const v = validateTeam(before); return v.ok ? [] : v.problems; })());
  const v = validateTeam(after);
  return v.ok ? [] : v.problems.filter((x) => !had.has(x));
}
