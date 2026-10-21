import { toParText, type Best, type Card } from './physics';

/**
 * The game's overlay: a score line at the top centre of the scene and a call-out under it ("birdie", "+1 swallowed by
 * main"). Plain DOM made and removed by the game itself (it lives inside the canvas tree, which can't render DOM), so
 * the scene's own markup is untouched.
 */
export type Hud = {
  score(c: Card, best: Best): void;
  /** a short call-out; `tone` colours it */
  say(text: string, tone?: 'good' | 'bad' | 'ace' | 'info', ms?: number): void;
  /** the game ended: show `text` for a moment (or nothing), then go */
  close(text?: string): void;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function makeHud(host: HTMLElement): Hud {
  const el = document.createElement('div');
  el.className = 'golf-hud';
  const line = document.createElement('div');
  line.className = 'golf-line';
  const call = document.createElement('div');
  call.className = 'golf-call';
  el.append(line, call);
  host.append(el);
  requestAnimationFrame(() => el.classList.add('on'));
  let callT: ReturnType<typeof setTimeout> | undefined;
  let last = '';
  return {
    score(c, best) {
      const strokes = `${c.strokes} stroke${c.strokes === 1 ? '' : 's'}`;
      const run = c.hole > 1 ? ` · <span class="${c.toPar < 0 ? 'good' : c.toPar > 0 ? 'bad' : ''}">${toParText(c.toPar)}</span>` : '';
      const streak = c.streak > 1 ? ` · streak ${c.streak}` : '';
      const tries = c.tries > 1 ? ` · try ${c.tries}` : '';
      const html =
        `<b>Hole ${c.hole}</b> · ${strokes} · par ${c.par}${tries}${run}${streak}` +
        (best.under > 0 || best.streak > 1 ? ` <i>·</i> <span class="d">best ${best.under ? `${best.under} under` : `streak ${best.streak}`}</span>` : '') +
        ` <i>·</i> <span class="d">R retry · Esc</span>`;
      if (html !== last) line.innerHTML = last = html;
    },
    say(text, tone = 'info', ms = 1500) {
      call.innerHTML = esc(text);
      call.className = `golf-call on ${tone}`;
      clearTimeout(callT);
      callT = setTimeout(() => call.classList.remove('on'), ms);
    },
    close(text) {
      clearTimeout(callT);
      if (!text) return void el.remove();
      line.innerHTML = esc(text);
      call.classList.remove('on');
      setTimeout(() => el.classList.remove('on'), 2600);
      setTimeout(() => el.remove(), 3000);
    },
  };
}
