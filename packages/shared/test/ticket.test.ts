import { describe, expect, it } from 'vitest';
import { jiraPrompt, ticketInPrompt } from '../src/jira';

const known = (p: string) => ['ACME', 'OPS'].includes(p);

describe('ticketInPrompt', () => {
  it('/jira KEY or /jira <link>, whatever the project', () => {
    expect(ticketInPrompt('/jira ACME-5206')).toEqual({ key: 'ACME-5206' });
    expect(ticketInPrompt(jiraPrompt('ZZ-1'))).toEqual({ key: 'ZZ-1' });
    expect(ticketInPrompt('  /jira acme-12.  ')).toEqual({ key: 'ACME-12' });
    expect(ticketInPrompt('/jira https://acme.atlassian.net/browse/ACME-5065')).toEqual({ key: 'ACME-5065', site: 'acme.atlassian.net' });
    expect(ticketInPrompt('/jira')).toBeNull();
    expect(ticketInPrompt('/jirafy ACME-1')).toBeNull();
  });
  it('a Jira link anywhere in the prompt', () => {
    expect(ticketInPrompt('please look at https://acme.atlassian.net/jira/software/projects/ID/boards/1?selectedIssue=ACME-77, thanks')).toEqual({ key: 'ACME-77', site: 'acme.atlassian.net' });
    expect(ticketInPrompt('(see https://acme.atlassian.net/browse/OPS-3)')).toEqual({ key: 'OPS-3', site: 'acme.atlassian.net' });
    expect(ticketInPrompt('https://gitlab.com/x/browse/ACME-1')).toBeNull();
  });
  it('a bare key only of a known project', () => {
    expect(ticketInPrompt('fix UTF-8 handling for ACME-5206')).toBeNull();
    expect(ticketInPrompt('fix UTF-8 handling for ACME-5206', known)).toEqual({ key: 'ACME-5206' });
    expect(ticketInPrompt('SHA-256 and ISO-8601', known)).toBeNull();
    expect(ticketInPrompt('', known)).toBeNull();
  });
});
