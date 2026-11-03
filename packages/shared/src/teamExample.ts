import type { Seat, Team } from './teams';
import { newSeat } from './teamHelpers';

const DRILL = 'C:\\ops\\drill';
const monitor = (id: string, name: string, feed: string): Seat =>
  newSeat(id, name, DRILL, {
    instructions: "Watch the uplink monitor for KDRL alerts. Report each new one to Triage: the station, what you saw and since when. Don't diagnose it.",
    agent: { model: 'haiku', effort: 'low', tools: ['Read', 'Bash', 'Monitor'], disallowedTools: ['Edit', 'Write'], permissions: { allow: ['Bash(curl:*)'], deny: ['Bash(rm:*)'] } },
    skills: ['drill-alerts'],
    startup: { prompt: "Start watching the uplink feed for tonight's drill.", monitor: `tail -f ${DRILL}\\${feed}.log` },
    limits: { turnsPerHour: 30 },
  });

/**
 * The drill team as applied (version 4): two monitors report to Triage, which hands encoder and network work to their
 * analysts (split by issue type). The ops shape, as an example for tests and for the builder's skill.
 */
export function exampleTeam(): Team {
  return {
    version: 4,
    seats: [
      monitor('monitor-a', 'Monitor A', 'feed-a'),
      monitor('monitor-b', 'Monitor B', 'feed-b'),
      newSeat('triage', 'Triage', DRILL, {
        instructions: 'You are the hub. Read each report, set its severity and its issue type (encoder, network or ingest), open an incident for it, and hand it to Analysts with the issue label.',
        agent: { model: 'sonnet', effort: 'high', tools: ['Read', 'Grep'], permissions: { allow: ['Read(//ops/**)'] } },
        skills: ['drill-triage', 'station-runbook'],
        startup: { prompt: "You run triage for tonight's drill. Wait for the monitors' reports." },
      }),
      newSeat('analyst-enc', 'Encoder analyst', DRILL, {
        instructions: 'Claim encoder incidents offered to you. Diagnose from the encoder logs and frame stats; say what you found and close it, or ask Triage.',
        agent: { model: 'sonnet', effort: 'high', tools: ['Read', 'Bash', 'Grep'], permissions: { allow: ['Bash(ffprobe:*)'], ask: ['Bash(systemctl restart:*)'] } },
        skills: ['encoder-runbook'],
        folder: { path: DRILL, worktree: true },
      }),
      newSeat('analyst-net', 'Network analyst', DRILL, {
        instructions: 'Claim network incidents offered to you. Check loss, latency and the routes to the station; say what you found and close it, or ask Triage.',
        agent: { model: 'sonnet', effort: 'medium', tools: ['Read', 'Bash'], permissions: { allow: ['Bash(ping:*)', 'Bash(tracert:*)'] } },
        skills: ['network-runbook'],
      }),
    ],
    groups: [
      { id: 'analysts', name: 'Analysts', members: ['encoder-analysts', 'network-analysts'], dispatch: 'claim', split: { label: 'issue', to: { encoder: 'encoder-analysts', network: 'network-analysts' } } },
      { id: 'encoder-analysts', name: 'Encoder analysts', members: ['analyst-enc'], dispatch: 'claim' },
      { id: 'network-analysts', name: 'Network analysts', members: ['analyst-net'], dispatch: 'claim' },
    ],
    labels: [{ id: 'issue', name: 'Issue type', values: ['encoder', 'network', 'ingest'] }],
    routes: [
      { id: 'r-monitors', from: ['seat:monitor-a', 'seat:monitor-b'], to: 'seat:triage', kinds: ['report', 'direct'], wake: 'auto' },
      { id: 'r-handoff', from: ['seat:triage'], to: 'group:analysts', kinds: ['handoff'], labels: { issue: ['encoder', 'network'] }, wake: 'auto', template: { fields: ['station', 'symptom', 'since'] } },
      { id: 'r-back', from: ['group:analysts'], to: 'seat:triage', kinds: ['note', 'question', 'direct'], wake: 'auto' },
    ],
    fallback: 'seat:triage',
    escalation: [
      { when: 'unclaimed', after: 10, then: ['reoffer', 'tell-lead'] },
      { when: 'critical', then: ['tell-user'] },
    ],
  };
}
