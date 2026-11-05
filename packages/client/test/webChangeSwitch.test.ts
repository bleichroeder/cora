import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { EMPTY_WEB, activate, deserialize, newTab, openUrl, serialize } from '../src/lib/webTabs';
import { QUIET_MS, onWebChanges, showsChange } from '../src/state/webChanges';
import { noteWebInput, webIdleFor } from '../src/lib/webInput';
import { useWeb } from '../src/state/web';
import { useBrain } from '../src/state/store';

/**
 * What a session changes on the web, in the background setting: shown when you're watching that session's browser and
 * haven't used it for 30s (it's working in front of you); otherwise loaded behind your tab, which says "new" until you
 * look at it.
 */

const change = (sessionId: string, n: number): BrainEvent =>
  ({ id: `w${n}`, seq: n, sessionId, agentId: 'main', ts: Date.now(), kind: 'tool', phase: 'end', icon: { name: 'x' }, source: 'hook', tool: { name: 'Bash', input: {}, summary: '', web: { what: 'merge', target: `!${n}`, url: `https://github.com/acme/app/pull/${n}` } } }) as unknown as BrainEvent;
const activeUrl = (sid: string) => {
  const w = useWeb.getState();
  return w.tabs[w.sessions[sid]?.active ?? '']?.url;
};

describe('a session’s web change: switched to, or new behind your tab', () => {
  afterEach(() => {
    useWeb.setState({ ...EMPTY_WEB });
    useBrain.setState({ focus: null, overview: false });
  });

  it('the rule: shown with "show"; in the background, only in front and left alone for 30s', () => {
    expect(showsChange('show', { front: false, idleMs: 0 })).toBe(true);
    expect(showsChange('tab', { front: true, idleMs: QUIET_MS })).toBe(true);
    // you're using it: it waits behind your tab
    expect(showsChange('tab', { front: true, idleMs: QUIET_MS - 1 })).toBe(false);
    // not in front (another session, the overview, Cora's window down): behind
    expect(showsChange('tab', { front: false, idleMs: Infinity })).toBe(false);
    expect(QUIET_MS).toBe(30_000);
    noteWebInput('s-x', 1000);
    expect(webIdleFor('s-x', 31_000)).toBe(30_000);
    expect(webIdleFor('never-used')).toBe(Infinity);
  });

  it("in front and quiet: it switches to the change; while you're using it, it waits behind, marked new; in another session's browser: behind", () => {
    const sid = 'sess-a1';
    useWeb.getState().open(sid, 'https://github.com/acme/app/issues/1');
    useBrain.setState({ focus: sid, overview: false });
    noteWebInput(sid, Date.now() - 40_000);
    onWebChanges([change(sid, 2)]);
    expect(activeUrl(sid)).toBe('https://github.com/acme/app/pull/2');
    // you click in its browser: the next change waits behind your tab, new
    noteWebInput(sid);
    onWebChanges([change(sid, 3)]);
    expect(activeUrl(sid)).toBe('https://github.com/acme/app/pull/2');
    const behind = Object.values(useWeb.getState().tabs).find((t) => t.url.endsWith('/pull/3'))!;
    expect(behind.fresh).toBe(true);
    // a session you aren't looking at: behind its own tab, new
    const other = 'sess-b2';
    useWeb.getState().open(other, 'https://github.com/acme/app/issues/9');
    noteWebInput(other, Date.now() - 60_000);
    onWebChanges([change(other, 4)]);
    expect(activeUrl(other)).toBe('https://github.com/acme/app/issues/9');
    expect(Object.values(useWeb.getState().tabs).find((t) => t.url.endsWith('/pull/4'))!.fresh).toBe(true);
  });

  it('"new" until you look at it: activating the tab clears it (kept over a reload until then); a tab you opened, or the first of a session, never says it', () => {
    let st = openUrl(EMPTY_WEB, 's', 'https://github.com/a');
    expect(Object.values(st.tabs)[0].fresh).toBeUndefined();
    st = newTab(st, 's', 'https://github.com/b', { background: true });
    const b = Object.values(st.tabs).find((t) => t.url.endsWith('/b'))!;
    expect(b.fresh).toBe(true);
    expect(deserialize(serialize(st)).tabs[b.id].fresh).toBe(true);
    st = activate(st, b.id);
    expect(st.tabs[b.id].fresh).toBeUndefined();
    // opened in front: not new
    expect(Object.values(newTab(st, 's', 'https://github.com/c').tabs).some((t) => t.url.endsWith('/c') && t.fresh)).toBe(false);
    // a session's first tab, even "in the background": it's the one shown, so not new
    expect(Object.values(newTab(EMPTY_WEB, 't', 'https://github.com/d', { background: true }).tabs)[0].fresh).toBeUndefined();
  });

  it("reading a page counts as using it: the desktop app's ping for a session's page (scrolling, keys, clicks in it) goes into the same 30s check", () => {
    const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toMatch(/if \(used\) return void \(t && noteWebInput\(t\.sessionId\)\);/);
    const main = readFileSync(join(__dirname, '../../desktop/src/browser.ts'), 'utf8');
    expect(main).toMatch(/wc\.on\('input-event'.*used: true/);
  });
});
