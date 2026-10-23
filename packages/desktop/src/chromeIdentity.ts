import { join } from 'node:path';
import type { Session, WebContents } from 'electron';
import { chromeUserAgent } from './userAgent';

/**
 * Pages in Cora's browser see Chrome, the way Chrome shows itself. Google's sign-in turns away a browser it takes to be
 * embedded in an app, and Electron gives itself away beyond its user agent (userAgent.ts): its client hints name only
 * "Chromium" (and its requests send none), and its `window.chrome` is empty. So: Chrome's brands in the client hints,
 * in the requests' headers and in navigator.userAgentData, and Chrome's `window.chrome` (webChrome.ts).
 */

const FULL = process.versions.chrome ?? '0.0.0.0';
const MAJOR = FULL.split('.')[0];
const BRANDS = [
  { brand: 'Google Chrome', version: MAJOR },
  { brand: 'Chromium', version: MAJOR },
  { brand: 'Not?A_Brand', version: '24' },
];

/** The request header Chrome sends with them: `"Google Chrome";v="152", "Chromium";v="152", "Not?A_Brand";v="24"`. */
export const secChUa = (brands = BRANDS) => brands.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');

/** A browser profile's session: Chrome's window.chrome in its pages, and Chrome's client hints on its secure requests. */
export function chromeSession(ses: Session): void {
  ses.registerPreloadScript({ type: 'frame', id: 'cora-chrome', filePath: join(__dirname, 'webChrome.cjs') });
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://*/*'] }, (d, cb) =>
    cb({ requestHeaders: { 'sec-ch-ua': secChUa(), 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"Windows"', ...d.requestHeaders } }),
  );
}

/** A page (a tab, or a sign-in window): Chrome's brands where its scripts read them (navigator.userAgentData). */
export function chromeIdentity(wc: WebContents): void {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    return; // DevTools' own connection has it: this page keeps Electron's brands
  }
  void wc.debugger
    .sendCommand('Emulation.setUserAgentOverride', {
      userAgent: chromeUserAgent(wc.getUserAgent(), FULL),
      userAgentMetadata: {
        brands: BRANDS,
        fullVersionList: BRANDS.map((b) => ({ brand: b.brand, version: b.version === MAJOR ? FULL : `${b.version}.0.0.0` })),
        fullVersion: FULL,
        platform: 'Windows',
        platformVersion: '19.0.0',
        architecture: 'x86',
        model: '',
        mobile: false,
        bitness: '64',
        wow64: false,
      },
    })
    .catch(() => {});
}
