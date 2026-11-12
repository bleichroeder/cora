import { create } from 'zustand';
import type { TabState } from '../components/WebPane';

/**
 * The sessions' Playwright tabs, as their pages are (AgentPages holds the pages; a session's browser shows them):
 * each page's loading, back, forward and icon, its web contents id once it's up, and the size it's drawn at.
 */
export const useAgentPages = create<{ state: Record<string, TabState>; wc: Record<string, number>; size: Record<string, { w: number; h: number }> }>(() => ({ state: {}, wc: {}, size: {} }));
