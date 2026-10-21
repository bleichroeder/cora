import { useEffect } from 'react';
import { ciRef, ciRepoName, failedStage } from '@cora/shared';
import { useCi } from '../state/ci';
import { useBrain } from '../state/store';
import { attentive, desktop } from './desktop';
import { speak, useVoice } from './voice';
import { ciAnnouncement, ciLabel, finishesToTell } from './ci';

/**
 * A followed pipeline finished: Cora says so (Settings → Voice → "a pipeline finishes"), and the desktop app shows a
 * notification when you're elsewhere. Only finishes seen happening (not ones already over when the app opened), once
 * per pipeline however many sessions follow it, and only pipelines worth telling (see worthTelling).
 */
export function useCiAlerts(): void {
  useEffect(() => {
    const told = new Set<string>();
    return useCi.subscribe((st, prev) => {
      if (st.pipelines === prev.pipelines) return;
      for (const { p, sessionId: sid } of finishesToTell(prev.pipelines, st.pipelines, st.links, useBrain.getState().focus, told)) {
        const v = useVoice.getState();
        if (v.settings.enabled && v.key?.set && v.settings.announcePipelines !== false && v.ptt.phase === 'idle') void speak(`ci:${p.key}`, ciAnnouncement(p), 400, true);
        if (desktop && useBrain.getState().prefs.notifyPipelines !== false && !attentive()) {
          const fs = failedStage(p.stages);
          desktop.notify(`Pipeline ${ciLabel(p.status)} · ${ciRepoName(p.project)}`, `#${p.id} on ${ciRef(p.ref)}${fs ? ` failed at ${fs.name}` : ''}`, sid);
        }
      }
    });
  }, []);
}
