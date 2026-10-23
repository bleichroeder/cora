/**
 * Every page in Cora's browser (each profile's session runs this before the page's own scripts): Chrome's
 * `window.chrome` (app, csi, loadTimes), where Electron's is empty, so sign-in pages that check for it (Google's) see
 * Chrome. It runs in the page's own world and touches nothing else. See chromeIdentity.ts.
 */
import { contextBridge } from 'electron';

contextBridge.executeInMainWorld({
  func: () => {
    const c = ((window as unknown as { chrome?: Record<string, unknown> }).chrome ?? {}) as Record<string, unknown>;
    if (c.loadTimes) return;
    const t = performance.timeOrigin / 1000;
    c.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
      getDetails: () => null,
      getIsInstalled: () => false,
      runningState: () => 'cannot_run',
    };
    c.csi = () => ({ startE: Math.round(t * 1000), onloadT: Math.round(t * 1000 + performance.now()), pageT: performance.now(), tran: 15 });
    c.loadTimes = () => ({ requestTime: t, startLoadTime: t, commitLoadTime: t + 0.05, finishDocumentLoadTime: t + 0.2, finishLoadTime: t + 0.3, firstPaintTime: t + 0.25, firstPaintAfterLoadTime: 0, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2' });
    (window as unknown as { chrome: unknown }).chrome = c;
  },
});
