import { format } from 'node:util';

/** Each line that says something, with when it was said in front (as the terminal host's log has it). */
export function stamped(text: string, at: Date): string {
  const t = at.toISOString();
  return text
    .split('\n')
    .map((l) => (l.trim() ? `${t} ${l}` : l))
    .join('\n');
}

/**
 * What the server writes into server.log carries its time: a log without times can't be read against the terminal
 * host's log or a transcript (when did Cora's agent go silent?). Only into a log: at a terminal, as it was.
 */
export function stampConsole(now: () => Date = () => new Date()): void {
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const write = console[k].bind(console);
    console[k] = (...args: unknown[]) => write(stamped(format(...args), now()));
  }
}
