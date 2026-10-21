import { describe, expect, it } from 'vitest';
import { Follow, atEnd, type ScrollBox } from '../src/lib/follow';

/** A scroll box like the transcript's feed: the browser clamps scrollTop to what the content allows. */
function box(content: number, height: number, top = Math.max(0, content - height)) {
  let scrollTop = top;
  const b = {
    content,
    clientHeight: height,
    get scrollHeight() {
      return Math.max(b.content, b.clientHeight);
    },
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(v: number) {
      scrollTop = Math.max(0, Math.min(v, b.scrollHeight - b.clientHeight));
    },
  };
  return b satisfies ScrollBox;
}

describe('following the newest activity', () => {
  it('a dialog opening below the transcript (the feed gets shorter, no scroll, no new event) does not hide the newest rows', () => {
    const el = box(5000, 685);
    const f = new Follow();
    f.setView('s1\nall');
    expect(f.scrolled(el)).toBe(true);
    // the compact terminal grows for a permission prompt: 240px less room, scrollTop unchanged
    el.clientHeight = 445;
    expect(atEnd(el)).toBe(false);
    f.resized(el);
    expect(atEnd(el)).toBe(true);
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(0);
  });

  it('rows growing after they were measured keep the end in view too', () => {
    const el = box(5000, 685);
    const f = new Follow();
    f.setView('s1\nall');
    el.content = 5400;
    f.resized(el);
    expect(el.scrollTop).toBe(5400 - 685);
  });

  it('reading further up stops following; resizes then leave the position alone', () => {
    const el = box(5000, 685);
    const f = new Follow();
    f.setView('s1\nall');
    el.scrollTop = 2000;
    expect(f.scrolled(el)).toBe(false);
    el.clientHeight = 445;
    f.resized(el);
    expect(el.scrollTop).toBe(2000);
    // scrolling back down to (near) the end follows again
    el.scrollTop = 5000;
    expect(f.scrolled(el)).toBe(true);
  });

  it('switching session or agent starts at the end again, even if the last view was scrolled up', () => {
    const f = new Follow();
    expect(f.setView('s1\nall')).toBe(true);
    const el = box(5000, 685);
    el.scrollTop = 1000;
    f.scrolled(el);
    expect(f.following).toBe(false);
    expect(f.setView('s1\nall')).toBe(false);
    expect(f.following).toBe(false);
    // the new view's first scroll must already see following = true (before, a separate effect reset it too late)
    expect(f.setView('s1\nmain')).toBe(true);
    expect(f.following).toBe(true);
    f.scrolled(el);
    expect(f.setView('s2\nall')).toBe(true);
    expect(f.following).toBe(true);
  });

  it('"new activity" resumes following', () => {
    const el = box(5000, 685);
    const f = new Follow();
    f.setView('s1\nall');
    el.scrollTop = 0;
    f.scrolled(el);
    f.resume(el);
    expect(f.following).toBe(true);
    expect(atEnd(el)).toBe(true);
  });
});
