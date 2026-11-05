import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTabletUi } from '../src/lib/tablet';
import { useBrain } from '../src/state/store';
import { askEnd, usePalette } from '../src/components/Palette';
import { closeOnChoice, drawerCloses } from '../src/components/Tablet';
import { useTools } from '../src/state/tools';

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

  it("a tool opened from it (Library, Notes, a site) closes it, so the tool's pane isn't half under it; a tool closing leaves it be", () => {
    useTabletUi.setState({ drawer: true });
    off = closeOnChoice();
    useTools.getState().show('cora:library');
    expect(useTabletUi.getState().drawer).toBe(false);
    // opened again over the open tool: nothing new opened, so it stays
    useTabletUi.setState({ drawer: true });
    useTools.getState().close();
    expect(useTabletUi.getState().drawer).toBe(true);
    // another tool (Notes): closes it
    useTools.getState().toggle('cora:notes');
    expect(useTabletUi.getState().drawer).toBe(false);
    useTools.getState().close();
  });

  it("the nav's rows ask the always-mounted confirm, never one of their own (inside the drawer)", () => {
    const rail = readFileSync(join(__dirname, '../src/components/SessionRail.tsx'), 'utf8');
    expect(rail).not.toMatch(/EndSessionConfirm/);
    expect(rail).toMatch(/askEnd\(s\.id\)/);
  });
});

describe("the drawer and a session's flag", () => {
  /** A clicked element, as the classes of it and its ancestors (itself first): enough of closest() for class lists. */
  const at = (...chain: string[]) => ({
    closest: (sel: string) => {
      const want = sel.split(',').map((x) => x.trim().replace(/^\./, ''));
      return chain.find((c) => c.split(' ').some((k) => want.includes(k))) ?? null;
    },
  }) as unknown as Element;

  it("a row's bookmark, and the flag's popover, leave the drawer open (the why and reminder are asked for there); the row itself still closes it", () => {
    expect(drawerCloses(at('lucide', 'ses-fl on', 'ses-l2', 'ses idle'))).toBe(false);
    expect(drawerCloses(at('fp-chip', 'fp-when', 'session-menu flag-pop'))).toBe(false);
    expect(drawerCloses(at('ses-x', 'ses idle'))).toBe(false);
    expect(drawerCloses(at('ses-nm', 'ses idle'))).toBe(true);
    expect(drawerCloses(at('pj-row'))).toBe(true);
    expect(drawerCloses(at('pj-chev', 'pj-row'))).toBe(false);
  });

  it("the popover lives outside the drawer (a drawer closing can't take it), over its dim", () => {
    const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
    const rail = readFileSync(join(__dirname, '../src/components/SessionRail.tsx'), 'utf8');
    expect(app).toMatch(/<FlagPop \/>/);
    expect(rail).not.toMatch(/<FlagPop/);
    const css = readFileSync(join(__dirname, '../src/components/popovers.css'), 'utf8');
    const drawer = readFileSync(join(__dirname, '../src/components/tablet.css'), 'utf8');
    const z = (src: string, sel: RegExp) => Number(new RegExp(String.raw`${sel.source}[^}]*z-index:\s*(\d+)`).exec(src)?.[1]);
    expect(z(css, /\.session-menu\.flag-pop \{/)).toBeGreaterThan(z(drawer, /\.tb-drawer \{/));
  });
});

