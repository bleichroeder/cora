import { describe, expect, it } from 'vitest';
import { teamInboxWhy } from '../src/index';

describe("a team's Inbox item: why it's there", () => {
  it('one post: as before; more: what they are, each kind counted, in the order they came', () => {
    expect(teamInboxWhy(['question'])).toBe('a question for you');
    expect(teamInboxWhy(['handoff'])).toBe('handed to you');
    expect(teamInboxWhy(['report'])).toBe('a report for you');
    expect(teamInboxWhy(['direct'])).toBe('a direct message for you');
    expect(teamInboxWhy(['question', 'handoff'])).toBe('a question and a handoff for you');
    expect(teamInboxWhy(['handoff', 'question'])).toBe('a handoff and a question for you');
    expect(teamInboxWhy(['question', 'handoff', 'question'])).toBe('two questions and a handoff for you');
    expect(teamInboxWhy(['handoff', 'handoff'])).toBe('two handoffs for you');
    expect(teamInboxWhy(['note', 'report', 'direct'])).toBe('a note, a report and a direct message for you');
    expect(teamInboxWhy(Array(12).fill('note'))).toBe('12 notes for you');
  });
});
