import { describe, expect, it } from 'vitest';
import { checkScript, debriefMarkdown, debriefSpan, nextBeat, nextStep, prevStep, type Debrief, type DebriefScript } from '../src/debrief';

const script: DebriefScript = {
  title: 'Port retry at start',
  task: "Cora didn't start after a reboot.",
  depth: 'quick',
  steps: [
    { title: 'What was asked', kind: 'context', beats: [{ text: 'Cora stayed down after a reboot.' }] },
    { title: 'The fix', kind: 'change', path: 'C:/code/cora/packages/server/src/server.ts', range: [615, 616], diff: true, beats: [{ text: 'It now retries.', range: [616, 616] }, { text: 'For up to a minute.' }], why: 'Windows held the port a moment.' },
  ],
};

describe('a debrief script', () => {
  it('a good one passes; what fails is named (its step, its beat)', () => {
    expect(checkScript(script)).toMatchObject({ ok: true });
    const many = { ...script, steps: Array.from({ length: 13 }, () => script.steps[0]) };
    expect(checkScript(many)).toEqual({ ok: false, errors: ['steps: 1 to 12'] });
    const bad = checkScript({ ...script, steps: [{ ...script.steps[1], range: [20, 10], beats: [{ text: 'x'.repeat(401) }] }, { ...script.steps[0], beats: [] }] });
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join(' | ');
    expect(errors).toContain('step 1: range is');
    expect(errors).toContain('step 1, beat 1');
    expect(errors).toContain('step 2: 1 to 4 beats');
    expect(checkScript({ ...script, steps: [{ title: 'x', kind: 'change', range: [1, 2], beats: [{ text: 'a' }] }] })).toMatchObject({ ok: false, errors: ['step 1: lines need a file (path)'] });
    expect(checkScript({ ...script, depth: 'deep' })).toMatchObject({ ok: false });
  });

  it('as markdown: the task, each step with its code and why, the quiz', () => {
    const d: Debrief = { ...script, id: 'd1', sessionId: 's', createdAt: 1, snaps: { 1: { start: 610, lines: Array.from({ length: 10 }, (_, i) => `line ${610 + i}`) } }, quiz: [{ q: 'Why retry?', options: ['speed', 'a held port'], answer: 1, why: 'Windows held it.' }] };
    const md = debriefMarkdown(d, (p) => p.replace('C:/code/cora/', ''));
    expect(md).toContain('# Port retry at start');
    expect(md).toContain("**Task:** Cora didn't start after a reboot.");
    expect(md).toContain('`packages/server/src/server.ts:615-616`');
    expect(md).toContain('```\nline 615\nline 616\n```');
    expect(md).toContain('**Why:** Windows held the port a moment.');
    expect(md).toContain('   - **a held port**');
  });

  it('the player: beat by beat, then the next step; null at the end; back to the step before', () => {
    expect(nextBeat(script, { step: 1, beat: 0 })).toEqual({ step: 1, beat: 1 });
    expect(nextBeat(script, { step: 0, beat: 0 })).toEqual({ step: 1, beat: 0 });
    expect(nextBeat(script, { step: 1, beat: 1 })).toBeNull();
    expect(nextStep(script, { step: 1, beat: 0 })).toBeNull();
    expect(prevStep(script, { step: 1, beat: 1 })).toEqual({ step: 0, beat: 0 });
    expect(prevStep(script, { step: 0, beat: 0 })).toEqual({ step: 0, beat: 0 });
  });

  it('its span: from the turn that last changed its files; what changed then, and what it skips', () => {
    const key = (p: string) => p.toLowerCase();
    const changes = [
      { path: 'C:/r/old.ts', ts: 50 },
      { path: 'C:/r/a.ts', ts: 60 },
      { path: 'C:/r/a.ts', ts: 210 },
      { path: 'C:/r/b.ts', ts: 220 },
      { path: 'C:/r/c.ts', ts: 230 },
    ];
    const span = debriefSpan({ prompts: [40, 200, 300], changes, files: ['C:/R/A.ts', 'C:/r/b.ts'], now: 400, key });
    expect(span).toEqual({ from: 200, changed: ['C:/r/a.ts', 'C:/r/b.ts', 'C:/r/c.ts'], missed: ['C:/r/c.ts'] });
    expect(debriefSpan({ prompts: [40], changes, files: ['C:/r/none.ts'], now: 400, key })).toBeNull();
  });
});
