import { DEFAULT_CORA_COLOR, isCoraColor } from '@cora/shared';
import { desktop } from './desktop';

/** Cora's colour, everywhere it shows: the --cora token (its eye, cards, console) and the app's icon. */
export function applyCoraColor(c: string | undefined): string {
  const color = isCoraColor(c) ? c.toLowerCase() : DEFAULT_CORA_COLOR;
  document.documentElement.style.setProperty('--cora', color);
  desktop?.setCoraColor?.(color);
  return color;
}
