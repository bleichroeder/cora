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

/** A colour as Slack's nearest coloured-circle emoji (a session's icon when it posts as itself). */
export function colorEmoji(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return ':large_blue_circle:';
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 0.08) return max > 0.6 ? ':white_circle:' : ':black_circle:';
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 335) return ':red_circle:';
  if (h < 45) return ':large_orange_circle:';
  if (h < 70) return ':large_yellow_circle:';
  if (h < 165) return ':large_green_circle:';
  if (h < 255) return ':large_blue_circle:';
  return ':large_purple_circle:';
}
