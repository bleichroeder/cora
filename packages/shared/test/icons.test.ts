import { describe, expect, it } from 'vitest';
import { FAM, iconFor, bashSubIcon, EVENT_ICON } from '../src/icons';

describe('iconFor', () => {
  it('maps core tools to icon + family', () => {
    expect(iconFor('Read')).toEqual({ name: 'FileText', family: 'look' });
    expect(iconFor('Edit')).toEqual({ name: 'FilePen', family: 'change' });
    expect(iconFor('WebFetch')).toEqual({ name: 'Globe', family: 'web' });
    expect(iconFor('Agent')).toEqual({ name: 'GitFork', family: 'delegate' });
    expect(iconFor('Task')).toEqual({ name: 'GitFork', family: 'delegate' });
    expect(iconFor('AskUserQuestion')).toEqual({ name: 'MessageCircleQuestion', family: 'human' });
  });

  it('maps any MCP tool to Plug/mcp', () => {
    expect(iconFor('mcp__ops__triage_incident')).toEqual({ name: 'Plug', family: 'mcp' });
  });

  it('falls back to Wrench/run for unknown tools', () => {
    expect(iconFor('SomethingNew')).toEqual({ name: 'Wrench', family: 'run' });
  });

  it('uses Bash sub-icons based on the command', () => {
    expect(iconFor('Bash', { command: 'git status' })).toEqual({ name: 'GitBranch', family: 'run' });
    expect(iconFor('PowerShell', { command: 'npm test' }).name).toBe('FlaskConical');
    expect(iconFor('Bash', { command: 'ls -la' }).name).toBe('SquareTerminal');
  });
});

describe('bashSubIcon', () => {
  it.each([
    ['git log --oneline', 'GitBranch'],
    ['cd repo && git push', 'GitBranch'],
    ['pytest -q', 'FlaskConical'],
    ['npx vitest run', 'FlaskConical'],
    ['cargo test', 'FlaskConical'],
    ['npm install react', 'Package'],
    ['npm i -D vite', 'Package'],
    ['pip install requests', 'Package'],
    ['kubectl get pods', 'Container'],
    ['docker build .', 'Container'],
    ['helm list', 'Container'],
    ['echo hi', 'SquareTerminal'],
  ])('%s → %s', (cmd, icon) => {
    expect(bashSubIcon(cmd)).toBe(icon);
  });
});

describe('registry tables', () => {
  it('has a colour for every family', () => {
    for (const f of ['look', 'change', 'run', 'web', 'delegate', 'mcp', 'plan', 'human', 'mind'] as const) {
      expect(FAM[f].c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
  it('has icons for the non-tool events', () => {
    expect(EVENT_ICON.think).toEqual({ name: 'Brain', family: 'mind' });
    expect(EVENT_ICON.permission.family).toBe('human');
  });
});
