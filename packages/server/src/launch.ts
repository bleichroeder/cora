import { EFFORTS, PERMISSION_MODES, type LaunchOptions, type LaunchPreset } from '@cora/shared';

const MODEL = /^[A-Za-z0-9._-]+(\[[A-Za-z0-9]+\])?$/;

/** Validate launch options (they become `claude` arguments); throws a user-facing message on a bad value. */
export function checkOptions(o: unknown): LaunchOptions {
  if (o == null) return {};
  if (typeof o !== 'object') throw new Error('options must be an object');
  const { model, effort, permissionMode } = o as Record<string, unknown>;
  const out: LaunchOptions = {};
  if (model != null && model !== '') {
    if (typeof model !== 'string' || model.length > 80 || !MODEL.test(model)) throw new Error('model must look like "opus", "sonnet" or "claude-opus-5-5[1m]"');
    out.model = model;
  }
  if (effort != null && effort !== '') {
    if (!EFFORTS.includes(effort as never)) throw new Error(`effort must be one of ${EFFORTS.join(', ')}`);
    out.effort = effort as LaunchOptions['effort'];
  }
  if (permissionMode != null && permissionMode !== '') {
    if (!PERMISSION_MODES.includes(permissionMode as never)) throw new Error(`permissionMode must be one of ${PERMISSION_MODES.join(', ')}`);
    out.permissionMode = permissionMode as LaunchOptions['permissionMode'];
  }
  return out;
}

/**
 * A new session's first prompt, e.g. "/jira ACME-5206" (Claude Code's positional prompt: it starts working on it at
 * once). It becomes one argv element, never shell text, but the Windows fallback runs claude through cmd.exe, so
 * it's held to a short line of plain characters: no quotes, %, ^, &, |, <, >, and nothing that reads as an option.
 */
const PROMPT = /^[A-Za-z0-9/][A-Za-z0-9 ._:/@#,+=-]*$/;
export function checkPrompt(p: unknown): string | undefined {
  if (p == null || p === '') return undefined;
  if (typeof p !== 'string') throw new Error('prompt must be a string');
  const t = p.trim();
  if (!t || t.length > 200 || !PROMPT.test(t)) throw new Error('prompt must be one short line of letters, digits, spaces and / . _ : @ # , + = -');
  return t;
}

/** The `claude` arguments for validated options. */
export function launchArgs(o: LaunchOptions): string[] {
  return [
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
  ];
}

/** Validate a saved preset list. */
export function checkPresets(list: unknown): LaunchPreset[] {
  if (!Array.isArray(list)) throw new Error('presets must be a list');
  if (list.length > 30) throw new Error('at most 30 presets');
  const ids = new Set<string>();
  return list.map((p) => {
    if (!p || typeof p !== 'object') throw new Error('each preset must be an object');
    const { id, name, cwd } = p as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[\w-]{1,40}$/.test(id) || ids.has(id)) throw new Error('each preset needs a unique id');
    ids.add(id);
    if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new Error('preset names must be 1–40 characters');
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 500) throw new Error('each preset needs a folder');
    return { id, name: name.trim(), cwd, ...checkOptions(p) };
  });
}
