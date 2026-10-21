import { useEffect, useState } from 'react';
import type { NoteSummary } from '@cora/shared';
import { notesApi, useNotes } from '../state/notes';
import { Row } from './settingsUi';
import { Icon } from './Icon';

/**
 * Settings › Tools › Notes templates: what New note can start from (Standup, Meeting…). Here, not in the notes list,
 * so a template is never mistaken for a note. Each is markdown: the lines between `---` say whether Cora drafts it
 * (`fill: cora`), over which window and its title; `<!-- cora: … -->` lines say what Cora writes there.
 */
export function NoteTemplateRows() {
  const list = useNotes((s) => s.list);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!list.length) void notesApi.list().then((r) => r.ok && useNotes.setState({ list: r.v.list }));
  }, []);
  const templates = list.filter((n) => n.kind === 'template');
  const add = async () => {
    const r = await notesApi.createTemplate('New template');
    if (r.ok) setOpen(r.v.id);
  };
  const restore = async () => {
    const r = await notesApi.restoreTemplates();
    setNote(!r.ok ? r.error : r.v.added ? `${r.v.added} brought back` : 'All four are here');
    setTimeout(() => setNote(null), 4000);
  };
  return (
    <>
      {templates.map((t) => (open === t.id ? <TemplateEditor key={t.id} t={t} onClose={() => setOpen(null)} /> : <TemplateRow key={t.id} t={t} onEdit={() => setOpen(t.id)} />))}
      <Row label="Add a template" hint="Starts as one Cora drafts; change the lines at the top to make it a plain one.">
        <button className="btn" onClick={() => void add()}>
          <Icon name="Plus" size={12} /> New template
        </button>
      </Row>
      <Row label="Default templates" hint="Brings back Standup, Meeting, Weekly review and Bug report if you deleted them. Ones you changed stay as they are.">
        <button className="btn ghost" onClick={() => void restore()}>
          <Icon name="RotateCcw" size={12} /> Restore
        </button>
        {note ? <span className="dim">{note}</span> : null}
      </Row>
    </>
  );
}

function TemplateRow({ t, onEdit }: { t: NoteSummary; onEdit: () => void }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <Row label={t.title} hint={t.fill ? 'Cora drafts it from your recent work' : 'A plain template'}>
      {confirm ? (
        <>
          <span className="dim">Delete it? Notes made from it stay.</span>
          <button className="btn danger" onClick={() => void notesApi.remove(t.id)}>
            Delete
          </button>
          <button className="btn ghost" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </>
      ) : (
        <>
          <button className="btn" onClick={onEdit}>
            <Icon name="PencilLine" size={12} /> Edit
          </button>
          <button className="icon-btn" title="Delete this template" onClick={() => setConfirm(true)}>
            <Icon name="Trash2" size={13} />
          </button>
        </>
      )}
    </Row>
  );
}

/** A template's name and text, saved when you say. */
function TemplateEditor({ t, onClose }: { t: NoteSummary; onClose: () => void }) {
  const [name, setName] = useState(t.title);
  const [text, setText] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void notesApi.read(t.id).then((r) => {
      if (r.ok) (setText(r.v.text), setVersion(r.v.version));
      else setErr(r.error);
    });
  }, [t.id]);
  const save = async () => {
    if (text == null) return;
    setBusy(true);
    setErr(null);
    const r = await notesApi.save(t.id, text, version);
    const n = name.trim();
    const m = r.ok && n && n !== t.title ? await notesApi.meta(t.id, { title: n }) : null;
    setBusy(false);
    if (!r.ok) return setErr(r.error);
    if (m && !m.ok) return setErr(m.error);
    onClose();
  };
  return (
    <Row
      wide
      label={<input className="set-input tl-name" value={name} aria-label="Template name" onChange={(e) => setName(e.target.value)} />}
      hint={
        <>
          Between the <code>---</code> lines: <code>fill: cora</code> (Cora drafts it), <code>window</code> (since-last, today, 24h or week) and <code>title</code> (<code>{'{date}'}</code> becomes the day). Each <code>&lt;!-- cora: … --&gt;</code> line says what Cora writes there.
        </>
      }
    >
      {text == null ? (
        <span className="dim">{err ?? 'Opening…'}</span>
      ) : (
        <>
          <textarea className="set-input tpl-text" rows={12} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
          <span className="tpl-acts">
            <button className="btn allow" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button className="btn ghost" disabled={busy} onClick={onClose}>
              Cancel
            </button>
            {err ? <span className="ny-err">{err}</span> : null}
          </span>
        </>
      )}
    </Row>
  );
}
