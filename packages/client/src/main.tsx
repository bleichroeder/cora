import { useSetup } from './state/setup';
import { desktop } from './lib/desktop';
import { useVoice } from './lib/voice';
import { useWake } from './lib/wake/controller';
import { applyJira, useJiraWatch } from './state/jiraWatch';
// first: a screen's own settings that follow you across devices go up as they're written (lib/synced)
import { beMirror, pullSynced, restartWithSynced, syncedSettled } from './lib/synced';
import { createRoot } from 'react-dom/client';
// the base styles first, so each part's own stylesheet (imported with it) wins ties
import '@fontsource-variable/figtree';
import '@fontsource-variable/jetbrains-mono';
import './design.css';
import './styles.css';
import { App } from './App';
import { useBrain } from './state/store';
import { useOrch } from './state/orchestrator';
import { useSlack } from './state/slack';
import { Boundary } from './components/Boundary';
import { Capture } from './components/Capture';
import { SlackBanner } from './components/SlackBanner';
import { SeatCover, useSeat } from './components/SeatCover';
import { loadLive, useLive } from './state/live';

if (import.meta.env.DEV) Object.assign(window as any, { __brain: useBrain, __orch: useOrch, __slack: useSlack, __jira: { useJiraWatch, applyJira }, __voice: useVoice, __wake: useWake, __setup: useSetup });

// away from the desktop app (an iPad's browser): iPadOS scrolls even a pinned page to show a focused text box, leaving
// a black band; put it straight back, and size the page to what's actually visible (toolbars, keyboard)
if (!desktop && typeof window !== 'undefined') {
  const pin = () => (window.scrollX || window.scrollY) && window.scrollTo(0, 0);
  window.addEventListener('scroll', pin, { passive: true });
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.documentElement.classList.add('vv');
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      pin();
    };
    vv.addEventListener('resize', fit);
    vv.addEventListener('scroll', fit);
    fit();
  }
}

// quick capture's own window (Ctrl+Alt+N): just the box, no socket
const capture = new URLSearchParams(location.search).has('capture');
// Cora's Slack banner, recorded out of sight by the desktop app (components/SlackBanner): just the picture, no socket
const banner = new URLSearchParams(location.search).has('banner');

/** Cora in use on another device: only the cover, from the first paint (nothing of Cora drawn behind it, ever). */
function Root() {
  const elsewhere = useSeat((s) => s.elsewhere);
  return elsewhere ? <SeatCover /> : <App />;
}

// where Cora is in use, asked before anything is drawn (signed out, or the server away: Cora's own screens handle it)
async function start(): Promise<void> {
  if (!capture && !banner) {
    // a guest in a share (or you, live): who this screen is, before anything is drawn
    await loadLive();
    const r = await fetch('/api/seat').catch(() => null);
    const j = r?.ok ? ((await r.json().catch(() => null)) as { here?: boolean; name?: string; pc?: boolean } | null) : null;
    if (j && j.here === false) useSeat.setState({ elsewhere: j.name ?? 'another device' });
    // in use here: your Cora's look (from your PC, or wherever you last changed it), before anything is drawn
    else if (j && useLive.getState().role !== 'guest') {
      if ((await pullSynced(!!j.pc)) && restartWithSynced()) return;
      syncedSettled();
    }
    // a guest in a share: the host's look (read only), so they see Cora as the host does
    if (useLive.getState().role === 'guest') {
      beMirror();
      // the host's look, now (read once more by the parts that already have)
      await pullSynced(false, true);
      useBrain.getState().reloadPrefs();
    }
  }
  createRoot(document.getElementById('root')!).render(<Boundary name="app">{banner ? <SlackBanner /> : capture ? <Capture /> : <Root />}</Boundary>);
}
void start();
