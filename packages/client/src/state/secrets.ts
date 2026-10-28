import { create } from 'zustand';
import type { SecretInfo, SecretScope, SecretsMsg } from '@cora/shared';

/** Cora's Secrets tool (in Tools, beside Notes and the Browser). */
export const SECRETS_ID = 'cora:secrets';

/** Cora Secrets as the dashboard knows them: names, notes, who may use them; never a value (Reveal asks for one). */
export const useSecrets = create<{ list: SecretInfo[] | null; apply(m: SecretsMsg): void; load(): Promise<void> }>((set) => ({
  list: null,
  apply: (m) => set({ list: m.list }),
  async load() {
    const r = await fetch('/api/secrets').catch(() => null);
    const j = r?.ok ? ((await r.json()) as { list: SecretInfo[] }) : null;
    if (j) set({ list: j.list });
  },
}));

const json = { 'content-type': 'application/json' };
/** Add one, or change one (a new value only when given): the server's error, if any. */
export async function saveSecret(o: { name: string; value?: string; note?: string; scope?: SecretScope }): Promise<string | null> {
  const r = await fetch('/api/secrets', { method: 'POST', headers: json, body: JSON.stringify(o) }).catch(() => null);
  if (!r) return "Cora didn't answer";
  return r.ok ? null : (((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'failed');
}
export async function removeSecret(name: string): Promise<boolean> {
  const r = await fetch(`/api/secrets/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => null);
  return !!r?.ok;
}
/** Its value, for you (Reveal, Copy). */
export async function revealSecret(name: string): Promise<string | null> {
  const r = await fetch(`/api/secrets/${encodeURIComponent(name)}/reveal`, { method: 'POST' }).catch(() => null);
  return r?.ok ? (((await r.json()) as { value: string }).value ?? null) : null;
}
