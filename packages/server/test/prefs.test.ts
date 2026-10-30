import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, DEFAULT_VIDEO, DEFAULT_VOICE, WAKE_THRESHOLDS } from '@cora/shared';
import { applyPatch, Prefs } from '../src/prefs';
import { hostedArgs, nudgeFor, ruleFor, speakNudge } from '../src/hosted';
import { loadConfig } from '../src/config';

describe('settings', () => {
  it('validates patches', () => {
    expect(applyPatch(DEFAULT_SETTINGS, { explains: { mode: 'markdown' } }).explains.mode).toBe('markdown');
    expect(() => applyPatch(DEFAULT_SETTINGS, { explains: { mode: 'pdf' as any } })).toThrow(/explains.mode/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { retentionDays: 0 })).toThrow(/retentionDays/);
    expect(DEFAULT_SETTINGS.autoName).toBe(false);
    expect(applyPatch(DEFAULT_SETTINGS, { autoName: true }).autoName).toBe(true);
    expect(() => applyPatch(DEFAULT_SETTINGS, { autoName: 'yes' as any })).toThrow(/autoName/);
  });

  it('debrief: offered after bigger changes, quick, silent by default; changed one part at a time; nonsense refused', () => {
    expect(applyPatch(DEFAULT_SETTINGS, {}).debrief).toEqual({ offer: 'bigger', depth: 'quick', speak: false, video: DEFAULT_VIDEO });
    expect(applyPatch(DEFAULT_SETTINGS, { debrief: { depth: 'teach' } }).debrief).toEqual({ offer: 'bigger', depth: 'teach', speak: false, video: DEFAULT_VIDEO });
    expect(applyPatch(DEFAULT_SETTINGS, { debrief: { video: { size: '720', keepHours: 1 } } }).debrief?.video).toEqual({ ...DEFAULT_VIDEO, size: '720', keepHours: 1 });
    expect(() => applyPatch(DEFAULT_SETTINGS, { debrief: { video: { keepHours: 5 as never } } })).toThrow(/video.keepHours/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { debrief: { offer: 'sometimes' } })).toThrow(/debrief.offer/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { debrief: { speak: 'yes' } })).toThrow(/debrief.speak/);
    const on = nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'off', false, { offer: 'bigger', depth: 'teach', speak: false, video: DEFAULT_VIDEO });
    expect(on).toMatch(/crosses files.*`Debrief\? · Quick · Teach me`.*usual depth is Teach me/);
    expect(on).toMatch(/with the `debrief` tool/);
    const never = nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'off', false, { offer: 'never', depth: 'quick', speak: false, video: DEFAULT_VIDEO });
    expect(never).not.toMatch(/Debrief\?/);
    expect(never).toMatch(/with the `debrief` tool/);
  });

  it('worktrees: sessions move when they would collide by default; always or only when asked; nonsense refused', () => {
    expect(applyPatch(DEFAULT_SETTINGS, {}).worktrees).toEqual({ move: 'collide' });
    expect(applyPatch(DEFAULT_SETTINGS, { worktrees: { move: 'ask' } }).worktrees).toEqual({ move: 'ask' });
    expect(() => applyPatch(DEFAULT_SETTINGS, { worktrees: { move: 'sometimes' } })).toThrow(/worktrees.move/);
  });

  it('persists into config.json without clobbering other keys', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ab-prefs-')), 'config.json');
    writeFileSync(file, JSON.stringify({ port: 4400 }));
    const p = new Prefs(file);
    p.update({ explains: { frequency: 'sparingly' }, retentionDays: 14, autoName: true });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw).toMatchObject({ port: 4400, retentionDays: 14, explains: { mode: 'markdown+html', frequency: 'sparingly', reply: 'pointer' } });
    expect(new Prefs(file).get().explains.frequency).toBe('sparingly');
    expect(new Prefs(file).get().autoName).toBe(true);
  });

  it("keeps Cora's Slack bot settings across restarts, saved through the dashboard's settings route", { timeout: 30_000 }, async () => {
    const { startServer } = await import('../src/server');
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-prefs-bot-'));
    const cfg = loadConfig({ dataDir, dbPath: join(dataDir, 'brain.db'), hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') });
    const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
    const patch = { slackBot: { alerts: false, awayMinutes: 30, ping: { failures: false }, finished: 'off', quiet: { on: true, from: '21:00', to: '06:30' }, instructions: false, dailyCap: 100 } };
    const first = await startServer(cfg, { tail: false, listen: false, kubeDir: join(dataDir, 'no-kube') });
    try {
      expect((await first.app.inject({ method: 'POST', url: '/api/settings', headers: UI, payload: patch })).statusCode).toBe(200);
    } finally {
      await first.close();
    }
    // a restart: a new server on the same data folder
    const again = await startServer(cfg, { tail: false, listen: false, kubeDir: join(dataDir, 'no-kube') });
    try {
      const s = (await again.app.inject({ method: 'GET', url: '/api/settings', headers: UI })).json();
      expect(s.slackBot).toEqual({ alerts: false, awayMinutes: 30, ping: { prompts: true, failures: false, tickets: true, mail: true }, finished: 'off', quiet: { on: true, from: '21:00', to: '06:30' }, instructions: false, dailyCap: 100 });
      // one change later keeps the rest
      await again.app.inject({ method: 'POST', url: '/api/settings', headers: UI, payload: { slackBot: { ping: { tickets: false } } } });
    } finally {
      await again.close();
    }
    expect(new Prefs(join(dataDir, 'config.json')).get().slackBot).toMatchObject({ awayMinutes: 30, ping: { prompts: true, failures: false, tickets: false }, quiet: { on: true, from: '21:00' } });
  });

  it('keeps watching Jira across restarts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ab-prefs-')), 'config.json');
    new Prefs(file).update({ jira: { watch: { on: true, site: 'acme.atlassian.net', kinds: { watched: 'off' }, start: 'auto' } } });
    expect(new Prefs(file).get().jira.watch).toMatchObject({ on: true, site: 'acme.atlassian.net', start: 'auto', kinds: { watched: 'off', assigned: 'say' } });
  });

  it('nudge reflects the explain settings', () => {
    const n = nudgeFor({ mode: 'markdown', frequency: 'sparingly', reply: 'summary' });
    expect(n).toMatch(/markdown only/i);
    expect(n).toMatch(/only when the content is genuinely/i);
    expect(n).toMatch(/2 to 4 sentence summary/);
    expect(n).not.toMatch(/self-contained HTML/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains)).toMatch(/self-contained HTML/);
  });

  it('hosted sessions get open_tab; explains are written in the reply (no present tool), only when they are on', () => {
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-host-')), hookToken: 't', uiToken: 'u' });
    const off = hostedArgs(cfg, { ...DEFAULT_SETTINGS, explains: { ...DEFAULT_SETTINGS.explains, mode: 'off' } });
    expect(off[off.indexOf('--allowedTools') + 1]).toBe('mcp__cora__open_tab,mcp__cora__spotlight,mcp__cora__board,mcp__cora__journal,mcp__cora__journal_search,mcp__cora__debrief,mcp__cora__secrets,mcp__cora__secret_run,EnterWorktree,mcp__cora__environment,mcp__cora__deploys,mcp__cora__notes_list,mcp__cora__notes_search,mcp__cora__notes_read,mcp__cora__notes_add,mcp__cora__slack_find,mcp__cora__slack_read,mcp__cora__slack_send');
    expect(readFileSync(off[off.indexOf('--append-system-prompt-file') + 1], 'utf8')).not.toMatch(/cora:explain/);
    const args = hostedArgs(cfg, DEFAULT_SETTINGS);
    // with HTML explains on: live explains too, and editing in their folder (only there in Cora's) with no prompt
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(`mcp__cora__open_tab,mcp__cora__spotlight,mcp__cora__board,mcp__cora__journal,mcp__cora__journal_search,mcp__cora__debrief,mcp__cora__secrets,mcp__cora__secret_run,EnterWorktree,mcp__cora__environment,mcp__cora__deploys,mcp__cora__notes_list,mcp__cora__notes_search,mcp__cora__notes_read,mcp__cora__notes_add,mcp__cora__slack_find,mcp__cora__slack_read,mcp__cora__slack_send,mcp__cora__live_explain,Edit(${ruleFor(join(cfg.dataDir, 'explains'))}/**)`);
    expect(args.slice(args.indexOf('--add-dir') + 1, args.indexOf('--add-dir') + 3)).toEqual([join(cfg.dataDir, 'attachments'), join(cfg.dataDir, 'explains')]);
    expect(off.slice(off.indexOf('--add-dir') + 1, off.indexOf('--add-dir') + 3)).toEqual([join(cfg.dataDir, 'attachments'), '--mcp-config']);
    const guide = readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
    expect(guide).toMatch(/--bg \(the page\), --panel and --panel2 \(cards\), --ink/);
    expect(guide).toMatch(/call the live_explain tool once/);
    expect(nudgeFor({ ...DEFAULT_SETTINGS.explains, mode: 'markdown' })).not.toMatch(/live_explain|--panel/);
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toMatch(/<!-- cora:explain title=/);
    expect(JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.cora.alwaysLoad).toBe(true);
    // a session's own config says which session it is (its Slack drafts show whose they are)
    const mine = hostedArgs(cfg, DEFAULT_SETTINGS, 'sess-0001');
    const conf = JSON.parse(readFileSync(mine[mine.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.cora;
    expect(conf.headers).toEqual({ 'x-cora-token': 't', 'x-cora-session': 'sess-0001' });
    expect(mine[mine.indexOf('--mcp-config') + 1]).toBe(join(cfg.dataDir, 'hosted-mcp', 'sess-0001.json'));
    // the composer's attachments folder is readable without a permission prompt
    expect(args[args.indexOf('--add-dir') + 1]).toBe(join(cfg.dataDir, 'attachments'));
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toMatch(/open_tab/);
  });
});

describe('permission rules for a folder', () => {
  it("writes an absolute path the way Claude Code matches it (Windows: //c/Users/…)", () => {
    expect(ruleFor(String.raw`C:\Users\you\.cora\explains`)).toBe('//c/Users/you/.cora/explains');
    expect(ruleFor('/home/you/.cora/explains')).toBe('//home/you/.cora/explains');
  });
});

describe('voice settings', () => {
  const on = { ...DEFAULT_VOICE, enabled: true };

  it('reading: buttons, summaries (the default) or full replies; the old auto means full', () => {
    expect(DEFAULT_VOICE.read).toBe('summaries');
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { read: 'buttons' } }).voice.read).toBe('buttons');
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { read: 'full' } }).voice.read).toBe('full');
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { read: 'auto' as any } }).voice.read).toBe('full');
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { read: 'loud' as any } })).toThrow(/voice.read/);
    expect(DEFAULT_SETTINGS.voice.model).toBe('eleven_flash_v2_5');
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { model: 'eleven_v4' } }).voice.model).toBe('eleven_v4');
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { model: 'gpt-4o' } })).toThrow(/voice.model/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { model: 'eleven_v4/../x' } })).toThrow(/voice.model/);
  });

  it("your instructions for Cora: text, trimmed, not too long", () => {
    expect(applyPatch(DEFAULT_SETTINGS, { orchestrator: { instructions: '  Be brief.  ' } }).orchestrator.instructions).toBe('Be brief.');
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { instructions: 'x'.repeat(4001) } })).toThrow(/4000/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { instructions: 42 as any } })).toThrow(/text/);
  });

  it('talking: Cora sends when you stop (or you review), and click-to-talk stops after a pause (or on a click)', () => {
    const v = applyPatch(DEFAULT_SETTINGS, { voice: { coraAfter: 'review', endOnSilence: 800 } }).voice;
    expect(v).toMatchObject({ coraAfter: 'review', endOnSilence: 800 });
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { endOnSilence: 0 } }).voice.endOnSilence).toBe(0);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { coraAfter: 'later' as any } })).toThrow(/coraAfter/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { endOnSilence: 99999 } })).toThrow(/endOnSilence/);
  });

  it('watching Jira: off by default; on, a site, a level per kind; nonsense refused', () => {
    expect(DEFAULT_SETTINGS.jira.watch).toEqual({ on: false, kinds: { assigned: 'say', mentioned: 'say', commented: 'notify', status: 'notify', watched: 'quiet' }, start: 'offer' });
    // when a ticket is assigned to you: tell, offer (the default) or start it on its own
    expect(applyPatch(DEFAULT_SETTINGS, { jira: { watch: { start: 'auto' } } }).jira.watch.start).toBe('auto');
    expect(() => applyPatch(DEFAULT_SETTINGS, { jira: { watch: { start: 'yolo' as any } } })).toThrow(/jira.watch.start/);
    const w = applyPatch(DEFAULT_SETTINGS, { jira: { watch: { on: true, site: 'acme.atlassian.net', kinds: { watched: 'off' } } } }).jira.watch;
    expect(w).toEqual({ on: true, site: 'acme.atlassian.net', kinds: { assigned: 'say', mentioned: 'say', commented: 'notify', status: 'notify', watched: 'off' }, start: 'offer' });
    expect(applyPatch(DEFAULT_SETTINGS, { jira: { watch: { site: '' } } }).jira.watch.site).toBeUndefined();
    expect(() => applyPatch(DEFAULT_SETTINGS, { jira: { watch: { on: 'yes' as any } } })).toThrow(/jira.watch.on/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { jira: { watch: { site: 'not a host' } } })).toThrow(/jira.watch.site/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { jira: { watch: { kinds: { assigned: 'loud' as any } } } })).toThrow(/jira.watch.kinds/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { jira: { watch: { kinds: { birthdays: 'say' } as any } } })).toThrow(/jira.watch.kinds/);
  });

  it('Hey Cora: off by default; a sensitivity; follow-ups on unless turned off', () => {
    expect(DEFAULT_VOICE.wake).toBeUndefined();
    const v = applyPatch(DEFAULT_SETTINGS, { voice: { wake: true, wakeSensitivity: 'high', wakeFollowUp: false } }).voice;
    expect(v).toMatchObject({ wake: true, wakeSensitivity: 'high', wakeFollowUp: false });
    expect(WAKE_THRESHOLDS).toEqual({ low: 0.7, balanced: 0.5, high: 0.35 });
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { wake: 'yes' as any } })).toThrow(/voice.wake/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { wakeSensitivity: 'max' as any } })).toThrow(/wakeSensitivity/);
  });

  it('answering straight away (the voice front): on unless turned off, and it saves', () => {
    expect(DEFAULT_VOICE.front).toBeUndefined();
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { front: false } }).voice.front).toBe(false);
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { front: 'no' as any } })).toThrow(/voice.front/);
  });

  it("Cora's own voice: an ElevenLabs id, or empty for the sessions' voice", () => {
    expect(DEFAULT_VOICE.coraVoiceId).toBeUndefined();
    const v = applyPatch(DEFAULT_SETTINGS, { voice: { coraVoiceId: 'EXAVITQu4vr4xnSDxMaL', coraVoiceName: 'Sarah' } }).voice;
    expect(v).toMatchObject({ coraVoiceId: 'EXAVITQu4vr4xnSDxMaL', coraVoiceName: 'Sarah', voiceId: DEFAULT_VOICE.voiceId });
    expect(applyPatch(DEFAULT_SETTINGS, { voice: { coraVoiceId: '' } }).voice.coraVoiceId).toBe('');
    expect(() => applyPatch(DEFAULT_SETTINGS, { voice: { coraVoiceId: '../x' } })).toThrow(/coraVoiceId/);
  });

  it('announcements: permission prompts and background tasks on, failures off, each its own toggle', () => {
    expect(DEFAULT_VOICE).toMatchObject({ announce: true, announceTasks: true, announceFailures: false });
    const v = applyPatch(DEFAULT_SETTINGS, { voice: { announceFailures: true, announce: false } }).voice;
    expect(v).toMatchObject({ announce: false, announceTasks: true, announceFailures: true });
  });

  it('settings saved by an older Cora keep working', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ab-prefs-')), 'config.json');
    writeFileSync(file, JSON.stringify({ voice: { enabled: true, read: 'auto', announce: false, cap: 300 } }));
    const v = new Prefs(file).get().voice;
    // tasks used to be announced with permission prompts: they stay quiet too
    expect(v).toMatchObject({ enabled: true, read: 'full', announce: false, announceTasks: false, announceFailures: false, cap: 300 });
    writeFileSync(file, JSON.stringify({ voice: { enabled: true, read: 'buttons' } }));
    expect(new Prefs(file).get().voice).toMatchObject({ read: 'buttons', announce: true, announceTasks: true });
  });

  it('asks for spoken summaries only when voice is on and reads summaries', () => {
    expect(speakNudge(on)).toMatch(/`speak` tool/);
    // a say-line in the reply (free), not a speak call at the end of the turn (an extra request)
    expect(speakNudge(on)).toMatch(/<!-- say: \.\.\. -->/);
    expect(speakNudge(on)).toMatch(/Don't call the `speak` tool at the end of a turn/);
    expect(speakNudge(on)).toMatch(/never instead of your written reply/);
    expect(speakNudge(DEFAULT_VOICE)).toBeNull(); // off
    expect(speakNudge({ ...on, read: 'full' })).toBeNull();
    expect(speakNudge({ ...on, read: 'buttons' })).toBeNull();
    expect(nudgeFor(DEFAULT_SETTINGS.explains, on)).toMatch(/speak/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains)).not.toMatch(/speak/);
  });

  it('hosted sessions may call speak only when voice reads summaries', () => {
    const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-host-')), hookToken: 't', uiToken: 'u' });
    const allowed = (voice: typeof on) => {
      const args = hostedArgs(cfg, { ...DEFAULT_SETTINGS, voice });
      return { tools: args[args.indexOf('--allowedTools') + 1], prompt: readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8') };
    };
    expect(allowed(on).tools.split(',')).toContain('mcp__cora__speak');
    expect(allowed(on).prompt).toMatch(/<!-- say:/);
    expect(allowed(DEFAULT_VOICE).tools).not.toMatch(/speak/);
    expect(allowed({ ...on, read: 'full' }).tools).not.toMatch(/speak/);
    expect(allowed({ ...on, read: 'full' }).prompt).not.toMatch(/speak/);
  });

  it('the orchestrator: off by default; a model name; speaking on or off', () => {
    expect(DEFAULT_SETTINGS.orchestrator).toMatchObject({ enabled: false, model: 'opus', speak: true });
    const on = applyPatch(DEFAULT_SETTINGS, { orchestrator: { enabled: true, model: 'claude-opus-5-5[1m]' } });
    expect(on.orchestrator).toMatchObject({ enabled: true, model: 'claude-opus-5-5[1m]', speak: true });
    expect(applyPatch(on, { orchestrator: { speak: false } }).orchestrator).toMatchObject({ enabled: true, model: 'claude-opus-5-5[1m]', speak: false });
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { model: 'opus --dangerously-skip-permissions' } })).toThrow(/model/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { enabled: 'yes' as any } })).toThrow(/enabled/);
  });

  it("the orchestrator's mandate, budget and events", () => {
    expect(DEFAULT_SETTINGS.orchestrator.mandate).toEqual({ repos: [], deploy: false, slack: [] });
    const repo = process.platform === 'win32' ? 'C:\\code\\orion' : '/code/orion';
    const s = applyPatch(DEFAULT_SETTINGS, { orchestrator: { mandate: { repos: [repo + '\\', repo], slack: ['#deploys'] }, budget: 2_000_000, events: 'off' } });
    expect(s.orchestrator.mandate).toEqual({ repos: [repo], deploy: false, slack: ['deploys'] });
    expect(s.orchestrator.budget).toBe(2_000_000);
    expect(s.orchestrator.events).toBe('off');
    expect(applyPatch(s, { orchestrator: { mandate: { deploy: true } } }).orchestrator.mandate).toEqual({ repos: [repo], deploy: true, slack: ['deploys'] });
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { mandate: { repos: ['relative/path'] } } })).toThrow(/absolute/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { mandate: { repos: Array.from({ length: 31 }, (_, i) => `${repo}${i}`) } } })).toThrow(/30/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { budget: 10 } })).toThrow(/budget/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { orchestrator: { events: 'loud' as any } })).toThrow(/events/);
  });

describe('channels you follow (Slack in the Inbox)', () => {
  it('kept and read back; words trimmed, lower-case, once; bad lists refused', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-pf-')), 'config.json');
    const p = new Prefs(file);
    p.update({ slack: { follow: [{ id: 'C0123456', label: '#platform-ops', words: [' Outage ', 'outage', 'node 3'] }] } });
    expect(new Prefs(file).get().slack.follow).toEqual([{ id: 'C0123456', label: '#platform-ops', words: ['outage', 'node 3'] }]);
    expect(() => applyPatch(DEFAULT_SETTINGS, { slack: { follow: [{ id: 'nope', label: 'x', words: [] }] } })).toThrow(/channel id/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { slack: { follow: [{ id: 'C0123456', label: 'x', words: ['a'] }] } })).toThrow(/words/);
    expect(DEFAULT_SETTINGS.slack.follow).toEqual([]);
  });
});
});

describe("the browser's profiles", () => {
  it("each keeps its sign-ins; one keeps Cora's old ones (sessions' first); sessions must use one of them", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-pf-')), 'config.json');
    const p = new Prefs(file);
    p.update({ browser: { profiles: [{ id: 'chrome:Default', name: 'Personal' }, { id: 'chrome:Profile 2', name: 'Work' }], sessions: 'chrome:Profile 2' } });
    const b = new Prefs(file).get().browser;
    expect(b.profiles).toEqual([
      { id: 'chrome:Default', name: 'Personal', partition: 'persist:web-chrome-default' },
      { id: 'chrome:Profile 2', name: 'Work', partition: 'persist:web' },
    ]);
    expect(b.sessions).toBe('chrome:Profile 2');
    // adding one later: the others keep theirs
    p.update({ browser: { profiles: [...b.profiles!, { id: 'edge:Default', name: 'Edge' }] } });
    expect(p.get().browser.profiles!.map((x) => x.partition)).toEqual(['persist:web-chrome-default', 'persist:web', 'persist:web-edge-default']);
    // the partition isn't yours to set; the one with Cora's old logins gone, the one left keeps them
    p.update({ browser: { profiles: [{ id: 'chrome:Default', name: 'Personal', partition: 'persist:evil' } as never] } });
    expect(p.get().browser.profiles).toEqual([{ id: 'chrome:Default', name: 'Personal', partition: 'persist:web' }]);
    expect(p.get().browser.sessions).toBeUndefined();
    expect(() => applyPatch(DEFAULT_SETTINGS, { browser: { profiles: [{ id: '../x', name: 'x' }] } })).toThrow(/id like chrome:Default/);
    expect(() => applyPatch(DEFAULT_SETTINGS, { browser: { profiles: [{ id: 'chrome:Default', name: 'A' }], sessions: 'edge:Default' } })).toThrow(/one of the profiles/);
    // Cora's sign-ins moved to another profile: the one that had them gets its own
    p.update({ browser: { profiles: [{ id: 'chrome:Default', name: 'Personal' }, { id: 'chrome:Profile 2', name: 'Work' }] } });
    expect(p.get().browser.profiles!.map((x) => x.partition)).toEqual(['persist:web', 'persist:web-chrome-profile-2']);
    p.update({ browser: { home: 'chrome:Profile 2' } });
    expect(p.get().browser.profiles!.map((x) => x.partition)).toEqual(['persist:web-chrome-default', 'persist:web']);
    expect(() => p.update({ browser: { home: 'edge:Default' } })).toThrow(/one of the profiles/);
    // the profile your Gmail is on: one of them, or none
    p.update({ browser: { mail: 'chrome:Profile 2' } });
    expect(new Prefs(file).get().browser.mail).toBe('chrome:Profile 2');
    expect(() => p.update({ browser: { mail: 'edge:Default' } })).toThrow(/browser.mail/);
    p.update({ browser: { mail: '' } });
    expect(p.get().browser.mail).toBeUndefined();
    // none: as before (one profile, every browser's bookmarks)
    p.update({ browser: { profiles: [] } });
    expect(p.get().browser).toEqual({ chrome: true });
  });
});

describe('a damaged config.json (audit B1)', () => {
  it('one bad value: the rest are kept, the file is kept aside, and a save never writes defaults over them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-pf-bad-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ port: 4317, autoName: true, retentionDays: 30, slack: { follow: [{ id: 'nope', label: 'x', words: [] }] } }));
    const p = new Prefs(file);
    expect(p.get().autoName).toBe(true);
    expect(p.get().retentionDays).toBe(30);
    expect(p.problems[0]).toMatch(/slack/);
    expect(readdirSync(dir).some((f) => f.startsWith('config.json.kept-'))).toBe(true);
    p.update({ explains: { frequency: 'sparingly' } });
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect([saved.autoName, saved.retentionDays, saved.port]).toEqual([true, 30, 4317]);
  });

  it("not JSON at all: it's kept aside before anything is written", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-pf-bad-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{ "autoName": true, ');
    const p = new Prefs(file);
    expect(p.problems[0]).toMatch(/isn't valid JSON/);
    const kept = readdirSync(dir).find((f) => f.startsWith('config.json.kept-'))!;
    expect(readFileSync(join(dir, kept), 'utf8')).toBe('{ "autoName": true, ');
  });
});
