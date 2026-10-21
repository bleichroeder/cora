import type { Family, IconRef } from './types';

export const FAM: Record<Family, { c: string; label: string }> = {
  look: { c: '#60a5fa', label: 'Look' },
  change: { c: '#34d399', label: 'Change' },
  run: { c: '#fb923c', label: 'Run' },
  web: { c: '#22d3ee', label: 'Web' },
  delegate: { c: '#e879f9', label: 'Delegate' },
  mcp: { c: '#a78bfa', label: 'Integrations (MCP)' },
  plan: { c: '#facc15', label: 'Plan' },
  human: { c: '#f87171', label: 'Needs you · problems' },
  mind: { c: '#94a3b8', label: 'Mind' },
};

const ic = (name: string, family: Family): IconRef => ({ name, family });

export const TOOL_ICON: Record<string, IconRef> = {
  Read: ic('FileText', 'look'),
  Glob: ic('FolderSearch', 'look'),
  Grep: ic('TextSearch', 'look'),
  LS: ic('FolderOpen', 'look'),
  Edit: ic('FilePen', 'change'),
  MultiEdit: ic('FilePen', 'change'),
  Write: ic('FilePlus', 'change'),
  NotebookEdit: ic('NotebookPen', 'change'),
  Bash: ic('SquareTerminal', 'run'),
  PowerShell: ic('SquareTerminal', 'run'),
  Monitor: ic('Activity', 'run'),
  WebFetch: ic('Globe', 'web'),
  WebSearch: ic('Search', 'web'),
  Agent: ic('GitFork', 'delegate'),
  Task: ic('GitFork', 'delegate'),
  SendMessage: ic('Send', 'delegate'),
  TodoWrite: ic('ListChecks', 'plan'),
  TaskCreate: ic('ListChecks', 'plan'),
  TaskUpdate: ic('ListChecks', 'plan'),
  EnterPlanMode: ic('Map', 'plan'),
  ExitPlanMode: ic('Map', 'plan'),
  Skill: ic('Sparkles', 'plan'),
  AskUserQuestion: ic('MessageCircleQuestion', 'human'),
  'mcp__cora__present': ic('Presentation', 'plan'),
  'mcp__cora__open_tab': ic('AppWindow', 'web'),
  'mcp__cora__speak': ic('Volume2', 'mind'),
  'mcp__agent-brain__present': ic('Presentation', 'plan'),
};

export const EVENT_ICON = {
  spawn: ic('GitFork', 'delegate'),
  report: ic('Flag', 'delegate'),
  fail: ic('TriangleAlert', 'human'),
  permission: ic('ShieldAlert', 'human'),
  question: ic('MessageCircleQuestion', 'human'),
  elicitation: ic('ShieldAlert', 'human'),
  prompt: ic('User', 'human'),
  think: ic('Brain', 'mind'),
  say: ic('MessageSquareText', 'mind'),
  compact: ic('Archive', 'mind'),
  turn_end: ic('CircleCheck', 'mind'),
  session_start: ic('Play', 'mind'),
  session_end: ic('Square', 'mind'),
  interrupt: ic('OctagonX', 'mind'),
  task: ic('Timer', 'run'),
} satisfies Record<string, IconRef>;

export const EVENT_LABEL: Record<keyof typeof EVENT_ICON, string> = {
  spawn: 'spawned subagent',
  report: 'subagent report',
  fail: 'tool call failed',
  permission: 'waiting on permission',
  question: 'question for you',
  elicitation: 'MCP server needs input',
  prompt: 'your prompt',
  think: 'thinking (content hidden)',
  say: 'narration',
  compact: 'context compacted',
  turn_end: 'turn finished',
  session_start: 'session started',
  session_end: 'session ended',
  interrupt: 'interrupted',
  task: 'background task finished',
};

const SUB_ICONS: Array<[RegExp, string]> = [
  [/(^|[\s;&|(])git\s/, 'GitBranch'],
  [/(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(run\s+)?test\b|npx\s+(vitest|jest|playwright\s+test)|vitest\b|jest\b|pytest\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b)/, 'FlaskConical'],
  [/(^|[\s;&|(])((npm|pnpm|bun)\s+(i|install|add|ci)\b|yarn\s+(add|install)\b|pip3?\s+install\b|uv\s+(add|pip\s+install)\b|cargo\s+add\b|go\s+get\b|winget\s+install\b|choco\s+install\b)/, 'Package'],
  [/(^|[\s;&|(])(kubectl|docker|helm|podman|k9s)\b/, 'Container'],
];

export function bashSubIcon(command: string): string {
  const cmd = ` ${command}`;
  for (const [re, name] of SUB_ICONS) if (re.test(cmd)) return name;
  return 'SquareTerminal';
}

export function iconFor(toolName: string, input?: unknown): IconRef {
  if ((toolName === 'Bash' || toolName === 'PowerShell') && input && typeof (input as any).command === 'string') {
    return ic(bashSubIcon((input as any).command), 'run');
  }
  const known = TOOL_ICON[toolName];
  if (known) return known;
  if (toolName.startsWith('mcp__')) return ic('Plug', 'mcp');
  return ic('Wrench', 'run');
}

/** "mcp__server__tool" → "server · tool" */
export function shortToolName(name: string): string {
  return name.startsWith('mcp__') ? name.split('__').slice(1).join(' · ') : name;
}
