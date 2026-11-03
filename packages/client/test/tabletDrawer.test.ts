import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTabletUi } from '../src/lib/tablet';
import { useBrain } from '../src/state/store';
import { askEnd, usePalette } from '../src/components/Palette';
import { closeOnChoice } from '../src/components/Tablet';

describe("the tablet's drawer and a session's End confirm", () => {
  let off: (() => void) | undefined;
  afterEach(() => {
    off?.();
    usePalette.setState({ ending: null });
    useTabletUi.setState({ drawer: false });
  });

  it("asking to end a session from the drawer closes it, so the confirm isn't under its dim", () => {
    useTabletUi.setState({ drawer: true });
    off = closeOnChoice();
    askEnd('s1');
    expect(usePalette.getState().ending).toBe('s1');
    expect(useTabletUi.getState().drawer).toBe(false);
  });

  it('its other choices still close it; the confirm closing, or nothing, leaves it be', () => {
    useTabletUi.setState({ drawer: true });
    off = closeOnChoice();
    usePalette.setState({ ending: null });
    expect(useTabletUi.getState().drawer).toBe(true);
    useBrain.setState({ inbox: !useBrain.getState().inbox });
    expect(useTabletUi.getState().drawer).toBe(false);
    // unsubscribed: nothing closes it any more
    off();
    off = undefined;
    useTabletUi.setState({ drawer: true });
    askEnd('s2');
    expect(useTabletUi.getState().drawer).toBe(true);
  });

  it("the nav's rows ask the always-mounted confirm, never one of their own (inside the drawer)", () => {
    const rail = readFileSync(join(__dirname, '../src/components/SessionRail.tsx'), 'utf8');
    expect(rail).not.toMatch(/EndSessionConfirm/);
    expect(rail).toMatch(/askEnd\(s\.id\)/);
  });
});
