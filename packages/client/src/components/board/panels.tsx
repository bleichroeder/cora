import type { PanelKind } from '../../lib/boardLayout';
import type { BoardData } from '../LiveBoard';
import { Boundary } from '../Boundary';
import { BackgroundPanel, ChangesPanel, GitPanel, TestsPanel } from './CodePanels';
import { DeploysPanel, PipelinePanel, TicketPanel } from './DeliveryPanels';
import { MentionsPanel, NeedsPanel, NotesPanel, SessionsPanel } from './AroundPanels';
import { ContextPanel, GoalPanel, UsagePanel } from './SessionPanels';
import { BrowserPanel, TerminalPanel } from './ToolPanels';
import './panels.css';

type Props = { sessionId: string; data: BoardData };
const BODIES: Partial<Record<PanelKind, React.ComponentType<Props>>> = {
  goal: GoalPanel,
  context: ContextPanel,
  changes: ChangesPanel,
  git: GitPanel,
  tests: TestsPanel,
  background: BackgroundPanel,
  pipeline: PipelinePanel,
  deploys: DeploysPanel,
  ticket: TicketPanel,
  needs: NeedsPanel,
  mentions: MentionsPanel,
  notes: NotesPanel,
  sessions: SessionsPanel,
  usage: UsagePanel,
  terminal: TerminalPanel,
  browser: BrowserPanel,
};

/** The live board's other panels (the first four live in LiveBoard), each in its own boundary: one failing leaves the rest. */
export function MorePanel({ k, sessionId, data }: { k: PanelKind } & Props) {
  const Body = BODIES[k];
  if (!Body) return null;
  return (
    <Boundary quiet name={`board ${k}`}>
      <Body sessionId={sessionId} data={data} />
    </Boundary>
  );
}
