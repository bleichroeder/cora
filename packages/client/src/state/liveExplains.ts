import { create } from 'zustand';
import type { ExplainDataMsg } from '@cora/shared';

/**
 * Live explains' newest data, by session and explain: it
 * comes over the WebSocket as the session writes it; the viewer asks for it when it opens one.
 */
export const useLiveData = create<Record<string, unknown>>(() => ({}));
export const liveKey = (sessionId: string, slug: string) => `${sessionId}/${slug}`;

export function applyExplainData(m: ExplainDataMsg): void {
  useLiveData.setState({ [liveKey(m.sessionId, m.slug)]: m.data });
}

export async function loadLiveData(sessionId: string, slug: string): Promise<void> {
  const r = await fetch(`/api/explains/live/${encodeURIComponent(sessionId)}/${encodeURIComponent(slug)}/data`).catch(() => null);
  if (!r?.ok) return;
  const { data } = (await r.json()) as { data: unknown };
  // what came over the socket meanwhile is newer
  if (data != null && !(liveKey(sessionId, slug) in useLiveData.getState())) useLiveData.setState({ [liveKey(sessionId, slug)]: data });
}
