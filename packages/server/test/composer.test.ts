import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminalInput, MAX_INPUT } from '../src/input';
import { frontmatter, listCommands } from '../src/commands';
import { attachmentsDir, pruneAttachments, safeName, saveAttachment } from '../src/attachments';
import { loadConfig } from '../src/config';
import { choiceOpen } from '../src/screen';
import { startServer, type Running } from '../src/server';

describe('terminalInput', () => {
  it('types one line as is, without control characters, tabs as spaces', () => {
    expect(terminalInput('  /jira ABC-12 ')).toEqual({ data: '/jira ABC-12', paste: false });
    expect(terminalInput('a\tb\x07c\x1b[201~d')).toEqual({ data: 'a  bc[201~d', paste: false });
  });
  it('sends several lines as one bracketed paste, line breaks as CR', () => {
    const r = terminalInput('fix this:\r\n\n  if (x) {\n\treturn 1;\n  }\n\n');
    expect(r).toEqual({ data: '\x1b[200~fix this:\r\r  if (x) {\r\treturn 1;\r  }\x1b[201~', paste: true });
  });
  it('never lets the text end the paste or send keys of its own', () => {
    const r = terminalInput('a\n\x1b[201~\x03\x1b[A\x9b201~b');
    expect(r).toEqual({ data: '\x1b[200~a\r[201~[A201~b\x1b[201~', paste: true });
  });
  it('keeps the first line indentation but drops blank lines around the text', () => {
    expect(terminalInput('\n\n    x = 1\n    y = 2\n')).toEqual({ data: '\x1b[200~    x = 1\r    y = 2\x1b[201~', paste: true });
  });
  it('rejects empty and oversized text', () => {
    expect(terminalInput(' \n\t\x1b ')).toHaveProperty('error');
    expect(terminalInput('x'.repeat(MAX_INPUT + 1))).toHaveProperty('error');
  });
});

describe('choiceOpen', () => {
  const RULE = '─'.repeat(60);
  it('sees a permission prompt or a question, not the prompt line or old output', () => {
    expect(choiceOpen(['output', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'])).toBe(false);
    // your own text in the prompt, even numbered
    expect(choiceOpen(['output', RULE, '❯ 1. fix the bug', '  2. then test', RULE, '  ? for shortcuts'])).toBe(false);
    expect(choiceOpen(['● Bash(rm -rf build)', RULE, ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No, and tell Claude what to do differently (esc)', ''])).toBe(true);
    expect(choiceOpen([' Which approach?', ' ❯ 1. Tubes', '   2. Lines', '', ''])).toBe(true);
    // drawn in a box
    expect(choiceOpen(['╭────────╮', '│ Do you want to proceed?', '│ ❯ 1. Yes', '│   2. No', '╰────────╯'])).toBe(true);
    // Claude Code's real idle screen (captured from 2.1.281 in a ConPTY)
    expect(choiceOpen([' ▐▛███▛█   Claude Code v2.1.281', '', '─'.repeat(100), '❯ Try "how does <filepath> work?"', '─'.repeat(100), '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'])).toBe(false);
    // an old menu up in the output, the input box below it
    expect(choiceOpen(['❯ 1. Yes', ...Array(14).fill('text'), RULE, '❯ ', RULE, 'status'])).toBe(false);
    expect(choiceOpen(['', ''])).toBe(false);
  });
});

describe('slash commands', () => {
  it('reads the frontmatter fields', () => {
    expect(frontmatter('---\nname: jira\ndescription: "Fetch an issue"\nargument-hint: "<key>"\n---\nbody')).toEqual({ name: 'jira', description: 'Fetch an issue', 'argument-hint': '<key>' });
    expect(frontmatter('---\r\ndescription: >\r\n  folded\r\n  text\r\nother: x\r\n---\r\n')).toEqual({ description: 'folded text', other: 'x' });
    expect(frontmatter('no frontmatter')).toEqual({});
  });

  it('lists project, user and enabled plugin skills and commands; a project one wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cora-cmds-'));
    const claude = join(root, 'home', '.claude');
    const cwd = join(root, 'proj');
    const put = (p: string, s: string) => (mkdirSync(join(p, '..'), { recursive: true }), writeFileSync(p, s));
    put(join(claude, 'skills', 'jira', 'SKILL.md'), '---\nname: jira\ndescription: Fetch a Jira issue\nargument-hint: "<issue-key or URL>"\n---\n');
    put(join(claude, 'skills', 'hidden', 'SKILL.md'), '---\nuser-invocable: false\ndescription: no\n---\n');
    put(join(claude, 'commands', 'vine.md'), '# Review a batch\n\nmore');
    put(join(claude, 'commands', 'group', 'deep.md'), '---\ndescription: nested\n---\n');
    put(join(cwd, '.claude', 'commands', 'vine.md'), '---\ndescription: project vine\n---\n');
    const plugin = join(root, 'plugins', 'sp');
    put(join(plugin, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: Ideas first\n---\n');
    put(join(root, 'plugins', 'off', 'commands', 'nope.md'), 'x');
    put(join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@m': true, 'off@m': false } }));
    put(join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'superpowers@m': [{ installPath: plugin }], 'off@m': [{ installPath: join(root, 'plugins', 'off') }] } }));

    const list = await listCommands({ claudeDir: claude, cwd });
    expect(list.map((c) => c.name)).toEqual(['deep', 'jira', 'superpowers:brainstorming', 'vine']);
    expect(list.find((c) => c.name === 'jira')).toEqual({ name: 'jira', description: 'Fetch a Jira issue', hint: '<issue-key or URL>', kind: 'skill', source: 'user' });
    expect(list.find((c) => c.name === 'vine')).toMatchObject({ description: 'project vine', source: 'project', kind: 'command' });
    expect(list.find((c) => c.name === 'superpowers:brainstorming')).toMatchObject({ source: 'superpowers' });
    // a command without a description: its first line
    const userOnly = await listCommands({ claudeDir: claude });
    expect(userOnly.find((c) => c.name === 'vine')?.description).toBe('Review a batch');
  });
});

describe('attachments', () => {
  it('saves under the session folder with a safe, dated name and prunes old ones', () => {
    const data = mkdtempSync(join(tmpdir(), 'cora-att-'));
    expect(safeName('My Screen shot (2).PNG')).toBe('My-Screen-shot-2.png');
    expect(safeName('../../evil')).toBe('evil');
    const p = saveAttachment(data, 'sess-1', 'shot.png', Buffer.from('png'), new Date('2026-10-14T12:34:56Z'));
    expect(p).toBe(join(attachmentsDir(data), 'sess-1', '20261014-123456-shot.png'));
    expect(readFileSync(p, 'utf8')).toBe('png');
    const again = saveAttachment(data, 'sess-1', 'shot.png', Buffer.from('2'), new Date('2026-10-14T12:34:56Z'));
    expect(again).not.toBe(p);
    expect(() => saveAttachment(data, '../x', 'a', Buffer.from('1'))).toThrow();
    const old = (Date.now() - 20 * 86_400_000) / 1000;
    utimesSync(p, old, old);
    expect(pruneAttachments(data)).toBe(1);
    expect(existsSync(again)).toBe(true);
  });
});

describe('composer routes', () => {
  let srv: Running;
  afterEach(async () => srv?.close());
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };

  it('types a prompt (several lines as a paste, then Enter) into a live terminal only', async () => {
    const writes: string[] = [];
    const spawn = () => ({ onData() {}, onExit() {}, write: (d: string) => void writes.push(d), resize() {}, kill() {} });
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-comp-'));
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, spawn });
    const t = (await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd: dataDir } })).json();
    const r = await srv.app.inject({ method: 'POST', url: `/api/terminals/${t.terminalId}/input`, headers: H, payload: { text: 'one\ntwo', submit: true } });
    expect(r.json()).toEqual({ ok: true, paste: true });
    expect(writes).toEqual(['\x1b[200~one\rtwo\x1b[201~']);
    await new Promise((res) => setTimeout(res, 200));
    expect(writes).toEqual(['\x1b[200~one\rtwo\x1b[201~', '\r']);
    expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${t.terminalId}/input`, headers: H, payload: { text: '\x1b\x03' } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${t.terminalId}/input`, headers: { cookie: H.cookie }, payload: { text: 'x' } })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals/nope/input', headers: H, payload: { text: 'x' } })).statusCode).toBe(404);

    // an attachment for that session lands in the data folder; the path comes back
    const up = await srv.app.inject({ method: 'POST', url: `/api/sessions/${t.sessionId}/attachments`, headers: H, payload: { name: 'shot.png', data: Buffer.from('img').toString('base64') } });
    expect(up.statusCode).toBe(200);
    expect(readFileSync(up.json().path, 'utf8')).toBe('img');
    expect(up.json().path.startsWith(join(dataDir, 'attachments', t.sessionId))).toBe(true);
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/nope/attachments', headers: H, payload: { name: 'a', data: 'eA==' } })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: 'POST', url: `/api/sessions/${t.sessionId}/attachments`, headers: H, payload: { name: 'a', data: '' } })).statusCode).toBe(400);

    const cmds = await srv.app.inject({ url: `/api/sessions/${t.sessionId}/commands`, headers: { cookie: H.cookie } });
    expect(Array.isArray(cmds.json().commands)).toBe(true);
  });
});

describe('a big prompt', () => {
  it('takes what Claude Code takes: a long pasted log goes as one paste', () => {
    const log = Array.from({ length: 4000 }, (_, i) => `line ${i}: ${'x'.repeat(40)}`).join('\n');
    const r = terminalInput(log);
    expect(r).toMatchObject({ paste: true });
    expect(MAX_INPUT).toBeGreaterThanOrEqual(1_000_000);
  });
});
