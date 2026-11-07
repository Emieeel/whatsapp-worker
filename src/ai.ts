import type { Logger } from 'pino';
import type { AiConfig } from './config.js';

/** Sends one prompt to Claude and returns the text reply, or null on any failure. */
export type AskFn = (system: string, prompt: string) => Promise<string | null>;

/**
 * Players appear in prompts as {p1}, {p2}, ... so names never leave the machine.
 * `restore` puts the real names back into the reply.
 */
export class Pseudonyms {
  private readonly tokens = new Map<string, string>();
  private readonly names = new Map<string, string>();

  token(jid: string, name: string): string {
    let t = this.tokens.get(jid);
    if (!t) {
      t = `{p${this.tokens.size + 1}}`;
      this.tokens.set(jid, t);
      this.names.set(t, name);
    }
    return t;
  }

  restore(text: string): string {
    return text.replace(/\{\s*p(\d+)\s*\}/gi, (_m, n: string) => this.names.get(`{p${n}}`) ?? 'iemand');
  }
}

/**
 * Tidy a model reply for WhatsApp: keep only the part inside <tag>...</tag> when the model used
 * the tag (drops any chatter around it), one paragraph, no wrapping quotes. Tokens stay as they are.
 */
export function extractReply(raw: string, tag?: string): string | null {
  const tagged = tag ? new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(raw)?.[1] : undefined;
  const text = (tagged ?? raw)
    .replace(/\s+/g, ' ')
    .replace(/^["'“”„]+|["'“”„]+$/g, '')
    .trim();
  return text && text.length <= 400 ? text : null;
}

/** extractReply with the real names put back. */
export function cleanReply(raw: string, pseudo: Pseudonyms, tag?: string): string | null {
  const text = extractReply(raw, tag);
  return text ? pseudo.restore(text) : null;
}

/** Claude client for jokes and roasts, or null when no API key is configured. */
export function makeAsk(cfg: AiConfig, log: Logger): AskFn | null {
  const apiKey = cfg.apiKey;
  if (!apiKey) return null;
  if (cfg.provider === 'openrouter') return askOpenRouter(apiKey, cfg.model, log);
  return async (system, prompt) => {
    try {
      // Loaded lazily so the SDK costs no memory until it is used.
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey, timeout: 30_000, maxRetries: 1 });
      const response = await client.messages.create({
        model: cfg.model,
        max_tokens: 2048,
        output_config: { effort: 'low' },
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      if (response.stop_reason !== 'end_turn') {
        log.warn({ stopReason: response.stop_reason }, 'Claude did not finish the reply; skipping');
        return null;
      }
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ');
    } catch (err) {
      log.warn({ err: (err as Error).message, status: (err as { status?: number }).status }, 'Claude request failed');
      return null;
    }
  };
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface OpenRouterError {
  message?: string;
  code?: number | string;
}

interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null };
    error?: OpenRouterError;
  }>;
  error?: OpenRouterError;
}

/** Same request through OpenRouter's chat completions API (plain fetch, no extra dependency). */
export function askOpenRouter(apiKey: string, model: string, log: Logger, fetchImpl: typeof fetch = fetch): AskFn {
  return async (system, prompt) => {
    try {
      const res = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'whatsapp-score-bot',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          reasoning: { effort: 'low', exclude: true },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => null)) as OpenRouterResponse | null;
      if (!res.ok || !body || body.error) {
        log.warn({ status: res.status, err: body?.error?.message }, 'OpenRouter request failed');
        return null;
      }
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (!choice || choice.error || choice.finish_reason !== 'stop' || !content) {
        log.warn({ finishReason: choice?.finish_reason, err: choice?.error?.message }, 'OpenRouter gave no usable reply');
        return null;
      }
      return content;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'OpenRouter request failed');
      return null;
    }
  };
}
