import { describe, expect, it } from 'vitest';
import { plainName, sessionName } from '../src/lib/format';
import { parseTicketInput, ticketLabel } from '../src/lib/ticket';

describe('sessionName', () => {
  it('your name, then the suggested name, then Claude Code\'s title, then the folder', () => {
    const s = { id: 'abcdef1234', project: 'cora', title: 'Fix the hook sink race', autoName: 'Fix hooks sink', alias: 'Hooks' };
    expect(sessionName(s)).toBe('Hooks');
    expect(sessionName({ ...s, alias: null })).toBe('Fix hooks sink');
    expect(sessionName({ ...s, alias: null, autoName: null })).toBe('Fix the hook sink race');
    expect(sessionName({ ...s, alias: null, autoName: null, title: '' })).toBe('cora');
    expect(sessionName({ id: 'abcdef1234', project: '', title: '' })).toBe('abcdef12');
  });

  it('a ticket names it after your name, once its summary is known', () => {
    const s = { id: 'abcdef1234', project: 'cora', title: 'Jira ticket investigation', autoName: 'Investigate ID ticket', alias: 'Mine' };
    const ticket = { key: 'ACME-5206', site: null, summary: 'Fix the login redirect' };
    expect(sessionName({ ...s, ticket })).toBe('Mine');
    expect(sessionName({ ...s, alias: null, ticket })).toBe('ACME-5206 · Fix the login redirect');
    expect(sessionName({ ...s, alias: null, ticket: { ...ticket, summary: null } })).toBe('Investigate ID ticket');
    expect(sessionName({ ...s, alias: null, ticket: null })).toBe('Investigate ID ticket');
    expect(plainName({ ...s, alias: null })).toBe('Investigate ID ticket');
  });
});

describe('ticketLabel (the session list)', () => {
  const base = { id: 'abcdef1234', project: 'cora', title: '', autoName: null, alias: null };
  it('the key as a chip, then the summary (or the name while the summary is unknown)', () => {
    expect(ticketLabel({ ...base, ticket: { key: 'ACME-5', site: null, summary: 'Fix it' } })).toEqual({ key: 'ACME-5', text: 'Fix it' });
    expect(ticketLabel({ ...base, ticket: { key: 'ACME-5', site: null, summary: null } })).toEqual({ key: 'ACME-5', text: 'cora' });
    expect(ticketLabel({ ...base, alias: 'Mine', ticket: { key: 'ACME-5', site: null, summary: 'Fix it' } })).toEqual({ key: 'ACME-5', text: 'Mine' });
    expect(ticketLabel(base)).toEqual({ key: null, text: 'cora' });
  });
  it('no second chip when the name already has the key', () => {
    expect(ticketLabel({ ...base, alias: 'ACME-5 redo', ticket: { key: 'ACME-5', site: null, summary: 'Fix it' } })).toEqual({ key: null, text: 'ACME-5 redo' });
    expect(ticketLabel({ ...base, autoName: 'Look at ACME-5', ticket: { key: 'ACME-5', site: null, summary: null } })).toEqual({ key: null, text: 'Look at ACME-5' });
    // ACME-50 isn't ACME-5
    expect(ticketLabel({ ...base, alias: 'ACME-50', ticket: { key: 'ACME-5', site: null, summary: null } }).key).toBe('ACME-5');
  });
});

describe('parseTicketInput', () => {
  it('a key in any case, or a Jira link', () => {
    expect(parseTicketInput(' acme-5206 ')).toEqual({ key: 'ACME-5206' });
    expect(parseTicketInput('https://acme.atlassian.net/browse/ACME-5065')).toEqual({ key: 'ACME-5065', site: 'acme.atlassian.net' });
    expect(parseTicketInput('acme.atlassian.net/browse/ACME-5065')).toEqual({ key: 'ACME-5065', site: 'acme.atlassian.net' });
    expect(parseTicketInput('https://acme.atlassian.net/jira/software/c/projects/ID/boards/3?selectedIssue=ACME-9')).toEqual({ key: 'ACME-9', site: 'acme.atlassian.net' });
    expect(parseTicketInput('https://jira.example.com/browse/ACME-9', 'jira.example.com')).toEqual({ key: 'ACME-9', site: 'jira.example.com' });
  });
  it('anything else is not a ticket', () => {
    for (const t of ['', 'ACME', 'ID-', '5206', 'hello world', 'https://gitlab.com/x/browse/ACME-9', 'ACME-5206 and more']) expect(parseTicketInput(t), t).toBeNull();
  });
});
