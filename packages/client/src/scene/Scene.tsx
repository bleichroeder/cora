import { useEffect, useMemo, useRef, useState } from 'react';
import { makeSystem } from './system/generate';
import { jumpToHyperspace, newSeed, useWarp } from './system/warp';
import { SIZE_K, spaceOf } from './system/settings';
import { GlGuard } from '../components/GlGuard';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import * as THREE from 'three';
import { FAM, type AgentInfo } from '@cora/shared';
import { agentKey, sessionEvents, useBrain } from '../state/store';
import { maskSecrets } from '../lib/mask';
import { BEACON, beaconArc, MAIN_POS, ORB_R, tagDrop, OVERFLOW_POS, resourceIcon, resourceLabel } from './layout';
import { Backdrop, Comet, Link, OP_COLOR, Orb, Resource, resourceColor, type OrbApi, type PickTarget, type Picker, dropletKick, programRunning } from './parts';
import { COMET_LIFT, FlowComet, FlowLink, FlowUplink } from './flow';
import { tapeRows } from './tape';
import { anchorRef, elRef, LabelProjector, type LabelRegistry } from './labels';
import { FxLayer, worldPosFn, type Fx, type PosFn, type WorldRegistry } from './effects';
import { derive, type Derived } from './derive';
import { DOCK_PILLS, ExplainShelf, type ShelfItem } from './explains';
import { FOV, newCam, resetCam, Rig, CENTER } from './camera';
import { SceneVeil, Warmup } from './warmup';
import { explainFrom } from '../components/Viewer';
import { Icon } from '../components/Icon';
import './labels.css';
import { InlineMarkdown } from '../components/InlineMarkdown';
import { useVoice } from '../lib/voice';
import { openDroplet } from '../components/DiffView';
import { AnthropicOrb, ANTH_OFFSET, ANTH_R, CLAY, LINK_LIFT, Uplink } from './comms';
import { programCard, programDetails } from './programs';
import { outcome } from '../lib/background';
import { BANG_MS, COLLAPSE_MS, Cosmos, comeBack, type CosmicPhase } from './cosmic';
import { ago, dur } from '../lib/format';
import { replayAt } from '../lib/replay';
import { Golf, type GolfApi } from './golf/Golf';
import { latestByTitle } from '../lib/explainVersions';
import { CiLogPanel } from '../components/CiStrip';

const MAIN_V = new THREE.Vector3(MAIN_POS.x, MAIN_POS.y, 0);
const ANTH_POS = MAIN_V.clone().add(ANTH_OFFSET);
const ZERO = new THREE.Vector3();
/** prompts arrive from beyond the left edge, level with main, and hit its left side */
const PROMPT_FROM = MAIN_V.clone().add(new THREE.Vector3(-15, 0.3, 0.6));
const HIT_DIR = new THREE.Vector3(-1, 0.06, 0.25).normalize();
const RED = '#f87171';

/**
 * Re-render when a session's events change, but at most once per `ms`: a busy session (or one loading its
 * history) sends events in bursts, and each full scene render re-derives from all of them.
 */
function useThrottledVersion(sessionId: string, ms: number): number | undefined {
  const [v, setV] = useState(() => useBrain.getState().versions[sessionId]);
  useEffect(() => {
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      last = Date.now();
      setV(useBrain.getState().versions[sessionId]);
    };
    flush();
    let prev = useBrain.getState().versions[sessionId];
    const unsub = useBrain.subscribe((st) => {
      const next = st.versions[sessionId];
      if (next === prev) return;
      prev = next;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    });
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, ms]);
  return v;
}

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Why the glow went away: the frame-rate monitor's decisions, kept on window.__coraFx for diagnosis. */
function fxLog(kind: string, fps: number) {
  const w = window as unknown as { __coraFx?: Array<{ at: number; kind: string; fps: number; visible: boolean; focused: boolean }> };
  (w.__coraFx ??= []).push({ at: Math.round(performance.now()), kind, fps: Math.round(fps), visible: document.visibilityState === 'visible', focused: document.hasFocus() });
  console.info(`[cora] effects ${kind} at ${Math.round(fps)} fps`);
}

const sameTarget = (a: PickTarget | null, b: PickTarget) =>
  !!a && a.kind === b.kind && (a.kind === 'file' && b.kind === 'file' ? a.res === b.res && a.name === b.name : (a as { id: string }).id === (b as { id: string }).id);

/** Red rings pulse out of every agent waiting on you, open at the bottom so they never cross its name. */
const BEACON_ARC = { main: beaconArc(BEACON.main.r1, tagDrop(ORB_R.main, true)), sub: beaconArc(BEACON.sub.r1, tagDrop(ORB_R.sub, false)) };
function Beacons({ ids, fx, world }: { ids: string[]; fx: React.MutableRefObject<Fx | null>; world: WorldRegistry }) {
  const last = useRef(0);
  useFrame(() => {
    const now = Date.now();
    if (!ids.length || now - last.current < 1300 || !fx.current) return;
    last.current = now;
    for (const id of ids) {
      const k = id === 'main' ? 'main' : 'sub';
      fx.current.ripple(worldPosFn(world, `agent:${id}`), RED, BEACON[k].r0, BEACON[k].r1, 1300, false, BEACON_ARC[k]);
    }
  });
  return null;
}

function tipHtml(t: PickTarget, d: Derived, sessionId: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  if (t.kind === 'agent') {
    const a = d.agents.find((x) => x.a.agentId === t.id);
    if (!a) return '';
    const ctx = a.isMain && d.context ? ` · context ${Math.round(d.context.used / 1000)}k / ${d.context.max / 1000}k` : '';
    return `<b>${esc(a.name)}</b> <span class="d">${a.isMain ? 'main agent' : esc(a.a.agentType)}</span><div>${esc(a.status.text)}</div><div class="d">${a.tools} tool calls${ctx}</div><div class="d">click to focus · double-click empty space to reset</div>`;
  }
  if (t.kind === 'res') {
    const r = d.resources.find((x) => x.id === t.id);
    if (!r) return '';
    return `<b>${esc(resourceLabel(r.id))}</b><div class="d">${r.calls} calls${r.files.length ? ` · ${r.files.length} files` : ''}</div><div class="d">click to focus${r.files.length ? ' and line up its files' : ''}</div>`;
  }
  if (t.kind === 'file') {
    const f = d.resources.find((x) => x.id === t.res)?.files.find((x) => x.name === t.name);
    if (!f) return '';
    // a program around the shell radiant: what it's been doing
    if (f.program) return `<div class="prog-tip">${programCard(f.name, programDetails(sessionEvents(sessionId)).get(f.name))}</div>`;
    return `<b>${esc(f.name)}</b><div>last <span style="color:${OP_COLOR[f.op]}">${f.op}</span> · touched ${f.count}×</div><div class="d">${f.changed ? 'click to see what changed' : 'click to search the transcript for it'}</div>`;
  }
  const e = d.explains.find((x) => x.toolUseId === t.id);
  const p = e ? explainFrom(e.event) : null;
  return p ? `<b>${esc(p.title)}</b><div class="d">explain · click to open</div>` : '';
}

export function Scene({ sessionId }: { sessionId: string }) {
  const version = useThrottledVersion(sessionId, 160);
  const allAgents = useBrain((s) => s.agents);
  const session = useBrain((s) => s.sessions[sessionId]);
  // a session ending while you watch: a black hole swallows the scene; coming back: a big bang
  const cosmosGroup = useRef<THREE.Group>(null);
  const cosmic = useRef<CosmicPhase>(null);
  useEffect(() => {
    useWarp.setState({
      blocked: () => {
        const p = cosmic.current;
        if (!p) return false;
        const age = Date.now() - p.at;
        return p.kind === 'collapse' ? age < COLLAPSE_MS : p.kind === 'bang' ? age < BANG_MS : age < BANG_MS;
      },
    });
    return () => useWarp.setState({ blocked: () => false });
  }, []);
  const labelsEl = useRef<HTMLDivElement>(null);
  const cosmicNote = useRef<HTMLDivElement>(null);
  // starts unset: the first session shown counts as switched to (an ended one opens as its black hole)
  const lastState = useRef<{ sid: string; state?: string }>({ sid: '' });
  const allPending = useBrain((s) => s.pending);
  const filter = useBrain((s) => s.agentFilter);
  // voice: main's label says so while you talk to it or it reads aloud (this session, not another one or Cora)
  const voiceNow = useVoice((v) => ((v.ptt.phase === 'listening' || v.ptt.phase === 'finishing') && v.ptt.sessionId === sessionId ? 'listen' : v.reading?.sessionId === sessionId ? 'speak' : null));
  const setFilter = useBrain((s) => s.setAgentFilter);
  const [lowFx, setLowFx] = useState(false);
  // the shell tape, expanded past its few rows
  const [tapeOpen, setTapeOpen] = useState(false);
  const flowLinks = useBrain((s) => s.prefs.flowLinks);
  // the star system behind it all: remembered; the first time, one is picked
  const seed = useBrain((s) => s.prefs.starSystem);
  useEffect(() => {
    if (seed == null) useBrain.getState().setPrefs({ starSystem: newSeed() });
  }, [seed]);
  const space = spaceOf(useBrain((s) => s.prefs.space));
  const system = useMemo(() => makeSystem(seed ?? 1, { size: SIZE_K[space.size] }), [seed, space.size]);
  const declined = useRef(false);
  useTick(500);
  const slotsRef = useRef(new Map<string, number>());
  const cursor = useBrain((s) => (s.cursor?.sessionId === sessionId ? s.cursor : null));
  const replaySlots = useRef<Map<string, number> | null>(null);
  const hits = useRef(new Map<string, number>());
  const prevLive = useRef(new Set<string>());
  const busy = useRef(0);
  const reg = useRef<LabelRegistry>(new Map()).current;
  const world = useRef<WorldRegistry>(new Map()).current;
  const fx = useRef<Fx | null>(null);
  const orbApi = useRef(new Map<string, OrbApi>()).current;
  const seen = useRef(new Set<string>());
  const cam = useMemo(newCam, []);
  const hovered = useRef<PickTarget | null>(null);
  // hovered from a label (its chip): lifted, but no scene tooltip
  const hoverQuiet = useRef(false);
  const tip = useRef<HTMLDivElement>(null);
  const dRef = useRef<Derived | null>(null);
  const toastRef = useRef<HTMLDivElement>(null);
  // the picker's handlers outlive a session switch: they read the current session from here
  const sid = useRef(sessionId);
  sid.current = sessionId;
  // talking to Anthropic: calls in flight, the orb's flash, who was waiting last render, the last reply's numbers
  const inflight = useRef(0);
  const anthFlash = useRef(0);
  const prevWaiting = useRef<Set<string> | null>(null);
  const lastReply = useRef<{ at: number; text: string } | null>(null);
  // gravity golf: double-click empty space to play (the game takes the scene's input until you leave)
  const golf = useRef<GolfApi | null>(null);

  useEffect(() => {
    slotsRef.current = new Map();
    prevWaiting.current = null;
    resetCam(cam);
    cam.dist = 1.55; // start a little further out and dolly in (the rig eases dist back to 1)
  }, [sessionId, cam]);

  const agents = useMemo(() => {
    const list = Object.values(allAgents).filter((a) => a.sessionId === sessionId);
    // a session that hasn't produced any events yet (e.g. just launched) still has a main agent
    if (!list.some((a) => a.agentId === 'main')) {
      list.push({ sessionId, agentId: 'main', parentAgentId: null, parentToolUseId: null, label: 'main', agentType: 'main', colorIdx: -1, startedAt: 0, endedAt: null, state: 'idle' } satisfies AgentInfo);
    }
    return list;
  }, [allAgents, sessionId]);
  const now = Date.now();
  // the timeline's playhead: the scene as it stood then (its own slots, so the live layout is kept for coming back)
  const replay = cursor ? replayAt(sessionEvents(sessionId), agents, cursor.ts, cursor.wall - cursor.ts) : null;
  const d = derive(replay?.events ?? sessionEvents(sessionId), replay?.agents ?? agents, replay ? (replaySlots.current ??= new Map(slotsRef.current)) : slotsRef.current, now, session?.model);
  if (replay) replaySlots.current = d.slots;
  else (slotsRef.current = d.slots), (replaySlots.current = null);
  dRef.current = d;
  void version;
  busy.current = d.busy;
  for (const r of d.live) hits.current.set(r, 1);
  for (const r of prevLive.current) if (!d.live.has(r)) hits.current.set(r, 2);
  prevLive.current = d.live;

  const pending = allPending.filter((p) => p.sessionId === sessionId);
  const alerted = new Set(pending.map((p) => (d.agents.some((a) => a.a.agentId === p.agentId) ? p.agentId : 'main')));
  if (session?.state === 'needs-you' && !alerted.size) alerted.add('main');
  // one pill per explain: a title written again is a new version of it
  const shelf: ShelfItem[] = latestByTitle(
    d.explains.flatMap((x) => {
      const p = explainFrom(x.event);
      return p ? [{ id: x.toolUseId, sessionId, title: p.title, format: p.format, ts: x.ts }] : [];
    }),
  );

  const agentPos = (id: string): PosFn => worldPosFn(world, `agent:${id}`);
  const dirBetween = (fromKey: string, toKey: string): THREE.Vector3 | null => {
    const a = world.get(fromKey), b = world.get(toKey);
    if (!a || !b) return null;
    return b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).normalize();
  };
  const orbRipple = (agentId: string, toKey: string, amp: number) => {
    const d = dirBetween(`agent:${agentId}`, toKey);
    if (d) orbApi.get(agentId)?.ripple(d, amp);
  };
  const mainPos = useMemo(() => worldPosFn(world, 'agent:main'), [world]);
  // main's uplink runs straight up from the top of main to the bottom of Anthropic
  const mainTop = useMemo(() => {
    const v = new THREE.Vector3();
    return () => {
      const m = mainPos();
      return m ? v.copy(m).add(new THREE.Vector3(0, 0.95, 0)) : null;
    };
  }, [mainPos]);
  const anthBottom = useMemo(() => {
    const v = ANTH_POS.clone().add(new THREE.Vector3(0, -ANTH_R * 1.3, 0));
    return () => v;
  }, []);
  const hitPoint = useMemo(() => {
    const v = new THREE.Vector3();
    return () => {
      const m = mainPos();
      return m ? v.copy(m).addScaledVector(HIT_DIR, 0.82) : null;
    };
  }, [mainPos]);
  // agents waiting on a reply from Claude (thinking with nothing in flight)
  const waiting = d.agents.filter((x) => x.thinking && x.diedAt == null).map((x) => ({ id: x.a.agentId, color: x.color }));
  inflight.current = waiting.length;

  useEffect(() => {
    const prev = lastState.current;
    const state = session?.state;
    lastState.current = { sid: sessionId, state };
    if (prev.sid !== sessionId) {
      // another session: an ended one is its black hole already (however it ended, whether you watched or not)
      cosmic.current = state === 'ended' ? { kind: 'collapse', at: Date.now() - COLLAPSE_MS - 1 } : null;
      return;
    }
    // its state just arrived (the session list loading): no animation for what was already so
    if (!prev.state) {
      if (state === 'ended') cosmic.current = { kind: 'collapse', at: Date.now() - COLLAPSE_MS - 1 };
      return;
    }
    if (prev.state === state) return;
    if (state === 'ended') {
      cosmic.current = { kind: 'collapse', at: Date.now() };
      resetCam(cam);
    } else if (prev.state === 'ended') cosmic.current = comeBack(cosmic.current, Date.now());
  }, [sessionId, session?.state, cam]);
  // a session you just started, resumed or forked opens with a big bang
  const bangFor = useBrain((s) => s.bang);
  useEffect(() => {
    if (!bangFor || bangFor !== sessionId) return;
    cosmic.current = { kind: 'bang', at: Date.now() };
    useBrain.getState().setBang(null);
  }, [bangFor, sessionId]);
  // rewinding an ended session brings its scene back out of the black hole; back to live, it collapses again
  const replaying = cursor != null;
  useEffect(() => {
    if (replaying && cosmic.current?.kind === 'collapse') cosmic.current = comeBack(cosmic.current, Date.now());
    else if (!replaying && session?.state === 'ended' && !cosmic.current) cosmic.current = { kind: 'collapse', at: Date.now() };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replaying]);

  const toast = (s: string) => {
    const t = toastRef.current;
    if (!t) return;
    t.textContent = s;
    t.classList.add('on');
    clearTimeout((t as any)._h);
    (t as any)._h = setTimeout(() => t.classList.remove('on'), 2600);
  };

  const picker: Picker = useMemo(
    () => ({
      isHovered: (t) => sameTarget(hovered.current, t),
      hover: (t, o) => {
        hovered.current = t;
        hoverQuiet.current = !!o?.quiet;
        const el = tip.current;
        if (!el) return;
        const html = t && dRef.current && !o?.quiet ? tipHtml(t, dRef.current, sid.current) : '';
        el.innerHTML = html;
        el.style.display = html ? 'block' : 'none';
        document.body.style.cursor = t ? 'pointer' : '';
      },
      pick: (t) => {
        const st = useBrain.getState();
        const dd = dRef.current;
        if (t.kind === 'agent') {
          cam.focus = `agent:${t.id}`;
          cam.tPan.set(0, 0, 0);
          cam.tDist = 0.55;
          st.setAgentFilter(t.id === 'main' ? 'all' : t.id);
          st.setRightTab('transcript');
        } else if (t.kind === 'res') {
          // focus the radiant; its droplets stop and line up so they can be picked
          if (cam.focus === `res:${t.id}`) resetCam(cam);
          else {
            cam.focus = `res:${t.id}`;
            cam.tPan.set(0, 0, 0);
            cam.tDist = 0.42;
          }
        } else if (t.kind === 'file') {
          const f = dd?.resources.find((x) => x.id === t.res)?.files.find((x) => x.name === t.name);
          openDroplet(sid.current, f?.path, t.name, f?.changed);
        } else {
          const e = dd?.explains.find((x) => x.toolUseId === t.id);
          const p = e ? explainFrom(e.event) : null;
          if (p) st.setViewer(p);
        }
      },
    }),
    [cam],
  );
  useEffect(() => () => void (document.body.style.cursor = ''), []);

  // Fire one-shot effects for events first seen while they are still fresh. Everything is marked seen, so a
  // session opened later does not replay its history.
  useEffect(() => {
    // replayed history (the timeline's playhead) never fires them; nothing is marked seen, so live picks up as before
    if (replay) return void (prevWaiting.current = null);
    const f = fx.current;
    const t = Date.now();
    const fresh = (key: string, ts: number, win: number) => {
      if (seen.current.has(key)) return false;
      seen.current.add(key);
      return t - ts < win;
    };
    // a background command finished: its program's droplet bursts in the outcome's colour, with a short note
    for (const bt of d.tasks) {
      if (bt.endedAt == null || !fresh(`task:${sessionId}:${bt.key}`, bt.endedAt, 6000) || !f) continue;
      const col = bt.status === 'completed' ? '#4ade80' : bt.status === 'failed' ? RED : '#94a3b8';
      f.burst(worldPosFn(world, `file:shell|${bt.program}`, 'res:shell'), col, 30);
      toast(`${bt.status === 'completed' ? '✓' : bt.status === 'failed' ? '✗' : '■'} ${bt.label} · ${outcome(bt)}`);
    }
    for (const c of d.comets) {
      if (fresh(`start:${sessionId}:${c.key}`, c.startedAt, 3000)) orbRipple(c.agentId, `res:${c.resource}`, 0.09);
      if (c.endedAt != null && !seen.current.has(`end:${sessionId}:${c.key}`) && t - c.endedAt < 4000) {
        if (c.failed) orbApi.get(c.agentId)?.shiver();
        else orbRipple(c.agentId, `res:${c.resource}`, 0.07);
      }
      if (c.endedAt == null || !fresh(`end:${sessionId}:${c.key}`, c.endedAt, 4000) || !f) continue;
      // calls are routed through the resource; its tube carries them on to the file
      const target = worldPosFn(world, `res:${c.resource}`);
      const ag = agentPos(c.agentId);
      if (c.resource === 'shell' && c.file && !d.tasks.some((bt) => bt.key === c.key)) f.burst(worldPosFn(world, `file:shell|${c.file}`, `res:shell`), c.failed ? RED : '#4ade80', 18);
      if (c.failed) {
        f.burst(target, RED);
        f.ripple(ag, RED, c.agentId === 'main' ? 0.95 : 0.6, c.agentId === 'main' ? 2.2 : 1.4, 700);
      } else if (!lowFx && !flowLinks) {
        // the result coming back (more of it, more dots), along the call's own line (with tubes, it pulses back down the tube)
        f.stream(target, ag, Math.round(THREE.MathUtils.clamp(c.resultSize / 120, 4, 22)), '#67e8f9', 750, COMET_LIFT);
      }
    }
    for (const a of d.agents) {
      if (a.isMain || !f) continue;
      // born at, and reporting back to, whoever started it (main, or a subagent for a nested one)
      const parent = a.parentId;
      const parentPos = parent === 'main' ? mainPos : agentPos(parent);
      if (fresh(`born:${sessionId}:${a.a.agentId}`, a.bornAt, 1500)) {
        f.ripple(parentPos, a.color, parent === 'main' ? 0.95 : 0.6, 2.1, 700);
        orbRipple(parent, `agent:${a.a.agentId}`, 0.1);
      }
      if (a.diedAt != null && fresh(`done:${sessionId}:${a.a.agentId}`, a.diedAt, 4000)) {
        const from = dirBetween(`agent:${parent}`, `agent:${a.a.agentId}`);
        f.report(
          agentPos(a.a.agentId),
          parentPos,
          a.color,
          () => {
            fx.current?.ripple(parentPos, a.color, parent === 'main' ? 0.95 : 0.6, 2.7);
            if (from) orbApi.get(parent)?.ripple(from, 0.12);
          },
          LINK_LIFT,
        );
      }
    }
    const ca = d.context?.compactedAt;
    if (ca && fresh(`compact:${sessionId}:${ca}`, ca, 6000) && f) {
      orbApi.get('main')?.squash();
      f.ripple(mainPos, '#ffffff', 1.7, 3.8, 1200);
      f.burst(mainPos, '#e2e8f0', 60);
    }
    // your prompt: a small, fast payload from the left into main's left side
    const evs = sessionEvents(sessionId);
    for (let i = evs.length - 1; i >= 0 && t - evs[i].ts < 6000; i--) {
      const e = evs[i];
      if (e.kind !== 'prompt' || e.agentId !== 'main' || !fresh(`prompt:${sessionId}:${e.id}`, e.ts, 4000) || !f) continue;
      const len = (e.text ?? '').length;
      const big = Math.min(1.6, 0.8 + len / 160);
      f.payload(PROMPT_FROM, hitPoint, '#7dd3fc', 420 + Math.min(220, len * 2), () => {
        orbApi.get('main')?.ripple(HIT_DIR, 0.17 * big);
        setTimeout(() => orbApi.get('main')?.ripple(HIT_DIR, 0.07), 140);
        fx.current?.burst(hitPoint, '#bae6fd', 14);
      });
    }
    // talking to Anthropic: a request goes up when an agent starts waiting; the reply streams down when it stops
    const now2 = new Set(waiting.map((w) => w.id));
    const before = prevWaiting.current;
    prevWaiting.current = now2;
    if (before && f) {
      // a subagent's call travels its chain of parents to main, then up main's uplink
      const chain = (id: string): string[] => {
        const path = [id];
        for (let cur = id, k = 0; cur !== 'main' && k < 8; k++) {
          cur = d.agents.find((x) => x.a.agentId === cur)?.parentId ?? 'main';
          path.push(cur);
        }
        if (path[path.length - 1] !== 'main') path.push('main');
        return path;
      };
      const at = (id: string) => (id === 'main' ? mainPos : agentPos(id));
      const up = (path: string[], i: number, color: string): void => {
        if (i >= path.length - 1) {
          fx.current?.comet(mainTop, anthBottom, color, 460, ZERO, () => (anthFlash.current = Math.max(anthFlash.current, 0.5)));
          return;
        }
        fx.current?.comet(at(path[i]), at(path[i + 1]), color, 520, LINK_LIFT, () => {
          orbRipple(path[i + 1], `agent:${path[i]}`, 0.04);
          up(path, i + 1, color);
        });
      };
      for (const w of waiting) {
        if (before.has(w.id)) continue;
        up(chain(w.id), 0, w.color);
      }
      for (const id of before) {
        if (now2.has(id)) continue;
        const ag = d.agents.find((x) => x.a.agentId === id);
        if (!ag || ag.diedAt != null) continue;
        // the reply that ended the wait: its output decides how dense the stream is
        const reply = [...evs].reverse().find((e) => e.agentId === id && e.tokens && t - e.ts < 15_000);
        const out = reply?.tokens?.out ?? 400;
        const n = Math.round(THREE.MathUtils.clamp(out / 150, 5, 26));
        if (reply?.tokens) {
          const k = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}k` : `${x}`);
          lastReply.current = { at: t, text: `↓ ${k(out)}${reply.tokens.in ? ` · ↑ ${k(reply.tokens.in)}${reply.tokens.cached ? ` (${Math.round((reply.tokens.cached / reply.tokens.in) * 100)}% cached)` : ''}` : ''}` };
        }
        anthFlash.current = 0.9;
        const col = new THREE.Color(CLAY).lerp(new THREE.Color(ag.color), 0.45).multiplyScalar(1.3);
        const down = chain(id).reverse(); // main … id
        const step = (i: number): void => {
          if (i >= down.length - 1) return;
          fx.current?.stream(at(down[i]), at(down[i + 1]), Math.max(4, Math.round(n * 0.6)), ag.color, 600, LINK_LIFT, () =>
            i + 1 === down.length - 1 ? orbRipple(down[i + 1], `agent:${down[i]}`, 0.08) : step(i + 1),
          );
        };
        f.stream(anthBottom, mainTop, n, col, 650, ZERO, () => {
          if (id === 'main') orbApi.get('main')?.ripple(new THREE.Vector3(0, 1, 0), 0.08);
          else step(0);
        });
      }
    }
    for (const s of d.says) {
      if (!fresh(`say:${sessionId}:${s.id}`, s.ts, 3000) || !f || lowFx) continue;
      const bubble = reg.get(`${s.agentId}:bubble`)?.obj;
      const v = new THREE.Vector3();
      if (bubble) f.stream(agentPos(s.agentId), () => bubble.getWorldPosition(v), 10, '#e0f2fe', 600, new THREE.Vector3(0, 0, 1.5));
    }
  });

  // keep the tooltip text current while hovering
  useEffect(() => {
    if (hovered.current) picker.hover(hovered.current, { quiet: hoverQuiet.current });
  });

  // the canvas (by its key) whose shaders are compiled: it draws only then; until then the veil shows
  const [warmFor, setWarmFor] = useState<string | null>(null);
  const canvasKey = useRef<string | null>(null);


  return (
    <>
      <GlGuard name="scene">
        {({ key, onCreated }) => (
          <Canvas
            key={key}
            onCreated={(s) => ((canvasKey.current = key), onCreated(s))}
            frameloop={warmFor === key ? 'always' : 'never'}
            camera={{ position: [CENTER.x, -2.2, 23], fov: FOV, near: 0.1, far: 400 }}
            dpr={[1, 2]}
            gl={{ antialias: true }}
            onPointerMove={(e) => {
              const el = tip.current;
              if (!el) return;
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const x = Math.min(e.clientX - box.left + 14, box.width - 290);
              el.style.transform = `translate(${Math.round(x)}px, ${Math.round(e.clientY - box.top + 16)}px)`;
            }}
            onPointerLeave={() => picker.hover(null)}
            onPointerMissed={(e) => {
              if (e.type === 'click' && cam.focus && !cam.dragged) resetCam(cam);
              if (e.type === 'dblclick') golf.current?.toggle();
            }}
          >
            <color attach="background" args={['#06090f']} />
            {/* Hysteresis: the monitor gives up after 3 reports. It counts every report, even a run of "fine", so only
                settle on low effects if the frame rate actually dropped; a smooth scene keeps its glow. */}
            <PerformanceMonitor
              flipflops={3}
              onDecline={(api) => (fxLog('decline', api.fps), (declined.current = true), setLowFx(true))}
              onIncline={(api) => (fxLog('incline', api.fps), setLowFx(false))}
              onFallback={(api) => (fxLog('fallback', api.fps), setLowFx(declined.current))}
            />
            <Rig cam={cam} world={world} />
            <Backdrop busy={busy} system={system} lowFx={lowFx} space={space} />
            {/* everything a black hole can swallow (the stars and the effects layer stay outside) */}
            <group ref={cosmosGroup}>
            {d.resources.map((r) => (
              <Resource key={r.id} id={r.id} pos={r.pos} files={r.files} hits={hits} reg={reg} world={world} picker={picker} showSats cam={cam} />
            ))}
            {d.agents
              .filter((x) => !x.isMain)
              .map((x) => (
                flowLinks ? (
                  <FlowLink key={`l-${x.a.agentId}`} from={x.parentId === 'main' ? mainPos : agentPos(x.parentId)} to={agentPos(x.a.agentId)} color={x.color} alive={x.a.state !== 'done'} />
                ) : (
                  <Link key={`l-${x.a.agentId}`} from={x.parentId === 'main' ? mainPos : agentPos(x.parentId)} to={agentPos(x.a.agentId)} color={x.color} alive={x.a.state !== 'done'} />
                )
              ))}
            {flowLinks ? <FlowUplink from={mainTop} to={anthBottom} waiting={waiting} clay={CLAY} /> : <Uplink from={mainTop} to={anthBottom} waiting={waiting} />}
            <AnthropicOrb pos={ANTH_POS} inflight={inflight} flash={anthFlash} world={world} reg={reg} />
            {d.comets.map((c) =>
              flowLinks ? (
                <FlowComet
                  key={c.key}
                  from={agentPos(c.agentId)}
                  to={worldPosFn(world, `res:${c.resource}`)}
                  startedAt={c.startedAt}
                  endedAt={c.endedAt}
                  failed={c.failed}
                  agentColor={c.color}
                  resColor={resourceColor(c.resource)}
                />
              ) : (
                <Comet
                  key={c.key}
                  from={agentPos(c.agentId)}
                  to={worldPosFn(world, `res:${c.resource}`)}
                  startedAt={c.startedAt}
                  endedAt={c.endedAt}
                  failed={c.failed}
                  agentColor={c.color}
                  lowFx={lowFx}
                />
              ),
            )}
            {d.agents.map((x) => (
              <Orb
                key={agentKey(sessionId, x.a.agentId)}
                id={x.a.agentId}
                pos={x.pos}
                color={x.color}
                isMain={x.isMain}
                sessionId={sessionId}
                thinking={x.thinking}
                running={x.running}
                alert={alerted.has(x.a.agentId)}
                lastActivity={x.lastActivity}
                bornAt={x.bornAt}
                diedAt={x.diedAt}
                spawnFrom={x.isMain ? null : (d.agents.find((p) => p.a.agentId === x.parentId && !p.isMain)?.pos ?? MAIN_V)}
                busy={x.busy}
                targetKey={x.targetKey}
                api={orbApi}
                lowFx={lowFx}
                reg={reg}
                world={world}
                picker={picker}
              />
            ))}
            <ExplainShelf items={shelf} origin={mainPos} picker={picker} reg={reg} />
            <Beacons ids={[...alerted]} fx={fx} world={world} />
            </group>
            <FxLayer api={fx} />
            <Golf api={golf} cam={cam} world={world} fx={fx} orbs={orbApi} sessionId={sessionId} />
            <group ref={anchorRef(reg, 'overflow')} position={[OVERFLOW_POS.x, OVERFLOW_POS.y, 0]} />
            <LabelProjector reg={reg} />
            {/* bloom, and the black hole (which mounts the composer even on low effects while it's on) */}
            <Cosmos phase={cosmic} cosmos={cosmosGroup} labels={() => labelsEl.current} note={cosmicNote} lowFx={lowFx} />
            <Warmup onReady={() => setWarmFor(key)} />
          </Canvas>
        )}
      </GlGuard>
      <div className="cosmic-note" ref={cosmicNote}>session ended</div>
      {space.mode === 'systems' && space.button ? <WarpButton /> : null}
      <CiLogPanel sessionId={sessionId} />
      <div className="labels scene-labels" ref={labelsEl}>
        {d.resources.map((r) => (
          <div key={r.id} className="lbl" ref={elRef(reg, `res:${r.id}:tag`)}>
            <div className="res-tag">
              <Icon name={resourceIcon(r.id)} size={11} /> {resourceLabel(r.id)}
              {r.files.length ? <span className="res-n">{r.files.length} files</span> : null}
            </div>
          </div>
        ))}
        {/* the shell's recent commands: only while the shell is focused (zoomed in, its programs lined up in a ring),
            beside it to the right of the ring. Unfocused there's no room for it: its droplets orbit and wear chips. */}
        {cam.focus === 'res:shell' && d.commands.length && d.resources.some((r) => r.id === 'shell') ? (
          <div className="lbl" data-clampl="1" ref={elRef(reg, 'res:shell:cmds')}>
            <div className={`res-cmds tape${tapeOpen ? ' open' : ''}`}>
              <div className="cmd-h">
                Shell
                {d.commands.some((c) => c.live) ? <span className="n">{d.commands.filter((c) => c.live).length} running</span> : null}
              </div>
              {tapeRows(d.commands, tapeOpen).shown.map((c) => (
                <div key={c.key} className={`cmd${c.live ? ' live' : ''}${c.failed ? ' fail' : ''}${c.bg ? ' bg' : ''}`} style={{ opacity: c.live ? 1 : Math.max(0.35, 1 - (now - (c.bg && c.ms != null ? c.ts + c.ms : c.ts)) / 60_000) }}>
                  <span className={`mk dl-glyph ${c.live ? 'run' : (c.bg ? c.bg.status === 'failed' : c.failed) ? 'bad' : c.bg && c.bg.status !== 'completed' ? 'idle' : 'ok'}`} title={c.bg ? 'in the background' : undefined} />
                  <span className="cmd-t">{maskSecrets(c.text).text}</span>
                  <span className="ms">{c.live ? dur(now - c.ts) : c.ms != null ? dur(c.ms) : ''}</span>
                  {c.bg && c.live && c.bg.taskId ? <TaskTail sessionId={sessionId} taskId={c.bg.taskId} kick={`file:shell|${d.tasks.find((t) => t.key === c.key)?.program ?? ''}`} /> : null}
                </div>
              ))}
              {(() => {
                const t = tapeRows(d.commands, tapeOpen);
                return t.hidden || tapeOpen ? (
                  <button className="cmd-more" onClick={() => setTapeOpen(!tapeOpen)}>
                    {tapeOpen ? 'show fewer' : `+${t.hidden} more${t.hiddenRunning ? ` · ${t.hiddenRunning} running` : ''}`}
                  </button>
                ) : null;
              })()}
            </div>
          </div>
        ) : null}
        {/* the shell's programs, like a radiant's files: they orbit without labels; one whose command is executing
            holds still in front of the shell wearing a pill (its ring around the droplet), and focusing the shell
            lines them all up in a ring, each with its pill. Pills keep clear of each other on screen; hovering one
            lifts its droplet and shows what it's been doing. */}
        {d.resources
          .filter((r) => r.id === 'shell')
          .flatMap((r) =>
            r.files
              .filter((f) => f.program && (cam.focus === 'res:shell' || programRunning(f)))
              .map((f) => {
                // which way the pill opens: away from the shell's centre (the left half of the ring opens leftward)
                const focused = cam.focus === 'res:shell';
                const running = r.files.filter(programRunning);
                const left = focused ? Math.cos(Math.PI / 2 - (r.files.indexOf(f) / Math.max(1, r.files.length)) * Math.PI * 2) < -0.05 : running.indexOf(f) < (running.length - 1) / 2;
                return (
                <div
                  key={`chip|${f.name}`}
                  className={`lbl prog-lbl${left ? ' left' : ''}`}
                  data-declutter="prog"
                  data-dx="-9"
                  data-leadx="0"
                  data-side={left ? 'left' : 'right'}
                  ref={elRef(reg, `file:shell|${f.name}:lbl`)}
                  style={{ ['--c' as any]: f.program!.color }}
                >
                  <span className="lead" />
                  <div
                    data-box
                    className={`prog-chip prog-pill${f.program!.runningSince != null ? ' run' : ''}${f.program!.failed ? ' fail' : ''}`}
                    onMouseEnter={() => picker.hover({ kind: 'file', res: 'shell', name: f.name }, { quiet: true })}
                    onMouseLeave={() => picker.hover(null)}
                  >
                    <span className={`dl-glyph ${f.program!.runningSince != null ? 'run' : f.program!.failed ? 'bad' : 'ok'}`} />
                    {f.name} <span className="n">×{f.count}</span>
                    {f.program!.runningSince != null ? <span className="t">{dur(now - f.program!.runningSince)}</span> : null}
                    {f.program!.background ? <span className="bgb" title={`${f.program!.background} running in the background`}>⟳{f.program!.background > 1 ? f.program!.background : ''}</span> : null}
                    <div className="prog-card" dangerouslySetInnerHTML={{ __html: programCard(f.name, programDetails(sessionEvents(sessionId)).get(f.name)) }} />
                  </div>
                </div>
                );
              }),
          )}
        {/* the focused radiant's files, named, so they can be picked out */}
        {d.resources
          .filter((r) => cam.focus === `res:${r.id}`)
          .flatMap((r) =>
            // programs are already named in their chips list
            r.files.filter((f) => !f.program).map((f) => (
              <div key={`${r.id}|${f.name}`} className="lbl" ref={elRef(reg, `file:${r.id}|${f.name}:lbl`)}>
                <button
                  className="drop-l"
                  title={`${f.op} · touched ${f.count}× · ${f.changed ? 'click to see what changed' : 'click to search the transcript'}`}
                  onClick={() => openDroplet(sessionId, f.path, f.name, f.changed)}
                >
                  <i style={{ background: OP_COLOR[f.op] }} />
                  {f.name}
                  <span>{f.count > 1 ? `×${f.count}` : ''}</span>
                </button>
              </div>
            )),
          )}
        {shelf.length ? (
          <div className="lbl" ref={elRef(reg, 'shelf')}>
            {/* the dock: the newest explains as titled pills (a new one's pill appears as its card arrives) */}
            <div className="exp-dock">
              <div className="exp-l">
                Explains <span>{shelf.length}</span>
              </div>
              {[...shelf]
                .reverse()
                .slice(0, DOCK_PILLS)
                .map((x) => (
                  <button
                    key={x.id}
                    className={`exp-pill${Date.now() - x.ts < 3000 ? ' arriving' : ''}`}
                    title={`${x.title} · ${x.format === 'html' ? 'HTML' : 'markdown'} · click to open`}
                    onClick={() => {
                      const e = d.explains.find((y) => y.toolUseId === x.id);
                      const p = e ? explainFrom(e.event) : null;
                      if (p) useBrain.getState().setViewer(p);
                    }}
                  >
                    <span className="ic">
                      <Icon name="Presentation" size={11} />
                    </span>
                    <span className="t">{x.title}</span>
                    <em>{ago(x.ts, Date.now())}</em>
                  </button>
                ))}
              {shelf.length > DOCK_PILLS ? (
                <button className="exp-pill exp-more" title="All of this session's explains" onClick={() => useBrain.getState().setRightTab('explains')}>
                  +{shelf.length - DOCK_PILLS} more
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="lbl" ref={elRef(reg, 'anthropic:tag')}>
          <div className="anth-tag">
            anthropic
            <span>{waiting.length ? `${waiting.length} waiting` : lastReply.current && now - lastReply.current.at < 4000 ? lastReply.current.text : ''}</span>
          </div>
        </div>
        {d.agents.map((p) => {
          const a = p.a;
          const bubbleOn = p.bubble && now - p.bubble.at < 4600;
          const needs = alerted.has(a.agentId);
          return (
            <div key={a.agentId}>
              <div className="lbl" data-declutter="agents" data-side="below" ref={elRef(reg, `${a.agentId}:tag`)}>
                <div data-box className={`agent-tag${filter === a.agentId ? ' sel' : ''}${p.diedAt ? ' gone' : ''}`} onClick={() => setFilter(filter === a.agentId ? 'all' : a.agentId)}>
                  <div className="nm">{p.name}</div>
                  <div className={`st ${needs ? 'needs' : p.isMain && voiceNow ? `voice-${voiceNow}` : p.status.tone}${!needs && p.status.tone === 'run' && p.status.icon ? ' act' : ''}`}>
                    {needs ? (
                      <>
                        <Icon name="ShieldAlert" size={11} /> Waiting for you
                      </>
                    ) : p.isMain && voiceNow ? (
                      <>{voiceNow === 'listen' ? 'listening…' : 'speaking…'}</>
                    ) : (
                      <>
                        {p.status.icon ? <Icon name={p.status.icon.name} size={11} style={{ color: p.status.tone === 'run' ? FAM[p.status.icon.family].c : undefined }} /> : null} {maskSecrets(p.status.text).text}
                      </>
                    )}
                  </div>
                  {p.isMain && d.context ? (
                    <div className="ctx">
                      {d.context.used ? (
                        <>
                          <i className="ctx-bar" style={{ ['--p' as any]: `${Math.min(100, (d.context.used / d.context.max) * 100)}%`, ['--pc' as any]: d.context.used / d.context.max < 0.6 ? 'var(--work)' : d.context.used / d.context.max < 0.8 ? 'var(--think)' : 'var(--need)' }}>
                            <b />
                          </i>
                          {`${Math.round((d.context.used / d.context.max) * 100)}% · ${Math.round(d.context.used / 1000)}k / ${d.context.max / 1000}k`}
                        </>
                      ) : (
                        'context compacted'
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="lbl" ref={elRef(reg, `${a.agentId}:bubble`)}>
                <div
                  className={`bubble ${p.isMain ? 'main' : 'side'}${bubbleOn ? ' on' : ''}`}
                  title="Show in the transcript"
                  onClick={() => {
                    setFilter(a.agentId === 'main' ? 'all' : a.agentId);
                    useBrain.getState().setRightTab('transcript');
                  }}
                >
                  <div className="bubble-text">
                    <InlineMarkdown text={p.bubble?.text ?? ''} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        {d.overflow > 0 ? (
          <div className="lbl" ref={elRef(reg, 'overflow')}>
            <div className="overflow-tag">+{d.overflow} more agents</div>
          </div>
        ) : null}
        <div className="scene-tip" ref={tip} />
        <div className="scene-toast" ref={toastRef} />
      </div>
      {/* after the labels (same layer), so it covers them too while the scene warms up */}
      <SceneVeil gone={warmFor != null && warmFor === canvasKey.current} />
    </>
  );
}

/** The latest line a background command has written, refreshed every few seconds while it runs; new output makes
 * its program's droplet blink (`kick`: the droplet's key). */
function TaskTail({ sessionId, taskId, kick }: { sessionId: string; taskId: string; kick?: string }) {
  const [line, setLine] = useState('');
  useEffect(() => {
    let alive = true;
    let bytes = -1;
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/tail`);
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { lines?: string[]; bytes?: number };
        setLine(j.lines?.at(-1) ?? '');
        if (kick && bytes >= 0 && (j.bytes ?? 0) > bytes) dropletKick.set(kick, Date.now());
        bytes = j.bytes ?? 0;
      } catch {
        /* the next tick tries again */
      }
    };
    void tick();
    const h = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [sessionId, taskId, kick]);
  return line ? <div className="cmd-tail">{maskSecrets(line).text}</div> : null;
}

/** The hyperspace jump: a quiet button in the scene's corner (shown on hover), off while a jump runs. */
function WarpButton() {
  const phase = useWarp((w) => w.phase);
  return (
    <button className="warp-btn" title="Jump to hyperspace" aria-label="Jump to hyperspace" disabled={phase !== 'idle'} onClick={() => void jumpToHyperspace()}>
      <Icon name="Rocket" size={14} />
    </button>
  );
}
