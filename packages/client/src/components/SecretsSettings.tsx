import { useEffect, useRef, useState } from 'react';
import { secretNameProblem, secretVars, type SecretInfo, type SecretKind, type SecretScope } from '@cora/shared';
import { removeSecret, revealSecret, saveSecret, useSecrets } from '../state/secrets';
import { useBrain } from '../state/store';
import { folderName, health, kindCounts, kindOf, loadView, needsYou, saveView, stale, viewSecrets, type SecretsView } from '../lib/secretsView';
import { desktop } from '../lib/desktop';
import { ago } from '../lib/format';
import { Section } from './settingsUi';
import { Icon } from './Icon';
import './secrets.css';

/** "Stash a secret" (the palette, Cora's card): Settings opens here with the form ready. */
let addNext = false;
export const wantAdd = () => (addNext = true);

const left = (t: number) => {
  const m = Math.round((t - Date.now()) / 60_000);
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const folders = (text: string) =>
  text
    .split(/[\n,;]+/)
    .map((f) => f.trim())
    .filter((f) => f.length > 1);

/**
 * Settings › Secrets: tokens and keys sessions use by name (secret_run) without ever seeing them. Add one, see when a
 * JWT expires and who used it last; Reveal, Copy, Replace, Delete.
 */
export function SecretsSection() {
  return (
    <Section
      id="secrets"
      title="Secrets"
      intro="Tokens and keys your sessions use by name, without ever seeing them: Cora runs their command with the secret and hides it in what comes back. The first use in each session asks you. Kept encrypted on this PC."
      bare
    >
      <SecretsBody />
    </Section>
  );
}

/** Cora's Secrets as a Tool (the drawer, beside Notes and the Browser): what they are, then the same list. */
export function SecretsPane({ visible }: { visible: boolean }) {
  return (
    <div className={`secrets-pane${visible ? '' : ' off'}`}>
      <p className="sc-about">Tokens and keys your sessions use by name, without ever seeing them. Cora runs their command with the secret and hides it in what comes back; the first use in each session asks you.</p>
      <SecretsBody key={visible ? 'shown' : 'hidden'} />
    </div>
  );
}

/** Copy a value (the desktop app's clipboard, else the browser's). */
async function copyText(v: string): Promise<void> {
  if (desktop?.writeClipboard) desktop.writeClipboard(v);
  else await navigator.clipboard?.writeText(v).catch(() => {});
}

/** With more than this many, the list gets its search, kind filter, grouping and sort. */
const FEW = 4;

/**
 * The add form and the list (Settings › Secrets, and the Secrets tool): what needs you first (expired, expiring),
 * then the secrets, searched, filtered by kind and grouped by who may use them (or by kind); a row opens for the rest.
 */
function SecretsBody() {
  const list = useSecrets((s) => s.list);
  useEffect(() => void useSecrets.getState().load(), []);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (addNext) (addNext = false), setAdding(true);
  }, []);
  const [view, setViewState] = useState<SecretsView>(loadView);
  const setView = (p: Partial<SecretsView>) =>
    setViewState((v) => {
      const next = { ...v, ...p };
      saveView(next);
      return next;
    });
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  // `/` goes to the search (when it's on show and you aren't typing somewhere)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = search.current;
      const a = document.activeElement as HTMLElement | null;
      if (!el || el.offsetParent === null || (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)))) return;
      e.preventDefault();
      el.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const now = Date.now();
  const many = (list?.length ?? 0) > FEW;
  // a short list: everything, in its groups (no search or filters to forget about)
  const eff: SecretsView = many ? view : { ...view, q: '', kind: 'all' };
  const groups = list ? viewSecrets(list, eff, now) : [];
  const attn = list ? needsYou(list, now) : [];
  const counts = list ? kindCounts(list) : { all: 0, value: 0, login: 0 };
  const filtered = !!eff.q || eff.kind !== 'all' || eff.attention;
  const replace = (name: string) => (setEditing(name), setOpen(null), setView({ q: '', kind: 'all' }));

  return (
    <div className="sc-wrap">
      <div className="sc-top">
        {!adding ? (
          <button className="btn sc-add" onClick={() => setAdding(true)}>
            <Icon name="Plus" size={13} /> Add a secret
          </button>
        ) : null}
        {many ? (
          <>
            <label className="sc-search">
              <Icon name="Search" size={13} />
              <input ref={search} value={view.q} placeholder="Search names, notes, usernames, folders" spellCheck={false} onChange={(e) => setView({ q: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && view.q && (e.stopPropagation(), setView({ q: '' }))} />
              {view.q ? (
                <button title="Clear" onClick={() => setView({ q: '' })}>
                  <Icon name="X" size={12} />
                </button>
              ) : (
                <kbd>/</kbd>
              )}
            </label>
            <span className="sc-seg" role="radiogroup" aria-label="Which kind">
              {(
                [
                  ['all', 'All'],
                  ['value', 'Secrets'],
                  ['login', 'Logins'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={view.kind === k} className={view.kind === k ? 'on' : ''} onClick={() => setView({ kind: k })}>
                  {l}
                  <span className="sc-n">{counts[k]}</span>
                </button>
              ))}
            </span>
          </>
        ) : null}
      </div>
      {adding ? <SecretForm onDone={() => setAdding(false)} /> : null}
      {many ? (
        <div className="sc-opts">
          <span className="sc-opt">
            <span>Group by</span>
            <span className="sc-seg">
              {(
                [
                  ['where', "Who may use it"],
                  ['kind', 'Kind'],
                  ['none', 'None'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={view.group === k ? 'on' : ''} onClick={() => setView({ group: k })}>
                  {l}
                </button>
              ))}
            </span>
          </span>
          <span className="sc-opt">
            <span>Sort</span>
            <span className="sc-seg">
              {(
                [
                  ['name', 'Name'],
                  ['used', 'Last used'],
                  ['newest', 'Newest'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={view.sort === k ? 'on' : ''} onClick={() => setView({ sort: k })}>
                  {l}
                </button>
              ))}
            </span>
          </span>
        </div>
      ) : null}
      {attn.length ? (
        <div className="sc-attn">
          <Icon name="TriangleAlert" size={13} />
          <b>{attn.length === 1 ? '1 needs you' : `${attn.length} need you`}</b>
          {attn.map((s) => {
            const h = health(s, now);
            return (
              <button key={s.name} className={`sc-chip ${h === 'expired' ? 'bad' : 'warn'}`} title="Paste a fresh one" onClick={() => replace(s.name)}>
                {s.name} · {h === 'expired' ? 'expired' : `expires in ${left(s.expiresAt!)}`}
              </button>
            );
          })}
          <button className="sc-link" onClick={() => setView({ attention: !view.attention })}>
            {view.attention ? 'Show them all' : 'Show only these'}
          </button>
        </div>
      ) : null}
      {groups.map((g) => (
        <div key={g.key} className="sc-group">
          {g.label ? (
            <div className="sc-grp" title={g.title}>
              <Icon name={g.key === 'all' && eff.group === 'where' ? 'Globe' : g.key.startsWith('f:') ? 'Folder' : g.key === 'login' ? 'UserRound' : 'KeyRound'} size={11} />
              <span>{g.label}</span>
              <span className="sc-n">{g.items.length}</span>
            </div>
          ) : null}
          <div className="sc-list">
            {g.items.map((x) => (
              <SecretRow
                key={x.name}
                x={x}
                now={now}
                scopeChip={eff.group !== 'where'}
                open={open === x.name}
                onToggle={() => setOpen(open === x.name ? null : x.name)}
                editing={editing === x.name}
                onEdit={(on) => setEditing(on ? x.name : null)}
              />
            ))}
          </div>
        </div>
      ))}
      {list && !list.length ? (
        <div className="sc-empty">None yet. A session that needs one tells you its name; add it here and it can use it straight away.</div>
      ) : list && !groups.length && filtered ? (
        <div className="sc-empty">
          Nothing matches.{' '}
          <button className="sc-link" onClick={() => setView({ q: '', kind: 'all', attention: false })}>
            Show them all
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Add a secret (a value, or a username and password), or replace one's value (its name fixed). */
function SecretForm({ was, onDone }: { was?: SecretInfo; onDone(): void }) {
  const [kind, setKind] = useState<SecretKind>(was?.kind ?? 'value');
  const login = kind === 'login';
  const [name, setName] = useState(was?.name ?? '');
  const [user, setUser] = useState(was?.user ?? '');
  const [value, setValue] = useState('');
  const [note, setNote] = useState(was?.note ?? '');
  const [some, setSome] = useState(!!was && !('all' in was.scope));
  const [where, setWhere] = useState(was && 'folders' in was.scope ? was.scope.folders.join('\n') : '');
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  const bad = name ? secretNameProblem(name) : null;
  const save = async () => {
    if (bad) return setErr(bad);
    if (login && !user.trim()) return setErr('Its username');
    // a new one, or one made a login now: its value (password) comes with it
    if ((!was || (login && was.kind !== 'login')) && !value.trim()) return setErr(login ? 'Its password' : 'Paste its value');
    const scope: SecretScope = some ? { folders: folders(where) } : { all: true };
    if (some && !('all' in scope) && !scope.folders.length) return setErr('Which folders (one per line), or share it with all sessions');
    const e = await saveSecret({ name, kind, ...(login ? { user: user.trim() } : {}), ...(value.trim() ? { value } : {}), note, scope });
    if (e) return setErr(e);
    onDone();
  };
  return (
    <div className="sc-form" onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <div className="sc-scope">
        <span>What it is</span>
        <span className="sc-seg">
          <button className={login ? '' : 'on'} onClick={() => (setErr(null), setKind('value'))}>Secret</button>
          <button className={login ? 'on' : ''} onClick={() => (setErr(null), setKind('login'))}>Username + password</button>
        </span>
      </div>
      <label>
        <span>Name</span>
        <input ref={was ? undefined : first} value={name} disabled={!!was} placeholder={login ? 'SITE_LOGIN' : 'GITHUB_PAT'} spellCheck={false} onChange={(e) => (setErr(null), setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')))} />
      </label>
      {login ? (
        <label>
          <span>Username</span>
          <input value={user} placeholder="the account's username" spellCheck={false} autoComplete="off" onChange={(e) => (setErr(null), setUser(e.target.value))} />
        </label>
      ) : null}
      <label>
        <span>{login ? (was?.kind === 'login' ? 'New password' : 'Password') : was ? 'New value' : 'Value'}</span>
        <input ref={was ? first : undefined} type="password" value={value} placeholder={was ? (login && was.kind === 'login' ? 'Leave empty to keep it' : 'Paste the new value') : 'Paste it here'} autoComplete="new-password" onChange={(e) => (setErr(null), setValue(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
      {name && !bad ? <div className="sc-uses">Commands get it as <code>{secretVars(name, kind)}</code></div> : null}
      <label>
        <span>What it's for</span>
        <input value={note} placeholder="a GitHub token for the CI bot (sessions see this)" onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="sc-scope">
        <span>Who may use it</span>
        <span className="sc-seg">
          <button className={some ? '' : 'on'} onClick={() => setSome(false)}>All sessions</button>
          <button className={some ? 'on' : ''} onClick={() => setSome(true)}>Sessions in…</button>
        </span>
      </div>
      {some ? <textarea className="sc-where" rows={2} value={where} placeholder={'C:\\gitlab\\orion-services'} onChange={(e) => setWhere(e.target.value)} /> : null}
      <div className="sc-acts">
        {err ?? bad ? <span className="sc-err">{err ?? bad}</span> : null}
        <button className="btn ghost" onClick={onDone}>Cancel</button>
        <button className="btn allow" onClick={() => void save()}>{was ? 'Replace' : 'Save'}</button>
      </div>
    </div>
  );
}

const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });

/**
 * One secret: its name, kind, state (expired, expiring, not used for a while) and what it's for; Reveal, Copy, Replace,
 * Delete. A click opens the rest: how commands get it, a login's username to copy, every folder that may use it,
 * when it was added and changed, and the session that used it last (a click goes there).
 */
function SecretRow({ x, now, scopeChip, open, onToggle, editing, onEdit }: { x: SecretInfo; now: number; scopeChip: boolean; open: boolean; onToggle(): void; editing: boolean; onEdit(on: boolean): void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  // revealed for a little while, then hidden again
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 15_000);
    return () => clearTimeout(t);
  }, [shown]);
  const copied1 = (what: string) => (setCopied(what), setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500));
  const copySecret = async () => {
    const v = await revealSecret(x.name);
    if (v == null) return;
    await copyText(v);
    copied1('secret');
  };
  const copy = (what: string, v: string) => void copyText(v).then(() => copied1(what));
  const login = kindOf(x) === 'login';
  const h = health(x, now);
  const old = stale(x, now);
  const vars = login ? [`$${x.name}_USER`, `$${x.name}_PASS`] : [`$${x.name}`];
  const goTo = (sessionId: string) => {
    const st = useBrain.getState();
    st.setFocus(sessionId);
    if (st.modal === 'settings') st.setModal(null);
  };
  if (editing) return <SecretForm was={x} onDone={() => onEdit(false)} />;
  return (
    <div className={`sc-row${open ? ' open' : ''}`}>
      <span className={`sc-ic${login ? ' login' : ''}`}>
        <Icon name={login ? 'UserRound' : 'KeyRound'} size={14} />
      </span>
      <span className="sc-main" role="button" tabIndex={0} aria-expanded={open} title={open ? 'Less' : 'More about it'} onClick={onToggle} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onToggle())}>
        <span className="sc-l1">
          <code>{x.name}</code>
          {login ? <span className="sc-chip quiet" title="A username and password">login</span> : null}
          {x.expiresAt ? <span className={`sc-chip ${h === 'expired' ? 'bad' : h === 'soon' ? 'warn' : ''}`}>{h === 'expired' ? 'expired' : `expires in ${left(x.expiresAt)}`}</span> : null}
          {old ? <span className="sc-chip quiet" title="Still needed?">not used in {ago(x.lastUsed!.at, now)}</span> : null}
          {scopeChip ? <span className="sc-chip quiet">{'all' in x.scope ? 'all sessions' : x.scope.folders.map(folderName).join(', ')}</span> : null}
        </span>
        <span className="sc-l2">
          {login && x.user ? <code className="sc-user" title="Its username ($NAME_USER)">{x.user}</code> : null}
          {shown != null ? <code className="sc-val">{shown}</code> : <span className="sc-dots">••••••••••••</span>}
          {x.note ? <span>{x.note}</span> : null}
          {x.lastUsed ? <span className="sc-used">used {ago(x.lastUsed.at, now)} ago by {x.lastUsed.session}</span> : <span className="sc-used">not used yet</span>}
        </span>
      </span>
      <span className="sc-btns">
        {sure ? (
          <>
            <span className="sc-sure">Delete it?</span>
            <button className="btn ghost" onClick={() => setSure(false)}>Keep</button>
            <button className="btn deny" onClick={() => void removeSecret(x.name)}>Delete</button>
          </>
        ) : (
          <>
            <button title={shown != null ? 'Hide it' : login ? 'Show its password for a moment' : 'Show it for a moment'} onClick={async () => setShown(shown != null ? null : await revealSecret(x.name))}>
              <Icon name={shown != null ? 'EyeOff' : 'Eye'} size={13} />
            </button>
            <button title={login ? 'Copy its password' : 'Copy it'} onClick={() => void copySecret()}>
              <Icon name={copied === 'secret' ? 'Check' : 'Copy'} size={13} />
            </button>
            <button title={h === 'expired' ? 'Paste a fresh one' : 'Replace its value (or change its note and who may use it)'} className={h ? 'hot' : ''} onClick={() => onEdit(true)}>
              <Icon name="RefreshCw" size={13} />
            </button>
            <button title="Delete it" className="rm" onClick={() => setSure(true)}>
              <Icon name="Trash2" size={13} />
            </button>
          </>
        )}
      </span>
      {open ? (
        <div className="sc-more">
          <span>Commands get</span>
          <span className="sc-vars">
            {vars.map((v) => (
              <button key={v} className="sc-var" title="Copy" onClick={() => copy(v, v)}>
                <code>{v}</code>
                <Icon name={copied === v ? 'Check' : 'Copy'} size={11} />
              </button>
            ))}
          </span>
          {login && x.user ? (
            <>
              <span>Username</span>
              <span className="sc-vars">
                <button className="sc-var" title="Copy its username" onClick={() => copy('user', x.user!)}>
                  <code>{x.user}</code>
                  <Icon name={copied === 'user' ? 'Check' : 'Copy'} size={11} />
                </button>
              </span>
            </>
          ) : null}
          <span>Who may use it</span>
          <span>{'all' in x.scope ? 'All sessions' : x.scope.folders.map((f) => <code key={f} className="sc-path">{f}</code>)}</span>
          <span>Last used</span>
          <span>
            {x.lastUsed ? (
              <>
                {ago(x.lastUsed.at, now)} ago by{' '}
                <button className="sc-link" title="Go to that session" onClick={() => goTo(x.lastUsed!.sessionId)}>
                  {x.lastUsed.session}
                </button>
              </>
            ) : (
              'Not yet'
            )}
          </span>
          <span>Added</span>
          <span>
            {day(x.createdAt)}
            {x.updatedAt - x.createdAt > 60_000 ? ` · changed ${day(x.updatedAt)}` : ''}
            {x.expiresAt ? ` · ${h === 'expired' ? 'expired' : 'expires'} ${day(x.expiresAt)}` : ''}
          </span>
        </div>
      ) : null}
    </div>
  );
}
