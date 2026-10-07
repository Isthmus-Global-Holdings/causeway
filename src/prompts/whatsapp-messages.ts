// The rep's WhatsApp messages, written into the chat when the rep opens it
// from a call or interview page (lib/whatsapp.ts), to read, tweak and send
// in WhatsApp. Not a skill copy and not Claude: it's the rep's to edit, like
// the follow-up emails. A WhatsApp message is shorter than an email: who,
// why, one ask.

function hi(firstName: string | null | undefined): string {
  const name = (firstName ?? '').trim();
  return name ? `Hi ${name},` : 'Hi,';
}

// The first message to someone who hasn't heard from the rep on WhatsApp.
export function whatsappOpener(input: { firstName: string | null; repName: string; company: string | null }): string {
  const about = input.company ? `how ${input.company} handles` : 'how trucking companies handle';
  return [
    `${hi(input.firstName)} this is ${firstWord(input.repName)}.`,
    `I'm an early-stage founder learning ${about} quoting, dispatch and invoicing day to day. Not selling anything, just trying to understand where the real friction is.`,
    "Would you have 15 minutes for a quick call this week or next? Happy to send 3 short questions here instead if that's easier.",
  ].join(' ');
}

// To someone with an interview booked: `when` is its time as the rep would
// say it ("today at 2:30 PM", "on Friday at 10:00 AM").
export function whatsappInterviewNote(input: { firstName: string | null; repName: string; when: string }): string {
  return [
    `${hi(input.firstName)} it's ${firstWord(input.repName)}.`,
    `Just checking we're still good for our chat ${input.when}. If another time works better, tell me and I'll move it.`,
  ].join(' ');
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
