import { useEffect, useRef, useState } from 'react';
import { secretNameProblem, type SecretInfo, type SecretScope } from '@cora/shared';
import { removeSecret, revealSecret, saveSecret, useSecrets } from '../state/secrets';
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

/** The add form and the list (Settings › Secrets, and the Secrets tool). */
function SecretsBody() {
  const list = useSecrets((s) => s.list);
  useEffect(() => void useSecrets.getState().load(), []);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (addNext) (addNext = false), setAdding(true);
  }, []);
  return (
      <div className="sc-wrap">
        {adding ? <SecretForm onDone={() => setAdding(false)} /> : (
          <button className="btn sc-add" onClick={() => setAdding(true)}>
            <Icon name="Plus" size={13} /> Add a secret
          </button>
        )}
        {list?.length ? (
          <div className="sc-list">
            {list.map((x) => (
              <SecretRow key={x.name} x={x} />
            ))}
          </div>
        ) : list ? (
          <div className="sc-empty">None yet. A session that needs one tells you its name; add it here and it can use it straight away.</div>
        ) : null}
      </div>
  );
}

/** Add a secret, or replace one's value (its name fixed). */
function SecretForm({ was, onDone }: { was?: SecretInfo; onDone(): void }) {
  const [name, setName] = useState(was?.name ?? '');
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
    if (!was && !value.trim()) return setErr('Paste its value');
    const scope: SecretScope = some ? { folders: folders(where) } : { all: true };
    if (some && !('all' in scope) && !scope.folders.length) return setErr('Which folders (one per line), or share it with all sessions');
    const e = await saveSecret({ name, ...(value.trim() ? { value } : {}), note, scope });
    if (e) return setErr(e);
    onDone();
  };
  return (
    <div className="sc-form" onKeyDown={(e) => e.key === 'Escape' && onDone()}>
      <label>
        <span>Name</span>
        <input ref={was ? undefined : first} value={name} disabled={!!was} placeholder="GITHUB_PAT" spellCheck={false} onChange={(e) => (setErr(null), setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')))} />
      </label>
      <label>
        <span>{was ? 'New value' : 'Value'}</span>
        <input ref={was ? first : undefined} type="password" value={value} placeholder={was ? 'Paste the new value' : 'Paste it here'} autoComplete="off" onChange={(e) => (setErr(null), setValue(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && void save()} />
      </label>
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

function SecretRow({ x }: { x: SecretInfo }) {
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [edit, setEdit] = useState(false);
  const [sure, setSure] = useState(false);
  // revealed for a little while, then hidden again
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), 15_000);
    return () => clearTimeout(t);
  }, [shown]);
  const copy = async () => {
    const v = await revealSecret(x.name);
    if (v == null) return;
    if (desktop?.writeClipboard) desktop.writeClipboard(v);
    else await navigator.clipboard?.writeText(v).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const expired = !!x.expiresAt && x.expiresAt < Date.now();
  if (edit) return <SecretForm was={x} onDone={() => setEdit(false)} />;
  return (
    <div className="sc-row">
      <span className="sc-ic">
        <Icon name="KeyRound" size={14} />
      </span>
      <span className="sc-main">
        <span className="sc-l1">
          <code>{x.name}</code>
          {x.expiresAt ? <span className={`sc-chip ${expired ? 'bad' : x.expiresAt - Date.now() < 3_600_000 ? 'warn' : ''}`}>{expired ? 'expired' : `expires in ${left(x.expiresAt)}`}</span> : null}
          <span className="sc-chip quiet">{'all' in x.scope ? 'all sessions' : x.scope.folders.map((f) => f.split(/[\\/]/).filter(Boolean).pop()).join(', ')}</span>
        </span>
        <span className="sc-l2">
          {shown != null ? <code className="sc-val">{shown}</code> : <span className="sc-dots">••••••••••••</span>}
          {x.note ? <span>{x.note}</span> : null}
          {x.lastUsed ? <span className="sc-used">used {ago(x.lastUsed.at)} ago by {x.lastUsed.session}</span> : <span className="sc-used">not used yet</span>}
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
            <button title={shown != null ? 'Hide it' : 'Show it for a moment'} onClick={async () => setShown(shown != null ? null : await revealSecret(x.name))}>
              <Icon name={shown != null ? 'EyeOff' : 'Eye'} size={13} />
            </button>
            <button title="Copy it" onClick={() => void copy()}>
              <Icon name={copied ? 'Check' : 'Copy'} size={13} />
            </button>
            <button title={expired ? 'Paste a fresh one' : 'Replace its value (or change its note and who may use it)'} className={expired ? 'hot' : ''} onClick={() => setEdit(true)}>
              <Icon name="RefreshCw" size={13} />
            </button>
            <button title="Delete it" className="rm" onClick={() => setSure(true)}>
              <Icon name="Trash2" size={13} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}
