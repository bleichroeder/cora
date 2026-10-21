import { describe, expect, it } from 'vitest';
import { EMPTY_WEB, activate, closeTab, cycle, deserialize, navigate, newTab, openUrl, serialize, setShown, update, type WebState } from '../src/lib/webTabs';

const urls = (st: WebState, sid: string) => (st.sessions[sid]?.tabs ?? []).map((id) => st.tabs[id].url);
const active = (st: WebState, sid: string) => st.tabs[st.sessions[sid]?.active ?? '']?.url;

describe('browser tabs per session', () => {
  it('each session keeps its own tabs; a link reuses its tab or opens a new one', () => {
    let st = openUrl(EMPTY_WEB, 'a', 'https://gitlab/x/-/pipelines');
    st = openUrl(st, 'a', 'https://jira/browse/T-1');
    st = openUrl(st, 'b', 'https://jira/browse/T-2');
    expect(urls(st, 'a')).toEqual(['https://gitlab/x/-/pipelines', 'https://jira/browse/T-1']);
    expect(urls(st, 'b')).toEqual(['https://jira/browse/T-2']);
    st = openUrl(st, 'a', 'https://gitlab/x/-/pipelines#top');
    expect(urls(st, 'a')).toHaveLength(2);
    expect(active(st, 'a')).toBe('https://gitlab/x/-/pipelines');
    expect(st.sessions.a.shown).toBe(true);
  });

  it('a blank active tab takes the link; background tabs open beside without switching', () => {
    let st = setShown(EMPTY_WEB, 'a', true);
    expect(urls(st, 'a')).toEqual(['']);
    st = openUrl(st, 'a', 'https://one');
    expect(urls(st, 'a')).toEqual(['https://one']);
    st = newTab(st, 'a', 'https://two', { background: true });
    expect(urls(st, 'a')).toEqual(['https://one', 'https://two']);
    expect(active(st, 'a')).toBe('https://one');
  });

  it('closing hands over to the right, then the left; the last close hides the browser', () => {
    let st = openUrl(openUrl(openUrl(EMPTY_WEB, 'a', 'https://1'), 'a', 'https://2'), 'a', 'https://3');
    const [t1, t2, t3] = st.sessions.a.tabs;
    st = closeTab(activate(st, t2), t2);
    expect(active(st, 'a')).toBe('https://3');
    st = closeTab(st, t3);
    expect(active(st, 'a')).toBe('https://1');
    st = closeTab(st, t1);
    expect(st.sessions.a).toEqual({ tabs: [], active: null, shown: false });
    expect(st.order).toEqual([]);
  });

  it('navigation asked of a tab bumps it; what the page reports does not', () => {
    let st = openUrl(EMPTY_WEB, 'a', 'https://1');
    const id = st.sessions.a.active!;
    st = navigate(st, id, 'https://2');
    expect(st.tabs[id]).toMatchObject({ url: 'https://2', nav: 1 });
    st = update(st, id, { url: 'https://2/redirected', title: 'Two' });
    expect(st.tabs[id]).toMatchObject({ url: 'https://2/redirected', title: 'Two', nav: 1 });
    expect(update(st, id, { title: 'Two' })).toBe(st);
  });

  it('cycles tabs and survives a reload', () => {
    let st = openUrl(openUrl(EMPTY_WEB, 'a', 'https://1'), 'a', 'https://2');
    st = cycle(st, 'a', 1);
    expect(active(st, 'a')).toBe('https://1');
    const back = deserialize(serialize(st));
    expect(urls(back, 'a')).toEqual(['https://1', 'https://2']);
    expect(active(back, 'a')).toBe('https://1');
    expect(back.sessions.a.shown).toBe(true);
    expect(deserialize('garbage')).toEqual(EMPTY_WEB);
  });
});

describe('opening a page that is already open', () => {
  it('switches to its tab; asked to reload, it loads it again', () => {
    let st = openUrl(openUrl(EMPTY_WEB, 'a', 'https://jira/browse/T-1'), 'a', 'https://other');
    const tab = st.sessions.a.tabs[0];
    const nav = st.tabs[tab].nav;
    const plain = openUrl(st, 'a', 'https://jira/browse/T-1');
    expect(active(plain, 'a')).toBe('https://jira/browse/T-1');
    expect(plain.tabs[tab].nav).toBe(nav);
    st = openUrl(st, 'a', 'https://jira/browse/T-1', { reload: true });
    expect(st.tabs[tab].nav).toBe(nav + 1);
    expect(st.sessions.a.tabs).toHaveLength(2);
  });
});

describe('browser width', () => {
  it('keeps a share of the scene area between a quarter and all of it, snapping to full near the edge', async () => {
    const { clampSplit } = await import('../src/lib/webTabs');
    expect(clampSplit(0.1)).toBe(0.25);
    expect(clampSplit(0.5)).toBe(0.5);
    expect(clampSplit(0.98)).toBe(1);
    const st = { ...openUrl(EMPTY_WEB, 'a', 'https://1'), split: 0.4 };
    expect(deserialize(serialize(st)).split).toBe(0.4);
    expect(deserialize(serialize(EMPTY_WEB)).split).toBe(0.6);
  });
});
