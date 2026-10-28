import { create } from 'zustand';
import type { WorktreeRepo, WorktreesMsg } from '@cora/shared';

/** Your repos' worktrees (pushed by the server; asking for them keeps them fresh while Cora's board shows them). */
export const useWorktrees = create<{ repos: WorktreeRepo[] | null; error: string | null; apply(m: WorktreesMsg): void; load(): Promise<void> }>((set) => ({
  repos: null,
  error: null,
  apply: (m) => set({ repos: m.repos, error: null }),
  async load() {
    const r = await fetch('/api/worktrees').catch(() => null);
    if (!r) return set({ error: "Cora's server didn't answer." });
    // a server from before worktrees (the page is newer than the server running): say so, don't wait forever
    if (r.status === 404) return set({ error: 'This Cora is older than its page: restart Cora to see your worktrees.' });
    const j = r.ok ? ((await r.json().catch(() => null)) as { repos: WorktreeRepo[] } | null) : null;
    set(j ? { repos: j.repos, error: null } : { error: `Couldn't read them (${r.status}).` });
  },
}));

/** Remove a worktree (and its branch when git sees it merged): what the server said. */
export async function removeWorktree(path: string): Promise<{ ok: boolean; why?: string; branchKept?: string }> {
  const r = await fetch('/api/worktrees/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, deleteBranch: true }) }).catch(() => null);
  return r ? ((await r.json().catch(() => ({ ok: false, why: 'failed' }))) as { ok: boolean; why?: string }) : { ok: false, why: "Cora didn't answer" };
}
