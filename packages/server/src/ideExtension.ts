/**
 * The Cora extension's code in the IDE panel's VS Code (written by Cora when it starts VS Code): its app-wide
 * settings once, its theme, and the bridge to Cora (ideBridge): Cora opens files and turns' diffs here; it marks what
 * Claude wrote; "Ask the session about this" puts your selection in that session's prompt box; the status bar shows
 * the session working in this folder.
 */
export const EXTENSION_JS = (defaults: Record<string, unknown>) => `// Cora's IDE panel extension. Written by Cora (rewritten each time Cora starts VS Code): don't edit.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const DEFAULTS = ${JSON.stringify(defaults, null, 2)};

function bridge() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'bridge.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}
const folder = () => (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0] ? vscode.workspace.workspaceFolders[0].uri.fsPath : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settingsOnce(ctx) {
  const cfg = vscode.workspace.getConfiguration();
  const G = vscode.ConfigurationTarget.Global;
  let reload = false;
  for (const [k, v] of Object.entries(DEFAULTS)) {
    const i = cfg.inspect(k);
    if (i && i.globalValue === undefined && !ctx.globalState.get('cora.set.' + k)) {
      await cfg.update(k, v, G).then(() => ctx.globalState.update('cora.set.' + k, true), () => {});
      if (k === 'security.workspace.trust.enabled') reload = true;
    }
  }
  if (cfg.get('workbench.colorTheme') !== 'Cora') await cfg.update('workbench.colorTheme', 'Cora', G).then(undefined, () => {});
  if (!ctx.globalState.get('cora.closedChat')) {
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar').then(undefined, () => {});
    // the Welcome page it opened before these settings landed
    const welcome = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => /^welcome$/i.test(t.label));
    if (welcome.length) await vscode.window.tabGroups.close(welcome).then(undefined, () => {});
    await ctx.globalState.update('cora.closedChat', true);
  }
  return reload;
}

exports.activate = async (ctx) => {
  if (await settingsOnce(ctx)) return void vscode.commands.executeCommand('workbench.action.reloadWindow');
  const b = bridge();
  if (!b.url || !b.token) return;
  const call = (method, p, body) =>
    fetch(b.url + p, { method, headers: Object.assign({ 'x-cora-ide': b.token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });

  // a turn's change: the file as it was (from Cora: Claude Code's snapshot) against the file now
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('cora-before', {
      provideTextDocumentContent: async (uri) => {
        const q = new URLSearchParams(uri.query);
        const r = await call('GET', (q.has('debrief') ? '/api/ide/bridge/debrief/before?' : '/api/ide/bridge/before?') + q.toString()).catch(() => null);
        if (!r || !r.ok) return '(Cora has no copy of this file from before the turn)';
        return (await r.json()).text;
      },
    }),
  );

  // the status bar: the session working in this folder; click for Cora, at it
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  bar.command = 'cora.focus';
  ctx.subscriptions.push(bar);
  const WORD = { working: 'working', thinking: 'thinking', 'needs-you': 'needs you', idle: 'idle' };
  const ICON = { working: '$(sync~spin)', thinking: '$(loading~spin)', 'needs-you': '$(bell-dot)', idle: '$(circle-outline)' };
  const showSession = (s) => {
    if (!s) return bar.hide();
    bar.text = (ICON[s.state] || '$(circle-outline)') + ' ' + s.name + ' · ' + (WORD[s.state] || s.state);
    bar.tooltip = 'Cora: the session working here (click to go to it in Cora)';
    bar.show();
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('cora.focus', () => call('POST', '/api/ide/bridge/focus', { folder: folder() }).catch(() => {})),
    vscode.commands.registerCommand('cora.ask', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) return;
      const r = await call('POST', '/api/ide/bridge/ask', { folder: folder(), path: ed.document.uri.fsPath, start: ed.selection.start.line + 1, end: ed.selection.end.line + 1, text: ed.document.getText(ed.selection) }).catch(() => null);
      if (!r || !r.ok) vscode.window.showWarningMessage('Cora: no session works in this folder.');
      else vscode.window.setStatusBarMessage('Cora: in ' + (await r.json()).session + "'s prompt box", 3000);
    }),
  );

  // what Claude wrote into the file in front: a quiet mark on those lines
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent || '') ? b.accent : '#f472b6';
  const mark = vscode.window.createTextEditorDecorationType({ isWholeLine: true, borderWidth: '0 0 0 2px', borderStyle: 'solid', borderColor: accent + '99', overviewRulerColor: accent + '99', overviewRulerLane: vscode.OverviewRulerLane.Left });
  ctx.subscriptions.push(mark);
  const markEditor = async (ed) => {
    if (!ed || ed.document.uri.scheme !== 'file') return;
    const r = await call('GET', '/api/ide/bridge/marks?path=' + encodeURIComponent(ed.document.uri.fsPath)).catch(() => null);
    if (!r || !r.ok) return;
    const { snippets } = await r.json();
    const text = ed.document.getText().replace(/\\r\\n/g, '\\n');
    const ranges = [];
    for (const sn of snippets) {
      const t = sn.replace(/\\r\\n/g, '\\n');
      if (t.trim().length < 3) continue;
      const at = text.indexOf(t);
      if (at < 0) continue;
      const from = ed.document.positionAt(at).line;
      const to = ed.document.positionAt(at + t.length).line;
      ranges.push(new vscode.Range(from, 0, Math.max(from, to - (t.endsWith('\\n') ? 1 : 0)), 0));
    }
    ed.setDecorations(mark, ranges);
  };
  ctx.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => void markEditor(ed)),
    vscode.workspace.onDidSaveTextDocument((doc) => vscode.window.visibleTextEditors.filter((e) => e.document === doc).forEach((e) => void markEditor(e))),
  );
  void markEditor(vscode.window.activeTextEditor);
  const remark = setInterval(() => void markEditor(vscode.window.activeTextEditor), 15000);
  ctx.subscriptions.push({ dispose: () => clearInterval(remark) });

  // Debrief: a session walks you through its work. Each step lights its lines (the beat being read brighter) and a
  // bubble beside them (a comment thread) says what changed and why; its buttons and its reply box go back to Cora.
  const NL = String.fromCharCode(10);
  const dbCtl = vscode.comments.createCommentController('cora-debrief', 'Cora · Debrief');
  dbCtl.options = { prompt: 'Ask about this step…', placeHolder: 'Ask the session about this step' };
  const dbStep = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: accent + '14' });
  const dbBeat = vscode.window.createTextEditorDecorationType({ isWholeLine: true, backgroundColor: accent + '30', borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: accent, overviewRulerColor: accent, overviewRulerLane: vscode.OverviewRulerLane.Full });
  let dbDoc = '';
  const dbDocs = new vscode.EventEmitter();
  const DB_DOC = vscode.Uri.from({ scheme: 'cora-debrief', path: '/Debrief.md' });
  ctx.subscriptions.push(dbCtl, dbStep, dbBeat, dbDocs, vscode.workspace.registerTextDocumentContentProvider('cora-debrief', { onDidChange: dbDocs.event, provideTextDocumentContent: () => dbDoc }));
  let db = null; // the step shown: { c, uri, thread, extra (the questions and answers under it) }
  const md = (s) => new vscode.MarkdownString(s);
  const dbBody = (c) => {
    const parts = c.beats.map((t, i) => (i === c.beat && c.beats.length > 1 && c.label !== 'quiz' ? '**' + t + '**' : t));
    if (c.why) parts.push('*Why:* ' + c.why);
    if (c.links) parts.push(c.links.map((l) => '[' + l.title.split('[').join('(').split(']').join(')') + '](' + l.url + ')').join(' · '));
    return parts.join(NL + NL);
  };
  const lines = (r) => new vscode.Range(r[0] - 1, 0, r[1] - 1, 0);
  const dbPaint = (ed, fresh) => {
    if (!db || !ed || ed.document.uri.toString() !== db.uri.toString()) return;
    const c = db.c;
    const at = c.beatRange || c.range;
    ed.setDecorations(dbStep, c.range ? [lines(c.range)] : []);
    ed.setDecorations(dbBeat, at ? [lines(at)] : []);
    // scrolled so the lines being read and the bubble under the step both show: the step from its top when it fits with
    // the bubble below it; a long one far enough down that its end and the bubble are in view (the beat kept in sight)
    if (!c.range) return;
    const vis = ed.visibleRanges[0];
    const rows = vis ? Math.max(12, vis.end.line - vis.start.line) : 30;
    const BUBBLE = 14;
    const end = c.range[1] - 1;
    const from = (fresh ? c.range[0] : (at || c.range)[0]) - 1;
    let top = Math.max(from - 2, end + BUBBLE + 1 - rows);
    if (at && at[0] - 1 < top) top = at[0] - 2;
    top = Math.max(0, top);
    // the next beat of the same step: only when its lines are off screen
    const seen = !!vis && !!at && at[0] - 1 >= vis.start.line && at[1] - 1 <= vis.end.line;
    if (fresh || !seen) ed.revealRange(new vscode.Range(top, 0, top, 0), vscode.TextEditorRevealType.AtTop);
  };
  const dbContext = (c) => 'debrief' + (c.playing ? '-playing' : '') + (c.speak ? '-speak' : '');
  const dbRender = () => {
    const c = db.c;
    db.thread.label = c.header;
    db.thread.contextValue = dbContext(c);
    db.thread.comments = [{ body: md(dbBody(c)), mode: vscode.CommentMode.Preview, author: { name: c.name }, label: c.label, contextValue: 'debrief' }].concat(db.extra);
    db.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  };
  const dbClear = () => {
    if (db) db.thread.dispose();
    db = null;
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(dbStep, []);
      ed.setDecorations(dbBeat, []);
    }
    void vscode.commands.executeCommand('setContext', 'cora.debriefing', false);
  };
  const dbShow = async (c) => {
    const same = db && db.c.id === c.id && db.c.index === c.index;
    if (!same) {
      for (const ed of vscode.window.visibleTextEditors) {
        ed.setDecorations(dbStep, []);
        ed.setDecorations(dbBeat, []);
      }
      let uri;
      if (c.path) {
        uri = vscode.Uri.file(c.path);
        if (c.before) {
          const q = new URLSearchParams({ sessionId: c.sessionId, debrief: c.id, step: String(c.index) });
          const left = vscode.Uri.from({ scheme: 'cora-before', path: uri.path, query: q.toString() });
          await vscode.commands.executeCommand('vscode.diff', left, uri, path.basename(c.path) + ' (before the work ↔ now)', { preview: true });
        } else await vscode.window.showTextDocument(uri, { preview: true });
      } else {
        uri = DB_DOC;
        dbDoc = c.doc || '';
        dbDocs.fire(uri);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true });
      }
      if (db) db.thread.dispose();
      const thread = dbCtl.createCommentThread(uri, c.range ? lines([c.range[1], c.range[1]]) : new vscode.Range(0, 0, 0, 0), []);
      thread.canReply = true;
      db = { c, uri, thread, extra: [] };
    } else db.c = c;
    dbRender();
    void vscode.commands.executeCommand('setContext', 'cora.debriefing', true);
    for (const ed of vscode.window.visibleTextEditors) dbPaint(ed, !same);
  };
  const dbSay = (act, text) => (db ? call('POST', '/api/ide/bridge/debrief', Object.assign({ sessionId: db.c.sessionId, act }, text ? { text } : {})).catch(() => {}) : undefined);
  ctx.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors((eds) => eds.forEach((ed) => dbPaint(ed, false))),
    vscode.commands.registerCommand('cora.debrief.back', () => dbSay('back')),
    vscode.commands.registerCommand('cora.debrief.next', () => dbSay('next')),
    vscode.commands.registerCommand('cora.debrief.play', () => dbSay('play')),
    vscode.commands.registerCommand('cora.debrief.pause', () => dbSay('pause')),
    vscode.commands.registerCommand('cora.debrief.speakOn', () => dbSay('speak')),
    vscode.commands.registerCommand('cora.debrief.speakOff', () => dbSay('speak')),
    vscode.commands.registerCommand('cora.debrief.close', () => {
      void dbSay('close');
      dbClear();
    }),
    vscode.commands.registerCommand('cora.debrief.ask', (reply) => {
      const text = reply && typeof reply.text === 'string' ? reply.text.trim() : '';
      if (!db || !text) return;
      db.extra.push({ body: md(text), mode: vscode.CommentMode.Preview, author: { name: 'You' } });
      db.extra.push({ body: md('*Asked ' + db.c.name + '; the answer comes here.*'), mode: vscode.CommentMode.Preview, author: { name: db.c.name }, contextValue: 'waiting' });
      dbRender();
      void dbSay('ask', text);
    }),
  );
  const dbReply = (text) => {
    if (!db) return;
    db.extra = db.extra.filter((x) => x.contextValue !== 'waiting');
    db.extra.push({ body: md(text), mode: vscode.CommentMode.Preview, author: { name: db.c.name } });
    dbRender();
  };

  // what Cora asks of this window: open a file (at a line), or a turn's change as a diff; a debrief's step
  const run = async (c) => {
    if (c.kind === 'debrief.step') return dbShow(c);
    if (c.kind === 'debrief.end') return dbClear();
    if (c.kind === 'debrief.reply') return dbReply(c.text);
    const file = vscode.Uri.file(c.path);
    if (c.kind === 'open') {
      const ed = await vscode.window.showTextDocument(file, { preview: false });
      if (c.line) {
        const p = new vscode.Position(Math.max(0, c.line - 1), 0);
        ed.selection = new vscode.Selection(p, p);
        ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenter);
      }
    } else if (c.kind === 'diff') {
      const q = new URLSearchParams({ sessionId: c.sessionId, path: c.path, from: String(c.from) });
      const before = vscode.Uri.from({ scheme: 'cora-before', path: file.path, query: q.toString() });
      await vscode.commands.executeCommand('vscode.diff', before, file, c.title, { preview: false });
    }
  };
  let live = true;
  ctx.subscriptions.push({ dispose: () => (live = false) });
  (async () => {
    while (live) {
      const f = folder();
      if (!f) {
        await sleep(3000);
        continue;
      }
      try {
        const r = await call('GET', '/api/ide/bridge/next?folder=' + encodeURIComponent(f));
        if (!r.ok) {
          await sleep(5000);
          continue;
        }
        const j = await r.json();
        showSession(j.session);
        for (const c of j.cmds || []) await run(c).catch((e) => vscode.window.showWarningMessage('Cora: ' + e.message));
      } catch (e) {
        await sleep(3000);
      }
    }
  })();
};
exports.deactivate = () => {};
`;

/** The extension's commands and menus (its package.json's contributes, besides the theme). */
export const EXTENSION_CONTRIBUTES = {
  commands: [
    { command: 'cora.ask', title: 'Ask the session about this', category: 'Cora' },
    { command: 'cora.focus', title: 'Go to the session in Cora', category: 'Cora' },
    { command: 'cora.debrief.back', title: 'Back', category: 'Debrief', icon: '$(arrow-left)' },
    { command: 'cora.debrief.next', title: 'Next', category: 'Debrief', icon: '$(arrow-right)' },
    { command: 'cora.debrief.play', title: 'Play it through', category: 'Debrief', icon: '$(play)' },
    { command: 'cora.debrief.pause', title: 'Pause', category: 'Debrief', icon: '$(debug-pause)' },
    { command: 'cora.debrief.speakOn', title: 'Read it aloud', category: 'Debrief', icon: '$(mute)' },
    { command: 'cora.debrief.speakOff', title: 'Stop reading aloud', category: 'Debrief', icon: '$(unmute)' },
    { command: 'cora.debrief.close', title: 'End the debrief', category: 'Debrief', icon: '$(close)' },
    { command: 'cora.debrief.ask', title: 'Ask', category: 'Debrief' },
  ],
  menus: {
    'editor/context': [{ command: 'cora.ask', when: 'editorHasSelection', group: 'navigation@0' }],
    // the bubble's title bar: ‹ Back · Next › · ▶ / ❚❚ · 🔊 · ✕ (its state is the thread's contextValue)
    'comments/commentThread/title': [
      { command: 'cora.debrief.back', when: 'commentController == cora-debrief', group: 'inline@1' },
      { command: 'cora.debrief.next', when: 'commentController == cora-debrief', group: 'inline@2' },
      { command: 'cora.debrief.play', when: 'commentController == cora-debrief && commentThread =~ /^debrief(-speak)?$/', group: 'inline@3' },
      { command: 'cora.debrief.pause', when: 'commentController == cora-debrief && commentThread =~ /-playing/', group: 'inline@3' },
      { command: 'cora.debrief.speakOn', when: 'commentController == cora-debrief && commentThread =~ /^debrief(-playing)?$/', group: 'inline@4' },
      { command: 'cora.debrief.speakOff', when: 'commentController == cora-debrief && commentThread =~ /-speak$/', group: 'inline@4' },
      { command: 'cora.debrief.close', when: 'commentController == cora-debrief', group: 'inline@5' },
    ],
    // the reply box's button: the question goes to the session
    'comments/commentThread/context': [{ command: 'cora.debrief.ask', when: 'commentController == cora-debrief', group: 'inline' }],
    commandPalette: [...['back', 'next', 'play', 'pause', 'speakOn', 'speakOff', 'close'].map((c) => ({ command: `cora.debrief.${c}`, when: 'cora.debriefing' })), { command: 'cora.debrief.ask', when: 'false' }],
  },
  keybindings: [
    { command: 'cora.debrief.next', key: 'alt+right', when: 'cora.debriefing' },
    { command: 'cora.debrief.back', key: 'alt+left', when: 'cora.debriefing' },
  ],
};
