import type { PanelKind } from '../../lib/boardLayout';
import { VideosPanel } from '../Videos';
import { RemoteBrowserView } from '../RemoteBrowser';
import { desktop } from '../../lib/desktop';
import { IncidentsPanel, KnownPanel } from './ItemPanels';
import { ActivityPanel, BriefPanel, ConstellationPanel, LoopsPanel, MembersPanel, NotesBoardPanel, ProjectPanel, ReposPanel, ThreadPanel } from './ProjectPanels';
import { PrivateCard } from '../Live';
import { useLive } from '../../state/live';
import type { BoardData } from '../LiveBoard';
import { Boundary } from '../Boundary';
import { BackgroundPanel, ChangesPanel, GitPanel, TestsPanel } from './CodePanels';
import { DeploysPanel, PipelinePanel, TicketPanel } from './DeliveryPanels';
import { MentionsPanel, NeedsPanel, NotesPanel, SessionsPanel } from './AroundPanels';
import { ContextPanel, GoalPanel, UsagePanel } from './SessionPanels';
import { BrowserPanel, TerminalPanel } from './ToolPanels';
import { RecapPanel } from '../Recap';
import { MemePanel } from './MemePanel';
import { JournalPanel } from './JournalPanel';
import { IdePanel } from './IdePanel';
import { WorktreesPanel } from './WorktreesPanel';
import { TodayPanel } from './TodayPanel';
import { GridOverview } from '../GridOverview';
import './panels.css';

type Props = { sessionId: string; data: BoardData };
/** Cora opened on its own PC (not from another device over your tailnet). */
const BODIES: Partial<Record<PanelKind, React.ComponentType<Props>>> = {
  goal: GoalPanel,
  recap: RecapPanel,
  memes: MemePanel,
  journal: JournalPanel,
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
  videos: (p: Props) => <VideosPanel sessionId={p.sessionId} />,
  // away from the desktop app: the session's browser rendered on your PC
  browser: (p: Props) => (desktop?.browser ? <BrowserPanel {...p} /> : <RemoteBrowserView sessionId={p.sessionId} />),
  // VS Code runs on your PC, at an address only it can open: from another device (the iPad), a word instead
  ide: (p: Props) => <IdePanel {...p} />,
  worktrees: WorktreesPanel,
  today: TodayPanel,
  constellation: ConstellationPanel,
  members: MembersPanel,
  loops: LoopsPanel,
  incidents: IncidentsPanel,
  known: KnownPanel,
  pnotes: NotesBoardPanel,
  thread: ThreadPanel,
  brief: BriefPanel,
  repos: ReposPanel,
  activity: ActivityPanel,
  project: ProjectPanel,
  // every live session as a card (the Overview's grid, on Cora's board)
  wall: () => (
    <div className="lb-wall">
      <GridOverview />
    </div>
  ),
};

/** The live board's other panels (the first four live in LiveBoard), each in its own boundary: one failing leaves the rest. */
export function MorePanel({ k, sessionId, data }: { k: PanelKind } & Props) {
  const Body = BODIES[k];
  // a guest: your private areas' panels stay a quiet card (unless you've opened that area to them)
  const area = k === 'notes' ? 'notes' : k === 'mentions' ? 'inbox' : null;
  const closed = useLive((s) => s.role === 'guest' && (k === 'browser' || k === 'ide' || k === 'project' || (!!area && !s.live?.open.includes(area))));
  if (!Body) return null;
  if (closed) return <PrivateCard />;
  return (
    <Boundary quiet name={`board ${k}`}>
      <Body sessionId={sessionId} data={data} />
    </Boundary>
  );
}
