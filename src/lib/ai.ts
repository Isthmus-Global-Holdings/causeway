// Workers AI for call transcripts: Deepgram Nova-3 for speech-to-text and a
// small Llama for the summary. Both draw on the account's free daily Workers
// AI allowance (10,000 neurons: roughly 20 minutes of Nova-3 audio, while a
// summary costs a few neurons).
// https://developers.cloudflare.com/workers-ai/models/nova-3/

import type { NovaResult } from './transcript';
import type { Transcriber } from '../workflows/transcribe';

const SPEECH_MODEL = '@cf/deepgram/nova-3';
const SUMMARY_MODEL = '@cf/meta/llama-3.2-3b-instruct';

export function workersAiTranscriber(ai: Ai): Transcriber {
  return {
    async transcribe(audio, contentType) {
      const out = await ai.run(SPEECH_MODEL, {
        audio: { body: audio, contentType },
        // Twilio's dual-channel recording: the rep on one channel, the
        // prospect on the other. Transcribing them apart is what labels them.
        multichannel: true,
        punctuate: true,
        smart_format: true,
      });
      return out as NovaResult;
    },

    async summarize(messages) {
      const out = await ai.run(SUMMARY_MODEL, { messages, max_tokens: 300 });
      return (out as { response?: string }).response ?? '';
    },
  };
}
