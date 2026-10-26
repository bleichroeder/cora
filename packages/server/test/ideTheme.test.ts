import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { coraTheme, prepareIde } from '../src/ideTheme';

describe("the IDE panel's look", () => {
  it('a Cora theme in your Cora colour', () => {
    const t = coraTheme('#22d3ee');
    expect(t.name).toBe('Cora');
    expect(t.colors['editor.background']).toBe('#06090f');
    expect(t.colors['editorCursor.foreground']).toBe('#22d3ee');
    expect(t.colors['activityBar.activeBorder']).toBe('#22d3ee');
    // a colour it can't read: Cora's pink
    expect(coraTheme('nope').colors['editorCursor.foreground']).toBe('#f472b6');
  });

  it("its extension, and its settings: Cora's theme always, your own settings kept (comments and all read)", () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cora-ide-')), 'server');
    mkdirSync(join(dir, 'data', 'Machine'), { recursive: true });
    writeFileSync(join(dir, 'data', 'Machine', 'settings.json'), '{\n  // mine\n  "editor.fontSize": 15,\n  "workbench.colorTheme": "Monokai",\n}\n');
    prepareIde(dir, '#22d3ee');
    const ext = join(dir, 'extensions', 'cora.cora-0.1.0');
    const pkg = JSON.parse(readFileSync(join(ext, 'package.json'), 'utf8'));
    expect(pkg.contributes.themes[0]).toMatchObject({ label: 'Cora', path: './themes/cora.json' });
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(true);
    expect(JSON.parse(readFileSync(join(ext, 'themes', 'cora.json'), 'utf8')).colors['editorCursor.foreground']).toBe('#22d3ee');
    expect(readFileSync(join(ext, 'extension.js'), 'utf8')).toContain("'security.workspace.trust.enabled': false".replace(/'/g, '"'));
    const settings = JSON.parse(readFileSync(join(dir, 'data', 'Machine', 'settings.json'), 'utf8'));
    expect(settings).toMatchObject({ 'editor.fontSize': 15, 'workbench.colorTheme': 'Cora', 'editor.minimap.enabled': false });
  });
});
