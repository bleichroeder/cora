/**
 * Your Claude plan's usage, as Claude Code's /usage shows it: each limit (the current session's five hours, the week,
 * a model's week) with how much is used and when it resets, and extra usage. Read by the server from the endpoint
 * Claude Code itself uses, with the login Claude Code keeps (accountUsage.ts); the dashboard shows it on the session's
 * usage card, in a fuller view, and as a board panel.
 */

export type UsageLimit = {
  /** e.g. "session", "weekly_all", "weekly_scoped" */
  kind: string;
  /** as /usage words it: "Current session", "This week · all models", "This week · Opus" */
  label: string;
  /** 0–100 */
  percent: number;
  /** "normal", "warning", "critical"… as the endpoint says */
  severity?: string;
  resetsAt?: number;
};
export type AccountUsage = {
  /** ok: read; none: no Claude login here to read with; expired: the login needs Claude Code to run once; error: the read failed */
  state: 'ok' | 'none' | 'expired' | 'error';
  at: number;
  limits: UsageLimit[];
  /** extra usage (pay as you go past the limits), in the currency's units */
  extra?: { used: number; limit: number; currency: string; percent: number } | null;
  /** the plan, e.g. "max" */
  plan?: string;
  message?: string;
};

const LABELS: Record<string, string> = { session: 'Current session', weekly_all: 'This week · all models', weekly_scoped: 'This week' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const when = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The endpoint's answer as the limits worth showing (in its order), and extra usage. Unknown shapes give no limits. */
export function normalizeUsage(raw: unknown, now: number, plan?: string): AccountUsage {
  const j = (raw ?? {}) as Record<string, any>;
  const limits: UsageLimit[] = [];
  if (Array.isArray(j.limits)) {
    for (const l of j.limits) {
      const percent = num(l?.percent);
      if (percent == null || typeof l?.kind !== 'string') continue;
      // a model's own week: shown once it's in use (0% scoped limits are noise)
      if (l.kind === 'weekly_scoped' && !percent) continue;
      const scope = typeof l.scope === 'string' ? l.scope : (l.scope?.name ?? l.scope?.model ?? null);
      const label = l.kind === 'weekly_scoped' && scope ? `This week · ${cap(String(scope))}` : (LABELS[l.kind] ?? cap(l.kind.replace(/_/g, ' ')));
      limits.push({ kind: l.kind, label, percent, ...(typeof l.severity === 'string' ? { severity: l.severity } : {}), ...(when(l.resets_at) ? { resetsAt: when(l.resets_at) } : {}) });
    }
  } else {
    // the older shape: one object per window
    const win = (k: string, label: string) => {
      const u = num(j[k]?.utilization);
      if (u != null) limits.push({ kind: k, label, percent: u, ...(when(j[k]?.resets_at) ? { resetsAt: when(j[k]?.resets_at) } : {}) });
    };
    win('five_hour', LABELS.session);
    win('seven_day', LABELS.weekly_all);
    win('seven_day_opus', 'This week · Opus');
    win('seven_day_sonnet', 'This week · Sonnet');
  }
  const x = j.extra_usage;
  const places = num(x?.decimal_places) ?? 2;
  const extra =
    x?.is_enabled && num(x.monthly_limit) != null && num(x.used_credits) != null
      ? { used: x.used_credits / 10 ** places, limit: x.monthly_limit / 10 ** places, currency: typeof x.currency === 'string' ? x.currency : 'USD', percent: num(x.utilization) ?? (x.monthly_limit ? (100 * x.used_credits) / x.monthly_limit : 0) }
      : null;
  return { state: 'ok', at: now, limits, extra, ...(plan ? { plan } : {}) };
}
