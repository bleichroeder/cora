import { describe, expect, it } from 'vitest';
import { connectedMcp } from '../src/mcpServers';

describe("the user's connected MCP servers", () => {
  it('names only, from ~/.claude.json and settings.json; missing or broken files give nothing', () => {
    const files: Record<string, string> = {
      a: JSON.stringify({ mcpServers: { atlassian: { command: 'npx', env: { TOKEN: 'secret' } }, GitLab: { type: 'http' } } }),
      b: JSON.stringify({ mcpServers: { playwright: {}, 'bad name!': {} } }),
    };
    const read = (p: string) => {
      if (!(p in files)) throw new Error('missing');
      return files[p];
    };
    expect(connectedMcp({ claudeJson: 'a', settingsJson: 'b' }, read)).toEqual(['GitLab', 'atlassian', 'playwright']);
    expect(connectedMcp({ claudeJson: 'x', settingsJson: 'y' }, read)).toEqual([]);
    expect(connectedMcp({ claudeJson: 'a', settingsJson: 'y' }, () => 'not json')).toEqual([]);
  });
});
