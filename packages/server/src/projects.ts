import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { MAX_BRIEF, MAX_DECISION, MAX_POST, MAX_POSTS, MEMBER_DEFAULTS, MEMBER_ON, POST_KINDS, PROJECT_COLORS, type Decision, type MemberSettings, type Post, type PostKind, type Project, type ProjectHears } from '@cora/shared';

const id = () => randomBytes(6).toString('hex');
const HEARS: ProjectHears[] = ['nothing', 'brief', 'everything'];

/**
 * Projects: kept on the server (~/.cora/projects.json), so they
 * follow you to every device. A session is in at most one project: added to one, it leaves any other.
 */
export class Projects {
  private all: Project[] = [];
  /** something changed (the app publishes them) */
  onChange?: () => void;
  constructor(private file: string | null, private now: () => number = Date.now) {
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { projects?: Project[] };
        this.all = (j.projects ?? []).filter((p) => p && typeof p.id === 'string' && Array.isArray(p.sessions));
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

  update(pid: string, patch: { name?: unknown; color?: unknown; brief?: unknown; coordination?: unknown; shade?: unknown; autoWake?: unknown }): Project | null {
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
    if (p.waiting) p.waiting = p.waiting.filter((w) => w.to !== sid);
    this.changed();
    return true;
  }

  setMember(pid: string, sid: string, patch: { hears?: unknown; canPost?: unknown; wakes?: unknown }): MemberSettings | null {
    const p = this.get(pid);
    if (!p?.sessions.includes(sid)) return null;
    const m = (p.members[sid] ??= { ...MEMBER_DEFAULTS });
    if (HEARS.includes(patch.hears as ProjectHears)) m.hears = patch.hears as ProjectHears;
    if (typeof patch.canPost === 'boolean') m.canPost = patch.canPost;
    if (typeof patch.wakes === 'boolean') m.wakes = patch.wakes;
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
    // what was waiting for it, it has now
    if (p.waiting?.some((w) => w.to === sid)) {
      p.waiting = p.waiting.filter((w) => w.to !== sid);
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
  unwait(pid: string, post: string, to: string): void {
    const p = this.get(pid);
    if (!p?.waiting) return;
    p.waiting = p.waiting.filter((w) => !(w.post === post && w.to === to));
    this.changed();
  }

  /** Pin a note (it joins every member's card), or not. */
  pin(pid: string, postId: string, on: boolean): boolean {
    const x = this.get(pid)?.thread.find((y) => y.id === postId);
    if (!x) return false;
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
  post(pid: string, by: string, kind: PostKind, text: string, to?: string[], re?: string): Post | null {
    const p = this.get(pid);
    const body = text.trim().slice(0, MAX_POST);
    if (!p || !body || !POST_KINDS.includes(kind)) return null;
    const who = (to ?? []).filter((s) => s === 'user' || (p.sessions.includes(s) && s !== by));
    const answers = re && p.thread.some((y) => y.id === re) ? re : undefined;
    const post: Post = { id: id(), by, kind, text: body, at: this.now(), ...(who.length ? { to: who } : {}), ...(answers ? { re: answers } : {}) };
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
