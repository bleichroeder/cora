import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JiraAlertEvent } from '@cora/shared';
import { alertTitle, applyJira, spokenJira, useJiraWatch } from '../src/state/jiraWatch';

const e = (kind: JiraAlertEvent['kind'], level: JiraAlertEvent['level'], key = 'ACME-5301'): JiraAlertEvent => ({ id: `${key}:${kind}`, kind, level, key, summary: 'Saved search dedupe fails on reload', who: 'Dana Scully', what: kind === 'assigned' ? 'assigned you' : 'mentioned you: check this', at: Date.now(), link: `https://s/browse/${key}` });

beforeEach(() => useJiraWatch.setState({ alerts: [], unseen: {}, recent: [], status: { state: 'ok' } }));

describe('Jira alerts', () => {
  it('titles and spoken lines, one or several', () => {
    expect(alertTitle([e('assigned', 'say')])).toBe('Dana Scully assigned you ACME-5301');
    expect(alertTitle([e('assigned', 'say'), e('mentioned', 'say', 'ACME-9')])).toBe('2 Jira updates');
    expect(alertTitle([e('mentioned', 'say')])).toBe('Dana Scully mentioned you on ACME-5301');
    expect(alertTitle([{ ...e('status', 'notify'), what: 'moved it to QA' }])).toBe('Dana Scully moved ACME-5301 to QA');
    expect(spokenJira([e('assigned', 'say')])).toBe('Dana Scully assigned you ACME 5301: Saved search dedupe fails on reload.');
    expect(spokenJira([e('assigned', 'say'), e('mentioned', 'say', 'ACME-9'), e('mentioned', 'say', 'ACME-8')])).toBe('Three Jira updates: two mentions and one assignment.');
    expect(spokenJira([], 'While Cora was closed: 1 assigned to you, 3 mentions')).toBe('While Cora was closed: 1 assigned to you, 3 mentions.');
  });

  it('quiet events make no card; notify and say do (one card for several); mentions mark their ticket', () => {
    applyJira({ t: 'jira', status: { state: 'ok' }, events: [e('assigned', 'quiet')] });
    expect(useJiraWatch.getState().alerts).toEqual([]);
    applyJira({ t: 'jira', status: { state: 'ok' }, events: [e('assigned', 'notify'), e('mentioned', 'say', 'ACME-9')] });
    const [card] = useJiraWatch.getState().alerts;
    expect(card.events.map((x) => x.key)).toEqual(['ACME-5301', 'ACME-9']);
    expect(useJiraWatch.getState().unseen['ACME-9']).toBeTypeOf('number');
  });
});
