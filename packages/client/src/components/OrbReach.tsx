import { useEffect, useRef, useState, type RefObject } from 'react';
import { sessionEvents, useBrain } from '../state/store';
import { useOrch } from '../state/orchestrator';
import { sessionColor } from '../lib/format';
import { coraLinks, nextTrip, sameLinks, settleTrips, useCoraLinks, type LinkDir } from '../lib/coraLinks';

/** Cora's orb (its card in the nav), and the open session's (its card above the transcript), when both are showing. */
const CORA_ORB = '.cora-bridge.orb-mode .cb-lens .cora-orb';
const SESSION_ORB = '.scard .sc-orb .cora-orb';

/**
 * Keeps the links current (see lib/coraLinks): from Cora's session's events as they come, and every half second while
 * one is live (they end with time). Mounted once, with Cora's card. The arms themselves are the orbs' own (CoraOrb).
 */
export function useCoraLinksDriver() {
  const agent = useOrch((s) => (s.status?.enabled ? s.status.sessionId : null));
  const version = useBrain((s) => (agent ? s.versions[agent] : 0));
  const focus = useBrain((s) => s.focus);
  const [tick, setTick] = useState(0);
  const prev = useRef<{ armed: string | null; dir?: LinkDir }>({ armed: null });
  useEffect(() => {
    const st = useCoraLinks.getState();
    const busy = new Set<string>();
    const links = agent ? coraLinks(sessionEvents(agent), Object.keys(useBrain.getState().sessions), Date.now(), busy) : {};
    // the open session reaches through the cards when both orbs are showing; others show it on their row / Cora's orb
    const armed = focus && links[focus] && document.querySelector(CORA_ORB) && document.querySelector(SESSION_ORB) ? focus : null;
    if (!sameLinks(st.links, links) || st.armed !== armed) useCoraLinks.setState({ links, armed });
    // the open session's link starts (or turns round): a messenger goes
    const now = Date.now();
    // Cora's messenger lets go when its call is done; then the next one goes
    const settled = settleTrips(st.trips, busy, now);
    const trip = nextTrip(prev.current, armed, armed ? links[armed] : undefined, settled, now);
    if (trip || settled !== st.trips) useCoraLinks.setState({ trips: trip ? [...settled, trip] : settled });
    prev.current = { armed, dir: armed ? links[armed] : undefined };
    if (!Object.keys(links).length && !useCoraLinks.getState().trips.length) return;
    const t = setTimeout(() => setTick((n) => n + 1), 500);
    return () => clearTimeout(t);
  }, [agent, version, focus, tick]);
}

/** The ring around Cora's orb in the colour of a session (not open) that's reaching Cora; none: nobody is. */
export function useReachHalo(): string | null {
  const links = useCoraLinks((s) => s.links);
  const armed = useCoraLinks((s) => s.armed);
  const sessions = useBrain((s) => s.sessions);
  const sid = Object.keys(links).find((k) => links[k] === 'in' && k !== armed);
  return sid && sessions[sid] ? sessionColor(sessions[sid]) : null;
}

/** An element's width, kept current (an orb's canvas is its card's width, so its arm can reach the card's edge). */
export function useWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [w, setW] = useState<number>();
  const seen = useRef<{ el: HTMLElement | null; ro: ResizeObserver | null }>({ el: null, ro: null });
  // (the element can come later: a card that was off)
  useEffect(() => {
    const el = ref.current;
    if (el === seen.current.el) return;
    seen.current.ro?.disconnect();
    const ro = el ? new ResizeObserver(() => setW(Math.round(el.clientWidth))) : null;
    if (el && ro) ro.observe(el);
    seen.current = { el, ro };
  });
  useEffect(() => () => seen.current.ro?.disconnect(), []);
  return w;
}
