import { useMemo } from 'react';
import { sessionEvents, useBrain } from '../state/store';
import { deriveTasks, taskProgress } from '../lib/tasks';
import { Icon } from './Icon';

/** Claude's task list for the session, pinned above the transcript. */
export function TaskPanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const open = useBrain((s) => s.prefs.tasksOpen);
  const setPrefs = useBrain((s) => s.setPrefs);
  const tasks = useMemo(() => deriveTasks(sessionEvents(sessionId)), [sessionId, version]);
  if (!tasks.length) return null;
  const { done, total } = taskProgress(tasks);
  const current = tasks.find((t) => t.status === 'in_progress');
  return (
    <div className={`tasks${open ? ' open' : ''}`}>
      <button className="tasks-h" onClick={() => setPrefs({ tasksOpen: !open })} title={open ? 'Hide tasks' : 'Show tasks'}>
        <Icon name="ListChecks" size={13} />
        <span className="tk-n">
          {done}/{total}
        </span>
        <span className="tk-bar">
          <span style={{ width: `${(done / total) * 100}%` }} />
        </span>
        {!open && current ? <span className="tk-cur">{current.activeForm ?? current.subject}</span> : <span className="spacer" />}
        <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={13} />
      </button>
      {open ? (
        <ol className="task-list">
          {tasks.map((t) => (
            <li key={t.id} className={`tk-item ${t.status}`}>
              <Icon name={t.status === 'completed' ? 'CircleCheck' : t.status === 'in_progress' ? 'LoaderCircle' : 'Circle'} size={13} className="tk-i" />
              <span>{t.status === 'in_progress' ? t.activeForm ?? t.subject : t.subject}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
