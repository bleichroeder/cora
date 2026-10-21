import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { useBrain } from '../src/state/store';

const session = (id: string, state: SessionInfo['state']): SessionInfo =>
  ({ id, cwd: 'C:\\code\\x', project: 'x', title: '', state, startedAt: 0, lastTs: 0, cliVersion: '', transcriptPath: '', needsYou: 0 }) as SessionInfo;

describe('a session that finished while you were elsewhere', () => {
  it('is news until you open it', () => {
    const st = useBrain.getState();
    st.upsertSession(session('a', 'working'));
    st.upsertSession(session('b', 'working'));
    st.setFocus('a');
    // b finishes while you're on a
    st.upsertSession(session('b', 'idle'));
    expect(useBrain.getState().unseen.b).toBeTypeOf('number');
    // opening it: seen
    useBrain.getState().setFocus('b');
    expect(useBrain.getState().unseen.b).toBeUndefined();
  });

  it('only a turn ending counts, and working again (or ending) takes it away', () => {
    const st = useBrain.getState();
    st.setFocus('a');
    // idle to idle: nothing new
    st.upsertSession(session('c', 'idle'));
    st.upsertSession(session('c', 'idle'));
    expect(useBrain.getState().unseen.c).toBeUndefined();
    // thinking to idle: news; then working again: not any more
    st.upsertSession(session('c', 'thinking'));
    st.upsertSession(session('c', 'idle'));
    expect(useBrain.getState().unseen.c).toBeTypeOf('number');
    st.upsertSession(session('c', 'working'));
    expect(useBrain.getState().unseen.c).toBeUndefined();
  });

  it('the one you have open counts too while you are away from the window, and markSeen clears it', () => {
    const st = useBrain.getState();
    st.upsertSession(session('d', 'working'));
    st.setFocus('d');
    // no window here, so you're "away": it's news even though it's open
    st.upsertSession(session('d', 'idle'));
    expect(useBrain.getState().unseen.d).toBeTypeOf('number');
    useBrain.getState().markSeen('d');
    expect(useBrain.getState().unseen.d).toBeUndefined();
  });
});
