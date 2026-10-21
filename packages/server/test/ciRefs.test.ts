import { describe, expect, it } from 'vitest';
import { cleanTrace, commandRefs, gitlabUrls, ownedRefs, parseRemote, parseRemotes, pickProject, pushedRefs, splitUpstream, traceTail } from '../src/ciRefs';

describe('git remotes', () => {
  it('reads https, ssh and scp-like remotes', () => {
    expect(parseRemote('https://gitlab.com/acme/internal/orion/orion-services.git')).toEqual({ host: 'gitlab.com', project: 'acme/internal/orion/orion-services' });
    expect(parseRemote('https://oauth2:tok@gitlab.com/a/b')).toEqual({ host: 'gitlab.com', project: 'a/b' });
    expect(parseRemote('git@gitlab.com:group/sub/proj.git')).toEqual({ host: 'gitlab.com', project: 'group/sub/proj' });
    expect(parseRemote('ssh://git@gitlab.com:22/group/proj.git/')).toEqual({ host: 'gitlab.com', project: 'group/proj' });
    expect(parseRemote('https://github.com/x/y.git')).toEqual({ host: 'github.com', project: 'x/y' });
    expect(parseRemote('C:\\repos\\local')).toBeNull();
    expect(parseRemote('https://gitlab.com/justone')).toBeNull();
  });

  it("picks the upstream's remote, else origin, else the first GitLab one", () => {
    const remotes = parseRemotes(
      'glab-base\thttps://gitlab.com/t/other.git (fetch)\nglab-base\thttps://gitlab.com/t/other.git (push)\norigin\thttps://gitlab.com/t/mine.git (fetch)\norigin\thttps://gitlab.com/t/mine.git (push)\n',
    );
    expect(remotes).toEqual({ 'glab-base': 'https://gitlab.com/t/other.git', origin: 'https://gitlab.com/t/mine.git' });
    expect(pickProject(remotes)).toBe('t/mine');
    expect(pickProject(remotes, 'glab-base')).toBe('t/other');
    expect(pickProject({ origin: 'https://github.com/a/b', up: 'git@gitlab.com:c/d.git' })).toBe('c/d');
    // tracking a GitHub remote: not a GitLab pipeline
    expect(pickProject({ origin: 'https://github.com/a/b', up: 'git@gitlab.com:c/d.git' }, 'origin')).toBeNull();
  });

  it('splits an upstream on a known remote name', () => {
    expect(splitUpstream('origin/feature/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feature/x' });
    expect(splitUpstream('team/fork/main', ['team', 'team/fork'])).toEqual({ remote: 'team/fork', branch: 'main' });
    expect(splitUpstream('nope/x', ['origin'])).toBeNull();
  });
});

describe('links in text', () => {
  it('finds pipelines, jobs and merge requests on gitlab.com only', () => {
    const t = `remote: View merge request for fix:
remote:   https://gitlab.com/acme/internal/orion/orion-services/-/merge_requests/2026
remote: To create a merge request, visit https://gitlab.com/a/b/-/merge_requests/new?merge_request%5Bsource_branch%5D=x
Created pipeline (id: 9), weburl: https://gitlab.com/a/b/-/pipelines/2945540001
https://gitlab.com/a/b/-/jobs/17161636766 https://gitlab.example.com/a/b/-/pipelines/5 https://gitlab.com/a/b/-/pipelines/2945540001`;
    expect(gitlabUrls(t)).toEqual([
      { project: 'acme/internal/orion/orion-services', kind: 'mr', id: 2026 },
      { project: 'a/b', kind: 'pipeline', id: 2945540001 },
      { project: 'a/b', kind: 'job', id: 17161636766 },
    ]);
  });
});

describe('commands', () => {
  it('git push: the current branch, named branches, never a delete', () => {
    expect(pushedRefs([])).toEqual([]);
    expect(pushedRefs(['-u', 'origin', 'HEAD'])).toEqual(['HEAD']);
    expect(pushedRefs(['origin', 'feat/a', '+local:remote', 'refs/heads/x'])).toEqual(['feat/a', 'remote', 'x']);
    expect(pushedRefs(['-o', 'ci.skip', 'origin'])).toEqual([]);
    expect(pushedRefs(['origin', '--delete', 'old'])).toBeNull();
    expect(commandRefs('git add . && git commit -m "x" && git push').kick).toBe('push');
    expect(commandRefs('git -C C:/repo push -u origin HEAD').kick).toBe('push');
    const r = commandRefs('git push origin feat/a');
    expect(r.kick).toBeNull();
    expect(r.branches).toEqual([{ project: null, ref: 'feat/a', why: 'push' }]);
    expect(commandRefs('git push origin :gone')).toMatchObject({ kick: null, branches: [] });
    expect(commandRefs('git status').kick).toBeNull();
  });

  it('glab ci and mr commands', () => {
    expect(commandRefs('glab ci status').kick).toBe('command');
    expect(commandRefs('glab ci status --live --branch fix/hooks').branches).toEqual([{ project: null, ref: 'fix/hooks', why: 'command' }]);
    expect(commandRefs('glab ci run -b main').branches).toEqual([{ project: null, ref: 'main', why: 'push' }]);
    expect(commandRefs('glab ci run').kick).toBe('push');
    expect(commandRefs('glab ci view main').branches).toEqual([{ project: null, ref: 'main', why: 'command' }]);
    expect(commandRefs('glab ci get -p 123').pipelines).toEqual([{ project: null, id: 123, why: 'command' }]);
    expect(commandRefs('glab ci trace 456 -R acme/x/y').jobs).toEqual([{ project: 'acme/x/y', id: 456, why: 'command' }]);
    expect(commandRefs('glab mr create --fill -b main').kick).toBe('push');
    expect(commandRefs('glab mr create -s feat -b main').branches).toEqual([{ project: null, ref: 'feat', why: 'push' }]);
    expect(commandRefs('"C:\\Users\\D\\glab.exe" ci status').kick).toBe('command');
    expect(commandRefs("glab api 'projects/a%2Fb/pipelines/77/jobs?per_page=100'").pipelines).toEqual([{ project: 'a/b', id: 77, why: 'command' }]);
    // a project id, not a path: nothing to go on
    expect(commandRefs('glab api projects/41617291/pipelines/77').pipelines).toEqual([]);
  });

  it('links a command prints are followed; a push makes them its own', () => {
    const out = 'Created pipeline (id: 1), status: created, ref: main, weburl: https://gitlab.com/a/b/-/pipelines/1';
    expect(commandRefs('glab ci list', out).pipelines).toEqual([{ project: 'a/b', id: 1, why: 'url' }]);
    expect(commandRefs('git push', 'remote:   https://gitlab.com/a/b/-/merge_requests/3').mrs).toEqual([{ project: 'a/b', id: 3, why: 'push' }]);
  });
});

describe('job logs', () => {
  it('drops section markers, runner timestamps and colours', () => {
    const raw =
      '2026-10-13T03:00:51.110800Z 01E ERROR: failed to build\n' +
      '2026-10-13T03:00:51.270502Z 00O section_end:1791860451:step_script\r\x1b[0K\n' +
      '2026-10-13T03:00:52.620288Z 00O \x1b[31;1mERROR: Job failed: execution took longer than 1h0m0s seconds\x1b[0;m\n' +
      'plain line\r\nprogress 10%\rprogress 100%\n';
    expect(cleanTrace(raw)).toEqual(['ERROR: failed to build', '', 'ERROR: Job failed: execution took longer than 1h0m0s seconds', 'plain line', 'progress 100%', '']);
    expect(traceTail(raw, 2)).toEqual(['plain line', 'progress 100%']);
  });
});

describe('more commands that name pipelines', () => {
  it("glab mr view/merge/checks follow that MR's pipeline; glab api pipelines?ref= follows that ref", () => {
    expect(commandRefs('glab mr view 2071 -F json').mrs).toEqual([{ project: null, id: 2071, why: 'command' }]);
    expect(commandRefs('glab mr merge 2071 --auto-merge --yes').mrs).toEqual([{ project: null, id: 2071, why: 'command' }]);
    expect(commandRefs('glab mr checks').kick).toBe('command');
    const api = commandRefs('glab api "projects/acme%2Finternal%2Forion%2Forion-services/pipelines?ref=2.10.0-dev21&per_page=1"');
    expect(api.branches).toEqual([{ project: 'acme/internal/orion/orion-services', ref: '2.10.0-dev21', why: 'command' }]);
    // a tag push follows the tag's pipeline
    expect(commandRefs('git tag 2.10.0-dev21 b781d56e && git push origin 2.10.0-dev21').branches).toEqual([{ project: null, ref: '2.10.0-dev21', why: 'push' }]);
  });
});

describe('which branches a command works on', () => {
  it('a commit: the branch git names (not a hook\'s [INFO] line); without it, the current one', () => {
    expect(ownedRefs('git add -A && git commit -m "x"', '[INFO] lint ok\n[feature/ACME-5234 1a2b3c4] x\n 2 files changed')).toEqual({ branches: ['feature/ACME-5234'], current: false });
    expect(ownedRefs('git commit -m first', '[main (root-commit) 1a2b3c4] first')).toEqual({ branches: ['main'], current: false });
    expect(ownedRefs('git commit -m x', '')).toEqual({ branches: [], current: true });
    expect(ownedRefs('git commit --dry-run', '')).toEqual({ branches: [], current: false });
  });

  it('a push: named, or as git reports it; deleting one is not working on it', () => {
    expect(ownedRefs('git push origin feat')).toEqual({ branches: ['feat'], current: false });
    expect(ownedRefs('git push -u origin HEAD', ' * [new branch]      HEAD -> fix/dupes\nbranch set up')).toEqual({ branches: ['fix/dupes'], current: false });
    expect(ownedRefs('git push', '   1a2b3c4..5d6e7f8  feat -> feat')).toEqual({ branches: ['feat'], current: false });
    expect(ownedRefs('git push', '')).toEqual({ branches: [], current: true });
    expect(ownedRefs('git push origin --delete old')).toEqual({ branches: [], current: false });
  });

  it('a new branch, an MR, a pipeline run; not looking, and not another repo', () => {
    expect(ownedRefs('git checkout -b fix/x')).toEqual({ branches: ['fix/x'], current: false });
    expect(ownedRefs('git switch -c fix/y')).toEqual({ branches: ['fix/y'], current: false });
    expect(ownedRefs('git worktree add -b fix/z ../z')).toEqual({ branches: ['fix/z'], current: false });
    expect(ownedRefs('glab mr create --fill')).toEqual({ branches: [], current: true });
    expect(ownedRefs('glab ci run -b feat')).toEqual({ branches: ['feat'], current: false });
    expect(ownedRefs('git checkout main && git status && glab ci status')).toEqual({ branches: [], current: false });
    expect(ownedRefs('glab mr create -R other/repo --fill')).toEqual({ branches: [], current: false });
  });
});
