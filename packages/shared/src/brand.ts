/**
 * The app's name, and what it was called before (agent-brain). Old names stay accepted wherever data or running
 * sessions still carry them: hooks already in ~/.claude/settings.json, hosted sessions started before the rename,
 * and explains recorded under the old tool name.
 */
export const APP_NAME = 'Cora';
/** Cora's colour, yours to pick (its eye, its cards, the app's icon): teal unless you choose another. */
export const CORA_COLORS: ReadonlyArray<readonly [string, string]> = [
  ['#2dd4bf', 'Teal'],
  ['#38bdf8', 'Sky'],
  ['#a78bfa', 'Violet'],
  ['#f472b6', 'Pink'],
  ['#fb7185', 'Rose'],
  ['#fb923c', 'Orange'],
  ['#fbbf24', 'Amber'],
  ['#4ade80', 'Green'],
];
export const DEFAULT_CORA_COLOR = '#2dd4bf';
export const isCoraColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
/** Header carrying the hook token (hooks, the MCP endpoint, the desktop app's local calls). */
export const TOKEN_HEADER = 'x-cora-token';
export const LEGACY_TOKEN_HEADER = 'x-agent-brain-token';
/** Cora's own agent proves it's Cora with this (its own key, only in its own MCP config) */
export const AGENT_HEADER = 'x-cora-agent';
/** The MCP server sessions launched here get, and its `present` tool (explains). */
export const MCP_SERVER = 'cora';
export const PRESENT_TOOL = 'mcp__cora__present';
export const LEGACY_PRESENT_TOOL = 'mcp__agent-brain__present';
export const PRESENT_TOOLS = [PRESENT_TOOL, LEGACY_PRESENT_TOOL] as const;
export const isPresentTool = (name?: string | null) => name === PRESENT_TOOL || name === LEGACY_PRESENT_TOOL;
/** Opens a web page for the user in this session's tabs of Cora's browser. */
export const OPEN_TAB_TOOL = 'mcp__cora__open_tab';
/** Says a short spoken summary to the user (voice "summaries" reading mode). */
export const SPEAK_TOOL = 'mcp__cora__speak';
/** Which of the user's environments (their VPNs) is reachable right now: read-only, for every session. */
export const ENV_TOOL = 'mcp__cora__environment';
/** What each environment runs, newest builds, a ticket's journey: read-only, for every session. */
export const DEPLOYS_TOOL = 'mcp__cora__deploys';

/** What Cora answers to /api/hello?n=<nonce>: proof it holds Cora's key, without sending it (audit S17). */
export const HELLO_PREFIX = 'cora-hello:';
