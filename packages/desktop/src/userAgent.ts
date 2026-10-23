/**
 * The built-in browser's user agent: Chrome's, as Chrome sends it. Electron's own names the app and Electron, and since
 * Electron 44 leaves Chrome's version out altogether (`… (KHTML, like Gecko) Cora/0.1.5 Safari/537.36`): a user agent
 * no real browser sends, which sign-in pages (Google's) turn away as an embedded browser. So: the app's and Electron's
 * names out, and Chrome's version in, the way Chrome gives it (major version only: `Chrome/152.0.0.0`).
 */
export function chromeUserAgent(ua: string, chromeVersion: string): string {
  const plain = ua.replace(/\s(Electron|Cora|cora|agent-brain|@cora\/desktop|@agent-brain\/desktop)\/\S+/gi, '');
  const chrome = `Chrome/${chromeVersion.split('.')[0]}.0.0.0`;
  if (/\sChrome\/\S+/.test(plain)) return plain.replace(/Chrome\/\S+/, chrome);
  return /\sSafari\//.test(plain) ? plain.replace(/\sSafari\//, ` ${chrome} Safari/`) : `${plain} ${chrome}`;
}
