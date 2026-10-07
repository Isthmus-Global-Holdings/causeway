// "Draft with Claude": one Messages API call with Anthropic-hosted web search
// and fetch. Non-streaming on purpose. The Workers free plan allows 10ms of
// CPU per request, and parsing one final JSON body costs far less CPU than a
// long event stream. Time spent waiting on the API doesn't count.

import Anthropic from '@anthropic-ai/sdk';
import { DRAFT_SYSTEM_PROMPT } from '../prompts/draft-system';
import { parseDraftResponse, type ParsedDraft } from './draft-format';

export const CLAUDE_MODELS = ['claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5'] as const;
export type ClaudeModel = (typeof CLAUDE_MODELS)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

// A server-side research loop can pause after 10 iterations and has to be
// resumed. Four resumptions is far beyond what one email's research needs.
const MAX_CONTINUATIONS = 4;

export class ClaudeDraftError extends Error {}

export interface DraftUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  webSearches: number;
}

export interface ClaudeDraft extends ParsedDraft {
  model: string;
  usage: DraftUsage;
}

export async function draftWithClaude(
  apiKey: string,
  settings: { model: ClaudeModel; effort: EffortLevel },
  context: string
): Promise<ClaudeDraft> {
  const client = new Anthropic({ apiKey });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: context }];
  const usage: DraftUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, webSearches: 0 };

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const message = await client.beta.messages.create({
      model: settings.model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: settings.effort },
      system: [{ type: 'text', text: DRAFT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 5 },
      ],
      messages,
      // A safety-classifier decline is retried server-side on a fallback
      // model instead of failing the draft. Sonnet 5 doesn't take fallbacks.
      ...(settings.model !== 'claude-sonnet-5'
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    });

    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.webSearches += message.usage.server_tool_use?.web_search_requests ?? 0;

    if (message.stop_reason === 'pause_turn') {
      // Resume by sending the paused turn back as-is. The API continues the
      // research where it stopped, so no extra user message is needed.
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    if (message.stop_reason === 'refusal') {
      throw new ClaudeDraftError('Claude declined to draft this email. Write it by hand, or try again.');
    }
    if (message.stop_reason === 'max_tokens') {
      throw new ClaudeDraftError('Claude ran out of room before finishing the draft. Try again.');
    }

    const text = message.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    try {
      return { ...parseDraftResponse(text), model: message.model, usage };
    } catch (err) {
      throw new ClaudeDraftError(err instanceof Error ? err.message : String(err));
    }
  }
  throw new ClaudeDraftError('Claude kept researching without finishing a draft. Try again.');
}
