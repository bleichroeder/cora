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
        const r = await call('GET', '/api/ide/bridge/before?' + q.toString()).catch(() => null);
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

  // what Cora asks of this window: open a file (at a line), or a turn's change as a diff
  const run = async (c) => {
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
  ],
  menus: { 'editor/context': [{ command: 'cora.ask', when: 'editorHasSelection', group: 'navigation@0' }] },
};
