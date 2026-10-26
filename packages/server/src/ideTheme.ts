import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsx';
import { EXTENSION_CONTRIBUTES, EXTENSION_JS } from './ideExtension';

/**
 * The IDE panel's look: a "Cora" colour theme (Cora's palette, your Cora colour as its accent), shipped as a small
 * extension in the panel's own VS Code (never your desktop one), and its settings there: the theme always, and calmer
 * defaults you can change.
 */

const P = {
  bg: '#06090f',
  nav: '#0b0e14',
  raise: '#11151d',
  raise2: '#161b25',
  hair: '#94a3b817',
  hair2: '#94a3b824',
  ink: '#e6ebf2',
  ink2: '#a4afbf',
  ink3: '#6b7686',
  ink4: '#465061',
  work: '#3ddc97',
  need: '#ff6b6b',
  think: '#f5c451',
};

const hex = (c: string) => {
  const m = /^#?([0-9a-f]{6})/i.exec(c.trim());
  return m ? `#${m[1].toLowerCase()}` : '#f472b6';
};
/** `a` mixed toward `b` by `t` (0..1). */
function mix(a: string, b: string, t: number): string {
  const x = parseInt(hex(a).slice(1), 16);
  const y = parseInt(hex(b).slice(1), 16);
  const ch = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}
/** A colour with an alpha (0..1). */
const alpha = (c: string, a: number) => `${hex(c)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;

/** The theme: VS Code's colour keys from Cora's palette, `accent` (your Cora colour) where VS Code shows focus. */
export function coraTheme(accent: string): { name: string; type: 'dark'; colors: Record<string, string>; tokenColors: object[]; semanticHighlighting: boolean } {
  const a = hex(accent);
  const aSoft = mix(a, '#ffffff', 0.35);
  const colors: Record<string, string> = {
    focusBorder: alpha(a, 0.55),
    foreground: P.ink2,
    descriptionForeground: P.ink3,
    errorForeground: P.need,
    'icon.foreground': P.ink3,
    'selection.background': alpha(a, 0.35),
    'widget.shadow': '#00000080',
    'textLink.foreground': aSoft,
    'textLink.activeForeground': a,
    'textBlockQuote.background': P.raise,
    'textCodeBlock.background': P.raise,
    'sash.hoverBorder': alpha(a, 0.6),
    // the frame: Cora's nav and cards
    'titleBar.activeBackground': P.nav,
    'titleBar.inactiveBackground': P.nav,
    'titleBar.activeForeground': P.ink2,
    'titleBar.inactiveForeground': P.ink3,
    'titleBar.border': P.hair,
    'commandCenter.background': P.raise,
    'commandCenter.border': P.hair2,
    'commandCenter.foreground': P.ink2,
    'commandCenter.activeBackground': P.raise2,
    'activityBar.background': P.nav,
    'activityBar.foreground': P.ink,
    'activityBar.inactiveForeground': P.ink4,
    'activityBar.border': P.hair,
    'activityBar.activeBorder': a,
    'activityBar.activeBackground': alpha(a, 0.08),
    'activityBarBadge.background': a,
    'activityBarBadge.foreground': '#ffffff',
    'sideBar.background': P.nav,
    'sideBar.foreground': P.ink2,
    'sideBar.border': P.hair,
    'sideBarTitle.foreground': P.ink3,
    'sideBarSectionHeader.background': P.nav,
    'sideBarSectionHeader.foreground': P.ink3,
    'sideBarSectionHeader.border': P.hair,
    'list.activeSelectionBackground': alpha(a, 0.16),
    'list.activeSelectionForeground': P.ink,
    'list.inactiveSelectionBackground': P.raise2,
    'list.inactiveSelectionForeground': P.ink,
    'list.hoverBackground': P.raise,
    'list.hoverForeground': P.ink,
    'list.focusOutline': alpha(a, 0.5),
    'list.highlightForeground': aSoft,
    'list.errorForeground': P.need,
    'list.warningForeground': P.think,
    'tree.indentGuidesStroke': P.hair2,
    'statusBar.background': P.nav,
    'statusBar.foreground': P.ink3,
    'statusBar.border': P.hair,
    'statusBar.noFolderBackground': P.nav,
    'statusBar.debuggingBackground': mix(P.nav, a, 0.25),
    'statusBar.debuggingForeground': P.ink,
    'statusBarItem.hoverBackground': P.raise2,
    'statusBarItem.remoteBackground': alpha(a, 0.18),
    'statusBarItem.remoteForeground': P.ink,
    'statusBarItem.prominentBackground': alpha(a, 0.2),
    // the editor: the deepest surface, as Cora's page
    'editor.background': P.bg,
    'editor.foreground': P.ink,
    'editorLineNumber.foreground': P.ink4,
    'editorLineNumber.activeForeground': P.ink2,
    'editorCursor.foreground': a,
    'editor.selectionBackground': alpha(a, 0.28),
    'editor.inactiveSelectionBackground': alpha(a, 0.14),
    'editor.selectionHighlightBackground': alpha(a, 0.12),
    'editor.wordHighlightBackground': alpha(P.ink, 0.07),
    'editor.wordHighlightStrongBackground': alpha(a, 0.14),
    'editor.findMatchBackground': alpha(P.think, 0.35),
    'editor.findMatchHighlightBackground': alpha(P.think, 0.15),
    'editor.lineHighlightBackground': '#ffffff06',
    'editor.lineHighlightBorder': '#00000000',
    'editorIndentGuide.background1': P.hair,
    'editorIndentGuide.activeBackground1': P.hair2,
    'editorWhitespace.foreground': P.hair2,
    'editorBracketHighlight.foreground1': P.ink2,
    'editorBracketHighlight.foreground2': aSoft,
    'editorBracketHighlight.foreground3': '#7fd7c4',
    'editorBracketHighlight.unexpectedBracket.foreground': P.need,
    'editorBracketMatch.background': alpha(a, 0.14),
    'editorBracketMatch.border': alpha(a, 0.4),
    'editorGutter.addedBackground': P.work,
    'editorGutter.modifiedBackground': a,
    'editorGutter.deletedBackground': P.need,
    'editorError.foreground': P.need,
    'editorWarning.foreground': P.think,
    'editorInfo.foreground': aSoft,
    'editorWidget.background': P.raise,
    'editorWidget.border': P.hair2,
    'editorSuggestWidget.background': P.raise,
    'editorSuggestWidget.border': P.hair2,
    'editorSuggestWidget.selectedBackground': alpha(a, 0.16),
    'editorSuggestWidget.highlightForeground': aSoft,
    'editorHoverWidget.background': P.raise,
    'editorHoverWidget.border': P.hair2,
    'editorGroupHeader.tabsBackground': P.nav,
    'editorGroupHeader.tabsBorder': P.hair,
    'editorGroup.border': P.hair,
    'tab.activeBackground': P.bg,
    'tab.activeForeground': P.ink,
    'tab.activeBorderTop': a,
    'tab.inactiveBackground': P.nav,
    'tab.inactiveForeground': P.ink3,
    'tab.hoverBackground': P.raise,
    'tab.border': P.hair,
    'breadcrumb.foreground': P.ink3,
    'breadcrumb.focusForeground': P.ink,
    'breadcrumbPicker.background': P.raise,
    'scrollbarSlider.background': '#94a3b81f',
    'scrollbarSlider.hoverBackground': '#94a3b833',
    'scrollbarSlider.activeBackground': alpha(a, 0.4),
    'minimap.background': P.bg,
    'diffEditor.insertedTextBackground': alpha(P.work, 0.14),
    'diffEditor.removedTextBackground': alpha(P.need, 0.14),
    'diffEditor.insertedLineBackground': alpha(P.work, 0.07),
    'diffEditor.removedLineBackground': alpha(P.need, 0.07),
    // panels, inputs, buttons, menus, the terminal
    'panel.background': P.nav,
    'panel.border': P.hair2,
    'panelTitle.activeBorder': a,
    'panelTitle.activeForeground': P.ink,
    'panelTitle.inactiveForeground': P.ink3,
    'input.background': P.raise,
    'input.border': P.hair2,
    'input.foreground': P.ink,
    'input.placeholderForeground': P.ink4,
    'inputOption.activeBorder': a,
    'inputOption.activeBackground': alpha(a, 0.2),
    'dropdown.background': P.raise,
    'dropdown.border': P.hair2,
    'button.background': alpha(a, 0.85),
    'button.foreground': '#ffffff',
    'button.hoverBackground': a,
    'button.secondaryBackground': P.raise2,
    'button.secondaryForeground': P.ink,
    'badge.background': alpha(a, 0.3),
    'badge.foreground': P.ink,
    'progressBar.background': a,
    'menu.background': P.raise,
    'menu.border': P.hair2,
    'menu.selectionBackground': alpha(a, 0.18),
    'menu.separatorBackground': P.hair2,
    'quickInput.background': P.raise,
    'quickInputList.focusBackground': alpha(a, 0.16),
    'pickerGroup.foreground': aSoft,
    'pickerGroup.border': P.hair2,
    'notifications.background': P.raise,
    'notifications.border': P.hair2,
    'notificationCenterHeader.background': P.raise2,
    'terminal.background': P.bg,
    'terminal.foreground': P.ink,
    'terminalCursor.foreground': a,
    'terminal.selectionBackground': alpha(a, 0.3),
    'terminal.ansiBlack': '#1b212c',
    'terminal.ansiRed': P.need,
    'terminal.ansiGreen': P.work,
    'terminal.ansiYellow': P.think,
    'terminal.ansiBlue': '#7aa8ff',
    'terminal.ansiMagenta': '#c9a2ff',
    'terminal.ansiCyan': '#6fd3e0',
    'terminal.ansiWhite': P.ink2,
    'terminal.ansiBrightBlack': P.ink4,
    'terminal.ansiBrightRed': '#ff8c8c',
    'terminal.ansiBrightGreen': '#6ff0b5',
    'terminal.ansiBrightYellow': '#ffd87a',
    'terminal.ansiBrightBlue': '#a3c2ff',
    'terminal.ansiBrightMagenta': '#ddc2ff',
    'terminal.ansiBrightCyan': '#9be6ef',
    'terminal.ansiBrightWhite': P.ink,
    'gitDecoration.modifiedResourceForeground': aSoft,
    'gitDecoration.addedResourceForeground': P.work,
    'gitDecoration.untrackedResourceForeground': P.work,
    'gitDecoration.deletedResourceForeground': P.need,
    'gitDecoration.ignoredResourceForeground': P.ink4,
    'gitDecoration.conflictingResourceForeground': P.think,
    'peekView.border': a,
    'peekViewEditor.background': P.raise,
    'peekViewResult.background': P.nav,
    'peekViewTitle.background': P.raise2,
  };
  // the code itself: calm, Cora's hues; keywords take your colour
  const kw = mix(a, '#ffffff', 0.25);
  const tok = (scope: string | string[], foreground: string, fontStyle?: string) => ({ scope, settings: { foreground, ...(fontStyle ? { fontStyle } : {}) } });
  const tokenColors = [
    tok(['comment', 'punctuation.definition.comment'], P.ink3, 'italic'),
    tok(['keyword', 'storage', 'storage.type', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression'], kw),
    tok(['string', 'string.template', 'punctuation.definition.string'], '#a5e3b4'),
    tok(['constant.numeric', 'constant.language', 'constant.character', 'support.constant'], P.think),
    tok(['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], '#8ab4ff'),
    tok(['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'entity.other.inherited-class'], '#7fd7c4'),
    tok(['variable', 'variable.other.readwrite'], P.ink),
    tok(['variable.parameter'], '#d8dee8', 'italic'),
    tok(['variable.other.property', 'variable.other.object.property', 'meta.object-literal.key', 'support.type.property-name'], '#c3ccd8'),
    tok(['keyword.operator', 'punctuation', 'meta.brace'], P.ink2),
    tok(['entity.name.tag', 'meta.tag.sgml'], '#ff8fa3'),
    tok(['entity.other.attribute-name'], P.think),
    tok(['markup.heading', 'markup.heading entity.name'], P.ink, 'bold'),
    tok(['markup.bold'], P.ink, 'bold'),
    tok(['markup.italic'], P.ink, 'italic'),
    tok(['markup.inline.raw', 'markup.fenced_code'], '#a5e3b4'),
    tok(['markup.underline.link'], mix(a, '#ffffff', 0.35)),
    tok(['invalid'], P.need),
  ];
  return { name: 'Cora', type: 'dark', colors, tokenColors, semanticHighlighting: true };
}

/** The settings Cora's VS Code starts with (its machine's): its theme always; the rest only where you haven't set them. */
export const IDE_DEFAULTS: Record<string, unknown> = {
  'editor.minimap.enabled': false,
  'editor.fontFamily': "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  'editor.fontSize': 13,
  'editor.lineHeight': 1.6,
  'editor.cursorBlinking': 'smooth',
  'editor.smoothScrolling': true,
  'editor.renderLineHighlight': 'gutter',
  'workbench.list.smoothScrolling': true,
  'terminal.integrated.fontFamily': "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  'terminal.integrated.fontSize': 12.5,
  'window.title': 'Cora · ${rootName}${separator}${activeEditorShort}',
  ...(process.platform === 'win32' ? { 'terminal.integrated.defaultProfile.windows': 'PowerShell' } : {}),
};

/**
 * VS Code takes some settings only from your own settings (the app-wide ones), not from the machine's: the extension
 * sets these the first time (only where you haven't), keeps Cora's theme on, and closes the chat side bar once. The
 * trust prompt going off needs one reload.
 */
export const APP_DEFAULTS: Record<string, unknown> = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'chat.commandCenter.enabled': false,
  'workbench.tips.enabled': false,
  'telemetry.telemetryLevel': 'off',
};


/** VS Code's settings files may have comments: read what's there (comments dropped), or nothing. */
function readSettings(file: string): Record<string, unknown> {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1');
    const v = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Before VS Code starts: the Cora extension (its theme, in your colour) in its extensions folder, and its settings
 * (Cora's theme always; the defaults where you haven't set something else).
 */
export function prepareIde(serverDataDir: string, accent: string, bridge?: { url: string; token: string }): void {
  const ext = join(serverDataDir, 'extensions', 'cora.cora-0.1.0');
  mkdirSync(join(ext, 'themes'), { recursive: true });
  writeFileAtomic(
    join(ext, 'package.json'),
    JSON.stringify(
      {
        name: 'cora',
        publisher: 'cora',
        version: '0.1.0',
        displayName: 'Cora',
        description: "Cora's colours and settings for the IDE panel",
        engines: { vscode: '^1.80.0' },
        categories: ['Themes'],
        main: './extension.js',
        activationEvents: ['onStartupFinished'],
        // it only sets settings: fine in a folder VS Code hasn't been told to trust yet
        capabilities: { untrustedWorkspaces: { supported: true }, virtualWorkspaces: true },
        contributes: { themes: [{ label: 'Cora', uiTheme: 'vs-dark', path: './themes/cora.json' }], ...EXTENSION_CONTRIBUTES },
      },
      null,
      2,
    ),
  );
  writeFileAtomic(join(ext, 'extension.js'), EXTENSION_JS(APP_DEFAULTS));
  // where it reaches Cora, its token (only yours to read), and your colour (its marks)
  writeFileAtomic(join(ext, 'bridge.json'), JSON.stringify({ ...(bridge ?? {}), accent: hex(accent) }), { mode: 0o600 });
  writeFileAtomic(join(ext, 'themes', 'cora.json'), JSON.stringify(coraTheme(accent), null, 2));
  const machine = join(serverDataDir, 'data', 'Machine');
  mkdirSync(machine, { recursive: true });
  const file = join(machine, 'settings.json');
  const cur = existsSync(file) ? readSettings(file) : {};
  writeFileAtomic(file, JSON.stringify({ ...IDE_DEFAULTS, ...cur, 'workbench.colorTheme': 'Cora' }, null, 2));
}
