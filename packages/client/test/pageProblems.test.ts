import { describe, expect, it } from 'vitest';
import { addProblem, isErrorLevel, MOST, problemCount, problemsPrompt, type PageProblem } from '../src/lib/pageProblems';

describe("a page's problems, from its console", () => {
  it('errors only (a number on the webview tag, a word on newer events)', () => {
    expect([3, 'error'].every(isErrorLevel)).toBe(true);
    expect([0, 1, 2, 'warning', 'info', undefined].some(isErrorLevel)).toBe(false);
  });
  it('the same thing again is counted, not repeated; the oldest fall off; nothing is nothing', () => {
    let l: PageProblem[] = [];
    l = addProblem(l, { kind: 'error', text: 'Uncaught TypeError: x is undefined', source: 'http://localhost:3000/app.js', line: 12 });
    l = addProblem(l, { kind: 'error', text: 'Uncaught TypeError: x is undefined', source: 'http://localhost:3000/app.js', line: 12 });
    l = addProblem(l, { kind: 'error', text: 'Uncaught TypeError: x is undefined', source: 'http://localhost:3000/app.js', line: 40 });
    l = addProblem(l, { kind: 'error', text: '   ' });
    expect(l).toHaveLength(2);
    expect(l[0].n).toBe(2);
    expect(problemCount(l)).toBe(3);
    for (let i = 0; i < MOST + 10; i++) l = addProblem(l, { kind: 'error', text: `e${i}` });
    expect(l).toHaveLength(MOST);
    expect(l.at(-1)!.text).toBe(`e${MOST + 9}`);
    expect(addProblem([], { kind: 'error', text: 'x'.repeat(2000) })[0].text).toHaveLength(600);
  });
  it('what goes to the session: the page, then each problem with where it was', () => {
    const l: PageProblem[] = [
      { kind: 'error', text: 'Uncaught TypeError: x is undefined', source: 'http://localhost:3000/assets/app.js?v=3', line: 12, n: 2 },
      { kind: 'load', text: 'http://localhost:3000/api/user (ERR_CONNECTION_REFUSED)', n: 1 },
    ];
    expect(problemsPrompt({ url: 'http://localhost:3000/', title: 'My app' }, l)).toBe(
      ['The page http://localhost:3000/ ("My app") in my browser shows these problems in its console:', '', '- Uncaught TypeError: x is undefined (localhost:3000/assets/app.js:12) ×2', '- Failed to load: http://localhost:3000/api/user (ERR_CONNECTION_REFUSED)', ''].join('\n'),
    );
    expect(problemsPrompt({ url: 'http://x.test/' }, [l[1]])).toMatch(/shows this problem in its console:/);
  });
});
