// WhatsApp from the rep's own account, through click-to-chat links: the call
// page opens the chat with the message written in, and the rep sends it (or
// calls) in WhatsApp. Nothing goes through Meta's or Twilio's WhatsApp API:
// Meta doesn't deliver a business's marketing messages to US numbers, and a
// US business number can't place WhatsApp calls. The rep logs what happened
// on the call page (workflows/call-logged.ts). Pure, unit tested.

import { extensionOf, toE164 } from './phone';
import { timeOfDay } from './dates';

// Where the link opens: the WhatsApp Desktop app, or WhatsApp Web in a tab.
export const WHATSAPP_OPENS = ['app', 'web'] as const;
export type WhatsAppOpens = (typeof WHATSAPP_OPENS)[number];

export function whatsappOpens(value: string | null | undefined): WhatsAppOpens {
  return value === 'web' ? 'web' : 'app';
}

// The chat with `e164`, `text` written in and not yet sent. WhatsApp wants
// the number as digits only, country code first.
export function whatsappLink(e164: string, text: string, opens: WhatsAppOpens): string {
  const query = new URLSearchParams({ phone: e164.replace(/\D/g, '') });
  if (text) query.set('text', text);
  // URLSearchParams writes a space as "+", which WhatsApp shows as a plus.
  const params = query.toString().replace(/\+/g, '%20');
  return opens === 'web' ? `https://web.whatsapp.com/send?${params}` : `whatsapp://send?${params}`;
}

// A number someone could have WhatsApp on: one the app can read, and not an
// office line with an extension.
export function whatsappNumber(raw: string | null | undefined): string | null {
  return extensionOf(raw) ? null : toE164(raw);
}

// Florida's telemarketing law (the FTSA) allows calls and messages from 8am
// to 8pm in the recipient's time. The rep and the people they message are in
// the same time zone, so the rep's clock stands in for theirs.
const FIRST_HOUR = 8;
const LAST_HOUR = 20;

export function contactHoursNote(nowMs: number, timeZone: string): string | null {
  const { hour } = timeOfDay(nowMs, timeZone);
  if (hour >= FIRST_HOUR && hour < LAST_HOUR) return null;
  return 'It’s outside 8am to 8pm. Florida’s telemarketing law only allows calls and messages to people in Florida between those hours, their time.';
}
