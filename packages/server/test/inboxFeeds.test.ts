import { describe, expect, it } from 'vitest';
import type { CiPipeline, DeployBump, JiraEvent, MailHit } from '@cora/shared';
import { fromBump, fromCora, fromJira, fromMail, fromPipeline, fromWatch } from '../src/inboxFeeds';

const ev = (kind: JiraEvent['kind'], what: string): JiraEvent => ({ id: `ACME-7:${kind}`, kind, key: 'ACME-7', summary: 'Fix login', who: 'Dana Ruiz', what, at: 5, link: 'https://s/browse/ACME-7' });
const hit: MailHit = { id: 'm1', threadId: 't1', from: 'QA Team <qa@example.com>', to: 'me@example.com', subject: 'Re: staging login', at: 9, snippet: 'It works now', labels: [], unread: true, important: true, why: 'QA' };
const pipe = (status: CiPipeline['status']): CiPipeline => ({ key: 'g/svc#12', project: 'g/svc', id: 12, ref: 'feature/x', sha: 'abc', status, url: 'https://gitlab/g/svc/-/pipelines/12', createdAt: 1, startedAt: 1, finishedAt: 2, stages: [] });

describe('Inbox feeds', () => {
  it('Jira: one item per ticket; why follows the kind', () => {
    const a = fromJira(ev('mentioned', 'mentioned you: can you look?'));
    expect(a).toMatchObject({ source: 'jira', key: 'jira:ACME-7', title: 'ACME-7 · Fix login', why: 'you were mentioned', link: 'https://s/browse/ACME-7', entry: { id: 'ACME-7:mentioned', who: 'Dana Ruiz', text: 'mentioned you: can you look?', at: 5 } });
    expect(fromJira(ev('assigned', 'assigned you')).why).toBe('assigned to you');
    expect(fromJira(ev('watched', 'commented')).why).toBe('a ticket you watch');
  });

  it('email: one item per thread, the rule that caught it, and its message to read whole', () => {
    expect(fromMail(hit)).toMatchObject({ source: 'mail', key: 'mail:t1', title: 'QA Team · Re: staging login', why: 'your rule: QA', mailId: 'm1', entry: { id: 'm1', who: 'QA Team', text: 'It works now' } });
    expect(fromMail({ ...hit, why: 'important' }).why).toBe('Gmail marked it important');
    expect(fromWatch({ about: 'QA on the login bug' }, hit, 'Started a session in C:/code/app', 's1')).toMatchObject({ key: 'mail:t1', why: 'a watch: QA on the login bug', did: 'Started a session in C:/code/app', sessionId: 's1' });
  });

  it('pipelines: finished ones only, per branch, replacing; who follows it', () => {
    expect(fromPipeline(pipe('running'))).toBeNull();
    const f = fromPipeline(pipe('failed'), { id: 's1', name: 'svc work' })!;
    expect(f).toMatchObject({ source: 'gitlab', key: 'ci:g/svc@feature/x', title: 'svc · feature/x', state: 'failed', replace: true, sessionId: 's1', why: 'a pipeline svc work follows', link: 'https://gitlab/g/svc/-/pipelines/12', entry: { id: 'g/svc#12:failed', text: 'Pipeline #12 failed' } });
    expect(fromPipeline(pipe('success'))!.state).toBe('ok');
  });

  it('deploys and Cora', () => {
    const b: DeployBump = { id: 'b1', env: 'dev', project: 'g/svc', tag: '1.2.3', targets: [], state: 'failed', at: 1 };
    expect(fromBump(b, '[Deploys] dev bump to 1.2.3 failed')).toMatchObject({ source: 'gitlab', key: 'bump:b1', state: 'failed', replace: true, entry: { id: 'b1:failed', text: 'dev bump to 1.2.3 failed' } });
    expect(fromCora({ key: 'start:ACME-7', title: 'Started ACME-7 in app', text: 'On its own', why: 'assigned to you; Cora starts these', sessionId: 's2' })).toMatchObject({ source: 'cora', key: 'cora:start:ACME-7', sessionId: 's2' });
  });
});
