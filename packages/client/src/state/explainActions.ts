import { create } from 'zustand';
import { asksInCora, isKitPage, readAction, type ExplainAction } from '../lib/explainActions';
import { sendToSession } from './composer';
import { isGuest } from './live';
import { useWeb } from './web';

/** A press waiting on your answer (a page that isn't Cora's own): shown by ExplainAskHost. */
export const useExplainAsk = create<{ ask: { action: ExplainAction; answer(yes: boolean): void } | null }>(() => ({ ask: null }));

/** Ask in Cora (its own card, never the system's box); one at a time: a second while one is up is a no. */
const askInCora = (action: ExplainAction) =>
  new Promise<boolean>((resolve) => {
    if (useExplainAsk.getState().ask) return resolve(false);
    useExplainAsk.setState({ ask: { action, answer: (yes) => (useExplainAsk.setState({ ask: null }), resolve(yes)) } });
  });

/** one press at a time from a session's pages (a second while the first is being asked about or sent is dropped) */
const busy = new Set<string>();

/**
 * A message from an explain's page that may be a button press: acted on (lib/explainActions has the rules), and the
 * page told how it went. `content`: the page as shown, so Cora knows whether it is its own.
 */
export async function onExplainMessage(x: { sessionId: string; content: string }, data: unknown, reply: (m: { cora: 'action-result'; id: string; ok: boolean; note?: string }) => void): Promise<void> {
  const a = readAction(data);
  if (!a) return;
  const done = (ok: boolean, note?: string) => reply({ cora: 'action-result', id: a.id, ok, ...(note ? { note } : {}) });
  // someone watching your Cora: the buttons are yours
  if (isGuest()) return done(false, "Only the session's owner can press this");
  if (busy.has(x.sessionId)) return done(false, 'One at a time');
  busy.add(x.sessionId);
  try {
    if (asksInCora(await isKitPage(x.content)) && !(await askInCora(a))) return done(false, 'Not sent');
    if (a.url != null) {
      useWeb.getState().open(x.sessionId, a.url, { reload: true });
      useWeb.getState().setShown(x.sessionId, true);
      return done(true, 'Opened');
    }
    const r = await sendToSession(x.sessionId, a.prompt);
    done(r.ok, r.ok ? 'Sent' : r.error);
  } finally {
    busy.delete(x.sessionId);
  }
}
