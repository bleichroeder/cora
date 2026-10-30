/** Main-agent colours: one per session, picked by the user or derived from the session id. */
export const MAIN_COLORS = ['#38bdf8', '#2dd4bf', '#a3e635', '#fb7185', '#a78bfa', '#60a5fa', '#f0abfc', '#fdba74'];
export const MAIN_COLOR = '#38bdf8';

export function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MAIN_COLORS[Math.abs(h) % MAIN_COLORS.length];
}

/** A session's colour: the one you picked, else one from its id (the same everywhere: the nav, its orb, its banner). */
export const sessionColorOf = (s?: { id: string; color?: string | null } | null): string => s?.color || (s ? hashColor(s.id) : MAIN_COLOR);
