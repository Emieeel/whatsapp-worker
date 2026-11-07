import { describe, expect, it } from 'vitest';
import { askOpenRouter } from '../src/ai.js';
import { silentLogger } from './helpers.js';

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('askOpenRouter', () => {
  it('sends system and user message and returns the reply', async () => {
    const { impl, calls } = fakeFetch(200, { choices: [{ finish_reason: 'stop', message: { content: 'Ha.' } }] });
    const ask = askOpenRouter('sk-or-test', 'anthropic/claude-haiku-5.5', silentLogger, impl);
    expect(await ask('SYSTEM', 'PROMPT')).toBe('Ha.');

    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      model: 'anthropic/claude-haiku-5.5',
      max_tokens: 2048,
      reasoning: { effort: 'low', exclude: true },
      messages: [
        { role: 'system', content: 'SYSTEM' },
        { role: 'user', content: 'PROMPT' },
      ],
    });
  });

  it('returns null on errors and unfinished replies', async () => {
    const cases = [
      fakeFetch(401, { error: { message: 'No auth credentials found', code: 401 } }),
      fakeFetch(200, { choices: [{ finish_reason: 'length', message: { content: 'Ha' } }] }),
      fakeFetch(200, { choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
      fakeFetch(200, { choices: [{ finish_reason: 'error', error: { message: 'upstream' } }] }),
    ];
    for (const { impl } of cases) {
      expect(await askOpenRouter('k', 'm', silentLogger, impl)('s', 'p')).toBeNull();
    }
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await askOpenRouter('k', 'm', silentLogger, throwing)('s', 'p')).toBeNull();
  });
});
