import { describe, expect, it } from 'vitest';
import { prettyModel } from '../src/lib/format';

describe('prettyModel', () => {
  it('puts model ids in plain words', () => {
    expect(prettyModel('claude-opus-5-5[1m]')).toEqual({ name: 'Opus 5.5', ctx: '1M' });
    expect(prettyModel('claude-sonnet-5')).toEqual({ name: 'Sonnet 5', ctx: '200k' });
    expect(prettyModel('claude-haiku-4-5-20251001')).toEqual({ name: 'Haiku 4.5', ctx: '200k' });
    expect(prettyModel('claude-fable-5-1')).toEqual({ name: 'Fable 5.1', ctx: '200k' });
    expect(prettyModel('some-custom-model-x')?.name).toBe('some-custom-model-x');
    expect(prettyModel(undefined)).toBeNull();
  });
});
