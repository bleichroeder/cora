import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CertTrust, hostOf, isLocal, neverAllowed, whyUntrusted, type CertAsk, type CertProblem } from '../src/certTrust';
import { freePath, safeName, withDownload, KEPT, type Download } from '../src/downloads';

const cert = (o: Partial<CertProblem> = {}): CertProblem => ({ url: 'https://localhost:8443/', error: 'net::ERR_CERT_AUTHORITY_INVALID', fingerprint: 'sha256/AAA', subject: 'localhost', issuer: 'localhost', validFrom: 1, validTo: 2, ...o });

describe("a page whose certificate isn't trusted", () => {
  const setup = () => {
    const asked: CertAsk[] = [];
    return { trust: new CertTrust({ ask: (a) => asked.push(a) }), asked };
  };
  it("is asked about once: the page's other requests wait for the same answer, and continuing holds for that site", () => {
    const { trust, asked } = setup();
    const got: boolean[] = [];
    trust.problem(cert(), (ok) => got.push(ok));
    trust.problem(cert({ url: 'https://localhost:8443/app.js' }), (ok) => got.push(ok));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ host: 'localhost:8443', local: true, why: "It's signed by itself or by an authority this PC doesn't know." });
    trust.answer(asked[0].id, true);
    expect(got).toEqual([true, true]);
    trust.problem(cert({ url: 'https://localhost:8443/later' }), (ok) => got.push(ok));
    expect(asked).toHaveLength(1);
    expect(got).toEqual([true, true, true]);
  });
  it('a different certificate for the same site asks again (what an attack would look like); another site too', () => {
    const { trust, asked } = setup();
    trust.problem(cert(), () => {});
    trust.answer(asked[0].id, true);
    trust.problem(cert({ fingerprint: 'sha256/BBB' }), () => {});
    trust.problem(cert({ url: 'https://staging.internal/' }), () => {});
    expect(asked).toHaveLength(3);
    expect(asked[2].local).toBe(false);
  });
  it('not continuing refuses, and asks again next time; nobody answering refuses', () => {
    const { trust, asked } = setup();
    const got: boolean[] = [];
    trust.problem(cert(), (ok) => got.push(ok));
    trust.answer(asked[0].id, false);
    trust.problem(cert(), (ok) => got.push(ok));
    expect(asked).toHaveLength(2);
    trust.cancelAll();
    expect(got).toEqual([false, false]);
    expect(trust.pending()).toEqual([]);
  });
  it('a revoked certificate is never offered; nor one with nothing to tell it by', () => {
    const { trust, asked } = setup();
    const got: boolean[] = [];
    trust.problem(cert({ error: 'net::ERR_CERT_REVOKED' }), (ok) => got.push(ok));
    trust.problem(cert({ fingerprint: '' }), (ok) => got.push(ok));
    trust.problem(cert({ url: 'not a url' }), (ok) => got.push(ok));
    expect(asked).toHaveLength(0);
    expect(got).toEqual([false, false, false]);
    expect(neverAllowed('net::ERR_CERT_REVOKED')).toBe(true);
  });
  it('says what the error means, and which sites are this PC', () => {
    expect(whyUntrusted('net::ERR_CERT_DATE_INVALID')).toMatch(/expired/);
    expect(whyUntrusted('net::ERR_CERT_COMMON_NAME_INVALID')).toMatch(/different address/);
    expect(whyUntrusted('net::ERR_SOMETHING_NEW')).toBe('Chromium says: ERR_SOMETHING_NEW');
    expect(isLocal('https://127.0.0.1:3000/')).toBe(true);
    expect(isLocal('https://app.localhost/')).toBe(true);
    expect(isLocal('https://localhost.evil.test/')).toBe(false);
    expect(hostOf('https://Example.TEST:444/x')).toBe('example.test:444');
  });
});

describe('where a download is saved', () => {
  it("under the site's name, tidied: never a path out of the folder, a device's name, or nothing", () => {
    expect(safeName('report.pdf')).toBe('report.pdf');
    expect(safeName('..\\..\\Windows\\evil.exe')).toBe('evil.exe');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(safeName('CON.txt')).toBe('_CON.txt');
    expect(safeName('  ...  ')).toBe('download');
    expect(safeName('trailing.dots...')).toBe('trailing.dots');
  });
  it('a name already there gets a number', () => {
    const have = new Set([join('D', 'report.pdf'), join('D', 'report (2).pdf')]);
    expect(freePath('D', 'report.pdf', (p) => have.has(p))).toBe(join('D', 'report (3).pdf'));
    expect(freePath('D', 'new.zip', () => false)).toBe(join('D', 'new.zip'));
  });
});

describe('the list of downloads', () => {
  const d = (id: string, state: Download['state'] = 'done'): Download => ({ id, name: `${id}.zip`, url: 'https://x.test/f', path: `D/${id}.zip`, state, received: 1, total: 1, startedAt: 1 });
  it('newest first; one that changes stays in its place; old finished ones fall off, ones still going never do', () => {
    let list: Download[] = [];
    list = withDownload(list, d('a', 'going'));
    list = withDownload(list, d('b', 'going'));
    expect(list.map((x) => x.id)).toEqual(['b', 'a']);
    list = withDownload(list, d('a', 'done'));
    expect(list.map((x) => `${x.id}:${x.state}`)).toEqual(['b:going', 'a:done']);
    for (let i = 0; i < KEPT + 5; i++) list = withDownload(list, d(`n${i}`));
    expect(list.filter((x) => x.state !== 'going')).toHaveLength(KEPT);
    expect(list.some((x) => x.id === 'b')).toBe(true);
    expect(list.some((x) => x.id === 'a')).toBe(false);
  });
});
