import { Children, Fragment, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from 'react';

/** Settings building blocks: one look for every page, panel, row, choice and switch. */

/** The page Settings is on (and the search, which shows every page's matching rows). */
export const SettingsPage = createContext<{ current: string; searching: boolean }>({ current: '', searching: false });

/** Fragments flattened, so a section's rows can be grouped into panels whatever wraps them. */
function flat(children: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  Children.forEach(children, (c) => {
    if (isValidElement(c) && c.type === Fragment) out.push(...flat((c as ReactElement<{ children?: ReactNode }>).props.children));
    else if (c != null && c !== false) out.push(c);
  });
  return out;
}

/**
 * A page: its title and one line of what it's for, then its rows in panels. Rows sit in one panel until a Group
 * starts another. `id` is the page the nav shows.
 */
export function Section({ id, title, intro, bare, children }: { id: string; title: string; intro?: ReactNode; /** its own layout: no panel around it */ bare?: boolean; children: ReactNode }) {
  const { current, searching } = useContext(SettingsPage);
  const parts: ReactNode[] = [];
  let run: ReactNode[] = [];
  const close = () => {
    if (run.length) parts.push(<div key={`p${parts.length}`} className="set-panel">{run}</div>);
    run = [];
  };
  for (const c of flat(children)) {
    if (isValidElement(c) && c.type === Group) (close(), parts.push(c));
    else run.push(c);
  }
  close();
  return (
    <section className={`set-sec${current === id || searching ? ' on' : ''}`} id={`set-${id}`} data-sec={id} data-title={title}>
      <div className="set-sec-h">
        <h2>{title}</h2>
        {intro ? <p className="set-intro">{intro}</p> : null}
      </div>
      {bare ? children : parts}
    </section>
  );
}

/** Rows under a small-caps label, in a panel of their own. */
export function Group({ label, children }: { label: string; children: ReactNode }) {
  const rows = flat(children);
  if (!rows.length) return null;
  return (
    <div className="set-grp" data-grp={label}>
      <div className="set-grp-l">{label}</div>
      <div className="set-panel">{rows}</div>
    </div>
  );
}

/** A setting: its name and a short description on the left, the control on the right (under them when `wide`). */
export function Row({ label, hint, wide, children }: { label?: ReactNode; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`set-row${wide ? ' wide' : ''}`}>
      {label || hint ? (
        <div className="set-l">
          {label ? <b>{label}</b> : null}
          {hint ? <span className="set-hint">{hint}</span> : null}
        </div>
      ) : null}
      <div className="set-c">{children}</div>
    </div>
  );
}

/** A setting that's on or off: a row with a switch for its control. */
export function Toggle({ label, hint, checked, onChange }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange(v: boolean): void }) {
  return (
    <Row label={label} hint={hint}>
      <Switch checked={checked} onChange={onChange} />
    </Row>
  );
}

/** Pick one of a few: a segmented control. */
export function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange(v: T): void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} role="radio" aria-checked={v === value} className={`seg-b${v === value ? ' on' : ''}`} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** On or off: a switch, with its label beside it when it has one. */
export function Switch({ checked, onChange, children, hint }: { checked: boolean; onChange(v: boolean): void; children?: ReactNode; hint?: ReactNode }) {
  return (
    <label className="set-sw">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="set-sw-track" aria-hidden>
        <span className="set-sw-knob" />
      </span>
      {children || hint ? (
        <span className="set-sw-txt">
          {children ? <span>{children}</span> : null}
          {hint ? <span className="set-hint">{hint}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
