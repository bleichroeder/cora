import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteProject } from '../src/state/projects';
import { deleteVideo, sendVideoInSlack } from '../src/state/videos';

// the server refuses a JSON content type with nothing in it ("Bad Request"): a call without a body sends neither
describe('calls without a body', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('send no JSON content type', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}', { status: 200 });
    });
    expect((await sendVideoInSlack('v1')).ok).toBe(true);
    await deleteVideo('v1');
    await deleteProject('p1');
    expect(seen).toHaveLength(3);
    for (const init of seen) {
      expect(init.body).toBeUndefined();
      expect(init.headers).toBeUndefined();
    }
  });
});
