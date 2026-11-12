import { describe, expect, it } from 'vitest';
import { carriesImage, enterWhenSettled } from '../src/input';

describe("the composer's Enter, for a prompt carrying an image", () => {
  it('knows a prompt that carries an image path (quoted or not), and one that does not', () => {
    expect(carriesImage('look at this\n\n"C:\\Users\\me\\.cora\\attachments\\s1\\shot.png"')).toBe(true);
    expect(carriesImage('C:/tmp/board.JPEG')).toBe(true);
    expect(carriesImage('rename foo.png to bar in the code please')).toBe(false);
    expect(carriesImage('just words')).toBe(false);
  });

  it("waits while Claude Code is still taking the image in (its screen changing), then Enter once it holds still", async () => {
    const screens = [['> look'], ['> look', 'reading…'], ['> look [Image #1]'], ['> look [Image #1]'], ['> look [Image #1]']];
    let looks = 0;
    let slept = 0;
    let enteredAt = -1;
    await enterWhenSettled({
      screen: () => screens[Math.min(looks++, screens.length - 1)],
      enter: () => (enteredAt = looks),
      first: 400,
      max: 4000,
      sleep: async (ms) => void (slept += ms),
    });
    // not before the screen held still for two looks in a row
    expect(enteredAt).toBe(5);
    expect(slept).toBe(400 + 4 * 100);
  });

  it('a screen that never holds still (a spinner) still gets its Enter, at the most after max', async () => {
    let n = 0;
    let slept = 0;
    let entered = false;
    await enterWhenSettled({ screen: () => [`spin ${n++}`], enter: () => (entered = true), first: 400, max: 1000, sleep: async (ms) => void (slept += ms) });
    expect(entered).toBe(true);
    expect(slept).toBe(400 + 1000);
  });
});
