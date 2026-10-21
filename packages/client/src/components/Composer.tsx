import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useBrain, sessionEvents } from '../state/store';
import { attachFile, composerInbox, draftOf, loadCommands, previews, sendToSession, useComposer, interruptSession } from '../state/composer';
import { buildPrompt, caretOnEdge, filterCommands, keyAction, promptHistory, slashQuery, stepHistory, type Attachment, type SlashCommand, stopKey } from '../lib/composer';
import { useShells } from '../state/shells';
import { Icon } from './Icon';
import { startListening, stopListening, useVoice } from '../lib/voice';
import './composer.css';

/** Over to the terminal (Esc): its input, when it's on show. */
const focusTerminal = () => (document.querySelector('.term-window:not(.hidden) .xterm-helper-textarea') as HTMLTextAreaElement | null)?.focus();

/**
 * A roomy prompt box for sessions hosted here (composer mode): write (several lines, files, `/` commands), then it's
 * typed into Claude Code's input and submitted. Claude Code's own menus and questions still happen in its terminal,
 * which shows itself above for them.
 */
export function Composer({ sessionId }: { sessionId: string }) {
  const live = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const on = useBrain((s) => s.prefs.inputMode === 'composer');
  return live && on ? <ComposerBox key={sessionId} sessionId={sessionId} /> : null;
}

function ComposerBox({ sessionId }: { sessionId: string }) {
  const draft = useComposer((s) => s.drafts[sessionId]);
  const text = draft?.text ?? '';
  const attachments = draft?.attachments ?? [];
  const setDraft = (d: Partial<{ text: string; attachments: Attachment[] }>) => useComposer.getState().setDraft(sessionId, d);
  const enterMode = useBrain((s) => s.prefs.composerEnter);
  const commands = useComposer((s) => s.commands[sessionId]?.list);
  // Claude Code is asking something in its terminal (shown above): answer there first
  const asking = useShells((s) => !!s.asking[sessionId]);
  const ta = useRef<HTMLTextAreaElement>(null);
  // switched to this session: the keyboard goes here (unless you're typing somewhere else, say the palette)
  useEffect(() => {
    const el = document.activeElement;
    const typing = (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && !el.classList.contains('xterm-helper-textarea');
    if (!typing) requestAnimationFrame(() => ta.current?.focus());
  }, []);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [menuClosed, setMenuClosed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<{ text: string; choice?: boolean; command?: string } | null>(null);
  const [drag, setDrag] = useState(false);
  // ↑/↓ history: where we are in it (null: your own text) and what you'd written before stepping in
  const hist = useRef<{ at: number | null; own: string; shown: string | null }>({ at: null, own: '', shown: null });
  // showing an earlier prompt (unchanged): the arrows keep stepping, even through one that starts with /
  const browsing = hist.current.at != null && hist.current.shown === text;

  // the / menu
  const query = focused ? slashQuery(text, caret) : null;
  const items = useMemo(() => (query == null || !commands ? [] : filterCommands(commands, query)), [query, commands]);
  const menuOpen = query != null && items.length > 0 && menuClosed !== text && !browsing;
  useEffect(() => {
    if (query != null) void loadCommands(sessionId);
  }, [query != null, sessionId]);
  useEffect(() => setSel(0), [query]);

  // grows with its text up to a third of the window, then scrolls. Past three lines the text takes the whole width
  // (the buttons drop to a row under it); back to one line, they come back beside it. The gap between the two keeps
  // the change of width from flipping it back and forth.
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    const h = el.scrollHeight;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    if (!tall && h > line * 3 + 12) setTall(true);
    else if (tall && (!text || h <= line + 12)) setTall(false);
    el.style.height = `${Math.min(h + 2, Math.max(120, window.innerHeight * 0.33))}px`;
  }, [text, tall]);

  // push-to-talk puts its words here for review
  useEffect(() => {
    const take = (words: string) => {
      const cur = draftOf(sessionId).text;
      const next = cur.trim() ? `${cur.replace(/\s+$/, '')} ${words}` : words;
      setDraft({ text: next });
      requestAnimationFrame(() => {
        ta.current?.focus();
        ta.current?.setSelectionRange(next.length, next.length);
      });
    };
    composerInbox.set(sessionId, take);
    return () => void (composerInbox.get(sessionId) === take && composerInbox.delete(sessionId));
  }, [sessionId]);

  // talking into it (when voice is set up)
  const voiceOn = useVoice((v) => v.settings.enabled && !!v.key?.set);
  const listening = useVoice((v) => (v.ptt.phase === 'listening' || v.ptt.phase === 'finishing') && v.ptt.sessionId === sessionId);

  const history = () =>
    promptHistory(
      sessionEvents(sessionId)
        .filter((e) => e.kind === 'prompt' && e.agentId === 'main' && !e.queue && e.text)
        .map((e) => ({ text: e.text!, ts: e.ts })),
      useComposer.getState().sent[sessionId] ?? [],
    );

  const edit = (next: string, at = next.length) => {
    setDraft({ text: next });
    setError(null);
    requestAnimationFrame(() => {
      ta.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  /** Send what's in the box (or `command`, picked from the menu). */
  const send = async (force = false, command?: string) => {
    const prompt = command ?? buildPrompt(text, attachments);
    if (!prompt.trim() || busy || uploading) return;
    // the box empties at once, so you can start on the next prompt; a failed send puts it back (if still empty)
    const before = { text, attachments };
    setDraft(command == null ? { text: '', attachments: [] } : { text: '' });
    hist.current = { at: null, own: '', shown: null };
    setBusy(true);
    setError(null);
    const r = await sendToSession(sessionId, prompt, force);
    setBusy(false);
    if (r.ok) return;
    const now = draftOf(sessionId);
    if (!now.text && !now.attachments.length) setDraft(before);
    setError({ text: r.error, choice: r.choice, command });
  };

  /** Take a command from the menu: one that takes arguments is completed; one that doesn't runs. */
  const pick = (c: SlashCommand, run: boolean) => {
    const rest = text.slice(caret).replace(/^\S*/, '');
    if (run && !c.hint && !rest.trim()) return void send(false, `/${c.name}`);
    const head = `/${c.name}${rest.startsWith(' ') ? '' : ' '}`;
    edit(head + rest, head.length);
  };

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading((n) => n + files.length);
    for (const f of files) {
      try {
        const a = await attachFile(sessionId, f);
        const cur = draftOf(sessionId).attachments;
        if (!cur.some((x) => x.path === a.path)) setDraft({ attachments: [...cur, a] });
      } catch (e) {
        setError({ text: `${f.name || 'file'}: ${(e as Error).message}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey)) {
        e.preventDefault();
        return pick(items[Math.min(sel, items.length - 1)], e.key === 'Enter');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return setMenuClosed(text);
      }
    }
    // the terminal's keys: Esc and Ctrl+C (nothing selected) stop the work; what you've written stays
    const stop = stopKey({ ...e, isComposing: e.nativeEvent.isComposing }, { selection: el.selectionStart !== el.selectionEnd });
    const drafted = !!text || attachments.length > 0;
    if (stop) {
      e.preventDefault();
      void interruptSession(sessionId, stop).then((r) => {
        if (r.sent) return setError(null);
        // nothing running: Esc on an empty box goes to the terminal, as it always has (with a draft it stays put);
        // Ctrl+C says so
        if (stop === 'esc') {
          if (drafted) return;
          el.blur();
          focusTerminal();
        } else setError({ text: r.why });
      });
      return;
    }
    const act = keyAction({ ...e, isComposing: e.nativeEvent.isComposing }, enterMode);
    if (act === 'send') {
      e.preventDefault();
      return void send();
    }
    // ↑ in an empty box steps back through your prompts; while one is shown (unchanged) ↑/↓ keep stepping once the
    // caret is on its first/last line. Text of your own: the arrows just move the caret.
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const h = hist.current;
      const list = history();
      if (!browsing) h.at = null;
      if (!browsing && text) return;
      // prompts may have arrived meanwhile: find the one on show again
      if (h.at != null && list[h.at] !== text) h.at = list.lastIndexOf(text) >= 0 ? list.lastIndexOf(text) : null;
      const dir = e.key === 'ArrowUp' ? -1 : 1;
      if (!caretOnEdge(text, el.selectionStart, el.selectionEnd, dir)) return;
      const next = stepHistory(list.length, h.at, dir);
      if (next === undefined) return;
      e.preventDefault();
      if (h.at == null) h.own = text;
      h.at = next;
      h.shown = next == null ? null : list[next];
      edit(next == null ? h.own : list[next]);
    }
  };

  const canSend = !busy && !uploading && !!buildPrompt(text, attachments).trim();
  const hintSend = enterMode === 'enter' ? 'Enter sends · Shift+Enter new line' : 'Ctrl+Enter sends · Enter new line';
  return (
    <div
      className={`composer${focused ? ' cmp-on' : ''}${drag ? ' cmp-drag' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDrag(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrag(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDrag(false);
        void addFiles([...e.dataTransfer.files]);
        ta.current?.focus();
      }}
    >
      {menuOpen ? <CommandMenu items={items} sel={Math.min(sel, items.length - 1)} onPick={(c) => pick(c, true)} onHover={setSel} /> : null}
      {attachments.length || uploading ? (
        <div className="cmp-chips">
          {attachments.map((a) => (
            <span key={a.path} className="cmp-chip" title={a.path}>
              {a.image && previews.get(a.path) ? <img src={previews.get(a.path)} alt="" /> : <Icon name={a.image ? 'Image' : 'File'} size={12} />}
              <span className="cmp-chip-n">{a.name}</span>
              <button className="cmp-chip-x" title="Remove" onClick={() => setDraft({ attachments: attachments.filter((x) => x.path !== a.path) })}>
                <Icon name="X" size={11} />
              </button>
            </span>
          ))}
          {uploading ? <span className="cmp-chip busy">adding {uploading} file{uploading > 1 ? 's' : ''}…</span> : null}
        </div>
      ) : null}
      <div className={`cmp-row${tall ? ' cmp-tall' : ''}`}>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          spellCheck
          placeholder={drag ? 'Drop to attach' : 'Message Claude…  / for commands · paste or drop files'}
          onChange={(e) => {
            setDraft({ text: e.target.value });
            setCaret(e.target.selectionStart);
            setError(null);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            // a screenshot (no text with it) becomes an attachment; text pastes as text
            if (files.length && !e.clipboardData.getData('text/plain')) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
        />
        <label className="cmp-btn" title="Attach files">
          <Icon name="Paperclip" size={14} />
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </label>
        {voiceOn ? (
          <button className={`cmp-btn${listening ? ' on' : ''}`} title={listening ? 'Stop listening' : 'Talk (your words land here to check)'} onClick={() => (listening ? void stopListening() : void startListening(sessionId, { hands: true }))}>
            <Icon name={listening ? 'MicOff' : 'Mic'} size={14} />
          </button>
        ) : null}
        <button className="cmp-btn cmp-send" disabled={!canSend} title={hintSend} onClick={() => void send()}>
          <Icon name={busy ? 'LoaderCircle' : 'ArrowUp'} size={15} />
        </button>
      </div>
      {error ? (
        <div className="cmp-err">
          <Icon name="TriangleAlert" size={12} /> <span>{error.text}</span>
          {error.choice ? (
            <button className="mini" onClick={() => void send(true, error.command)} title="Type it in anyway (it may answer the choice)">
              send anyway
            </button>
          ) : null}
        </div>
      ) : asking ? (
        <div className="cmp-hint cmp-ask">
          <Icon name="ArrowUp" size={12} /> Claude Code is asking in the terminal above: answer it there (Esc takes you to it)
        </div>
      ) : null}
    </div>
  );
}

function CommandMenu({ items, sel, onPick, onHover }: { items: SlashCommand[]; sel: number; onPick(c: SlashCommand): void; onHover(i: number): void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    (box.current?.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);
  return (
    <div className="cmp-menu" ref={box} role="listbox">
      {items.map((c, i) => (
        <div
          key={c.name}
          role="option"
          aria-selected={i === sel}
          className={`cmp-item${i === sel ? ' on' : ''}`}
          // mousedown, not click: the textarea keeps its focus
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          onMouseMove={() => i !== sel && onHover(i)}
        >
          <span className="cmp-name">/{c.name}</span>
          {c.hint ? <span className="cmp-arg">{c.hint}</span> : null}
          <span className="cmp-desc">{c.description}</span>
          {c.kind !== 'builtin' ? <span className="cmp-src">{c.source === 'user' || c.source === 'project' ? `${c.source} ${c.kind}` : c.source}</span> : null}
        </div>
      ))}
    </div>
  );
}
