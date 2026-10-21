import { useLayoutEffect, useState } from 'react';
import { goalLive, isAgent, setConsoleOpen, useOrch } from '../state/orchestrator';
import { useBrain } from '../state/store';
import { useSlack } from '../state/slack';
import { ApprovalCard } from './CoraConsole';
import { SentCard } from './SlackOutbox';
import { JiraCard, JiraStartCard, JiraStartedCard, useStartedCards } from './JiraAlerts';
import { useJiraWatch } from '../state/jiraWatch';
import { DeployCards, useDeployCards } from './Deploys';
import { Icon } from './Icon';
import './console.css';

/**
 * Cora's cards, kept by Cora: beside its card in the nav while its console is closed. What it needs from you comes
 * first (something it wants your OK for, its terminal asking, a permission prompt, a blocked goal), then what it just
 * sent to Slack (while it can be undone). With the console or command mode open they're in its conversation instead.
 */
export function CoraFloat() {
  const status = useOrch((s) => s.status);
  const inConsole = useOrch((s) => s.open || s.command);
  const sent = useSlack((s) => s.sent);
  const alerts = useJiraWatch((s) => s.alerts);
  const started = useStartedCards();
  const deploys = useDeployCards();
  const prompts = useBrain((s) => s.pending.filter((p) => isAgent(p.sessionId)).length);
  const approvals = status?.enabled ? status.approvals : [];
  const asking = status?.enabled ? (status.asking ?? []) : [];
  const blocked = status?.enabled && goalLive(status) && status.goal?.state === 'blocked' ? status.goal : null;
  const needs = approvals.length + (asking.length ? 1 : 0) + (prompts ? 1 : 0) + (blocked ? 1 : 0);
  const show = !inConsole && (needs > 0 || sent.length > 0 || alerts.length > 0 || started.length > 0 || deploys.suggestions.length > 0 || deploys.bumps.length > 0);
  const [pos, setPos] = useState<{ left: number; top: number; arrow: number } | null>(null);
  useLayoutEffect(() => {
    if (!show) return;
    // the nav clips what sticks out of it: placed in the window, from Cora's card
    const el = document.querySelector('.rail .cora-bridge');
    const place = () => {
      const r = el?.getBoundingClientRect();
      // below the session's top bar (40 px), never over its controls; the arrow still points at Cora's card
      const top = r ? Math.max(r.top + 10, 48) : 48;
      setPos(r ? { left: r.right + 12, top, arrow: Math.round(r.top + r.height / 2 - top - 5) } : null);
    };
    place();
    const ro = el ? new ResizeObserver(place) : null;
    if (el) ro!.observe(el);
    window.addEventListener('resize', place);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [show]);
  if (!show) return null;
  const open = () => setConsoleOpen(true);
  return (
    <div className="cora-float" style={pos ? { left: pos.left, top: pos.top, ['--arrow' as any]: `${pos.arrow}px`, ['--arrow-on' as any]: pos.arrow >= 6 ? 1 : 0 } : { left: 262, top: 48 }}>
      {approvals.map((a) => (a.ticket ? <JiraStartCard key={a.id} a={a} /> : <ApprovalCard key={a.id} a={a} />))}
      {asking.length ? <NeedCard icon="MessageCircleQuestion" title="Cora's terminal is asking you" detail={asking.filter((l) => l.trim()).slice(0, 2).join(' · ')} onOpen={open} /> : null}
      {prompts ? <NeedCard icon="ShieldQuestion" title="Cora wants permission for a tool" detail="Answer it in Cora's console." onOpen={open} /> : null}
      {blocked ? <NeedCard icon="OctagonAlert" title="Autopilot is blocked" detail={blocked.note ?? blocked.text} onOpen={open} /> : null}
      <DeployCards />
      {started.map((r) => (
        <JiraStartedCard key={r.sessionId} r={r} />
      ))}
      {[...alerts].reverse().map((a) => (
        <JiraCard key={a.id} a={a} />
      ))}
      {[...sent].reverse().map((m) => (
        <SentCard key={m.id} m={m} />
      ))}
    </div>
  );
}

/** Something Cora needs from you that's answered in its console: what, and a way there. */
function NeedCard({ icon, title, detail, onOpen }: { icon: string; title: string; detail?: string; onOpen: () => void }) {
  return (
    <div className="cf-need" role="alert">
      <span className="cf-ico">
        <Icon name={icon} size={14} />
      </span>
      <span className="cf-t">
        <b>{title}</b>
        {detail ? <span>{detail}</span> : null}
      </span>
      <button className="btn allow" onClick={onOpen}>
        Open
      </button>
    </div>
  );
}
