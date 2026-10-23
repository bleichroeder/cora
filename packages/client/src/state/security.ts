import { create } from 'zustand';
import { securityLevel, urgentFindings, type SecurityMsg, type SecurityReport } from '@cora/shared';
import { attentive, desktop } from '../lib/desktop';

/** The server's security check: is what Cora runs on still getting security fixes? */
export const useSecurity = create<{ report: SecurityReport | null }>(() => ({ report: null }));

const SEEN = 'ab:security-seen';

/** A report from the server; something newly worrying is a notification (once per finding set). */
export function applySecurity(m: SecurityMsg): void {
  useSecurity.setState({ report: m.report });
  const r = m.report;
  if (!r || r.checking || securityLevel(r) !== 'high') return;
  const key = worryKey(r);
  try {
    if (localStorage.getItem(SEEN) === key) return;
    localStorage.setItem(SEEN, key);
  } catch {
    /* tell anyway */
  }
  if (!attentive()) desktop?.notify('Cora: security updates needed', worrySummary(r), '');
}

/** What's worrying, as a key (the same findings aren't told twice). */
function worryKey(r: SecurityReport): string {
  return [r.electron && !r.electron.supported ? `e${r.electron.installed}` : '', r.node?.securityBehind || r.node?.ended ? `n${r.node.version}` : '', ...urgentFindings(r).map((f) => f.name)].join('|');
}

export function worrySummary(r: SecurityReport): string {
  const parts: string[] = [];
  if (r.electron && !r.electron.supported) parts.push(`Electron ${r.electron.installed} no longer gets security fixes`);
  if (r.node?.ended) parts.push(`Node ${r.node.version} is past its end of life`);
  else if (r.node?.securityBehind) parts.push(`Node ${r.node.version} is missing security releases`);
  const urgent = urgentFindings(r).length;
  if (urgent) parts.push(`${urgent} package${urgent > 1 ? 's' : ''} Cora runs with high-severity vulnerabilities`);
  return parts.join('; ') || 'See Settings → Updates & security.';
}

export async function checkSecurity(): Promise<string | null> {
  const r = await fetch('/api/security/check', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return j.error ?? `HTTP ${r.status}`;
  useSecurity.setState({ report: j.report });
  return null;
}
