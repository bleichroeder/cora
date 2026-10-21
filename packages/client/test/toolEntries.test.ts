import { describe, expect, it } from 'vitest';
import { cleanTag, toolEntries, type ToolDef } from '../src/lib/tools';

const t = (id: string, folder?: string): ToolDef => ({ id, name: id, url: `https://${id}.example.com`, ...(folder ? { folder } : {}) });

describe('tools in the nav', () => {
  it('a folder sits where its first tool is; its tools keep their places (their Ctrl+n)', () => {
    const e = toolEntries([t('slack'), t('rprod', 'Rancher'), t('jira'), t('rstg', 'rancher '), t('rdev', 'Rancher')]);
    expect(e.map((x) => (x.kind === 'tool' ? `${x.t.id}@${x.n}` : `${x.name}[${x.tools.map((y) => `${y.t.id}@${y.n}`).join(',')}]`))).toEqual([
      'slack@0',
      'Rancher[rprod@1,rstg@3,rdev@4]',
      'jira@2',
    ]);
  });
  it('tags are up to 3 letters or digits, upper case', () => {
    expect(cleanTag('prd')).toBe('PRD');
    expect(cleanTag('st-g!')).toBe('STG');
    expect(cleanTag('devel')).toBe('DEV');
  });
});
