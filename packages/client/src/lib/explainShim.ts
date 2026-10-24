/**
 * What Cora puts into every HTML explain, before the page's own scripts
 *:
 * - the theme as CSS variables (the page uses var(--cora) and the rest, so it follows the user's colours);
 * - for a live explain, `cora.onData(fn)`: fn gets the latest data at once and on every change, which the viewer posts
 *   in (only messages from the viewer are taken);
 * - where the page was scrolled to, kept across a reload (a new version), reported back as it changes.
 */

/** The theme names a page uses, from the dashboard's own variables. */
export const THEME: Array<[string, string]> = [
  ['--bg', '--nav'],
  ['--panel', '--raise'],
  ['--panel2', '--raise2'],
  ['--ink', '--ink'],
  ['--ink2', '--ink2'],
  ['--ink3', '--ink3'],
  ['--hair', '--hair2'],
  ['--cora', '--cora'],
  ['--ok', '--work'],
  ['--warn', '--think'],
  ['--bad', '--need'],
  ['--scroll', '--scroll-thumb'],
];

/** The theme's values right now (from the dashboard's styles; a test passes them in). */
export function themeVars(read: (name: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [page, ours] of THEME) {
    const v = read(ours).trim();
    if (v) out[page] = v;
  }
  return out;
}

/** JSON safe inside a <script>: no way out of it. */
/** a character as its JSON escape (backslash, u, four hex digits) */
const esc = (c: string) => `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
const inScript = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, esc).replace(LS, esc).replace(PS, esc);

export function explainShim(o: { vars: Record<string, string>; live?: boolean; data?: unknown; scroll?: number }): string {
  const vars = Object.entries(o.vars)
    .filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[;{}<>]/.test(v))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
  // the app's scrollbar (a page that styles its own keeps it: this is the least specific rule there is)
  const style = `<style>:root{${vars}}</style><style>:root{color-scheme:dark}*{scrollbar-width:thin;scrollbar-color:var(--scroll,#1d2430) transparent}</style>`;
  const script = `<script>(function(){
var fns=[],has=${o.live && o.data !== undefined ? 'true' : 'false'},last=${o.live ? inScript(o.data) : 'null'};
window.cora={onData:function(f){if(typeof f!=='function')return;fns.push(f);if(has)try{f(last)}catch(e){console.error(e)}}};
window.addEventListener('message',function(e){if(e.source!==window.parent||!e.data||e.data.cora!=='data')return;has=true;last=e.data.data;for(var i=0;i<fns.length;i++)try{fns[i](last)}catch(err){console.error(err)}});
var y=${Math.max(0, Math.round(o.scroll ?? 0))};if(y)window.addEventListener('load',function(){window.scrollTo(0,y)});
var t;window.addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(function(){window.parent.postMessage({cora:'scroll',y:Math.round(window.scrollY)},'*')},150)},{passive:true});
})();</script>`;
  return style + script;
}
