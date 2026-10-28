/**
 * The Board's layouts for kinds of work (Investigating, Coding, Reviewing, Shipping, Writing): a page of panels laid out
 * for it. You add one from + Panel; a session can add one as its work moves on (its `board` tool), when you let it.
 */
export const BOARD_LAYOUTS = ['investigating', 'coding', 'reviewing', 'shipping', 'writing'] as const;
export type BoardLayoutId = (typeof BOARD_LAYOUTS)[number];

export const BOARD_LAYOUT_INFO: Record<BoardLayoutId, { name: string; icon: string; hint: string }> = {
  investigating: { name: 'Investigating', icon: 'Search', hint: 'The Spotlight, browser, what it touches, terminal' },
  coding: { name: 'Coding', icon: 'Code', hint: 'IDE, terminal, the Spotlight, tests' },
  reviewing: { name: 'Reviewing', icon: 'FileDiff', hint: 'IDE large, the Spotlight, changes, the ticket' },
  shipping: { name: 'Shipping', icon: 'Rocket', hint: 'Pipeline & MR, deploys, the Spotlight, ticket' },
  writing: { name: 'Writing', icon: 'FileText', hint: 'Explains, the Spotlight, notes' },
};

/**
 * Sessions and the Board (Settings › Sessions › Board): they can't change it; they can add a page laid out for what
 * they're doing now (you go to it yourself); or add it and show it.
 */
export const BOARD_PAGE_MODES = ['off', 'add', 'show'] as const;
export type BoardPageMode = (typeof BOARD_PAGE_MODES)[number];
