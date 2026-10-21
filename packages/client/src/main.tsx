import { useSetup } from './state/setup';
import { useVoice } from './lib/voice';
import { useWake } from './lib/wake/controller';
import { applyJira, useJiraWatch } from './state/jiraWatch';
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

if (import.meta.env.DEV) Object.assign(window as any, { __brain: useBrain, __orch: useOrch, __slack: useSlack, __jira: { useJiraWatch, applyJira }, __voice: useVoice, __wake: useWake, __setup: useSetup });

// quick capture's own window (Ctrl+Alt+N): just the box, no socket
const capture = new URLSearchParams(location.search).has('capture');
createRoot(document.getElementById('root')!).render(<Boundary name="app">{capture ? <Capture /> : <App />}</Boundary>);
