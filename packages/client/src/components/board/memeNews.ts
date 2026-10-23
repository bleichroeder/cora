import { create } from 'zustand';

/** Posts to each session's Meme panel, counted as the server tells them (however they were made): its panel looks again. */
export const useMemeNews = create<{ by: Record<string, number> }>(() => ({ by: {} }));
export const memePosted = (sessionId: string) => useMemeNews.setState((s) => ({ by: { ...s.by, [sessionId]: (s.by[sessionId] ?? 0) + 1 } }));
