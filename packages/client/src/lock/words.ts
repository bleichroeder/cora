/** The lock screen's words: when it locked, the time, how long until the next try. */
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export function lockedLine(lockedAt: number | null, now = new Date()): string {
  if (!lockedAt) return 'Cora is keeping watch. Your sessions keep running.';
  const at = new Date(lockedAt);
  const day = at.toDateString() === now.toDateString() ? '' : ` ${at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })},`;
  return `Locked at${day} ${time(at)}. Cora is keeping watch.`;
}

export function clockLine(d: Date): string {
  return `${time(d)} · ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

export function waitLine(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `Too many tries. Try again in ${s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`}.`;
}
