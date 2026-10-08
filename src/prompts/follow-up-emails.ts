// The rep's follow-up emails for an interview that didn't happen, written into
// the EMAIL task as its draft so it's ready to read, tweak and send. Not a
// skill copy and not Claude: it's the rep's to edit, like the interview guide.
//
// The cadence around them:
//   1. Logging an interview as No show with an Email follow-up drafts
//      missedInterviewEmail, due today. Logging it as Canceled by them (they
//      told you ahead) drafts canceledInterviewEmail instead.
//   2. Sending it creates tomorrow's CALL task, as any send does.
//   3. If that call gets nowhere, "Email: last try" on its log form drafts
//      closeTheLoopEmail, a few days out.
// The signature is added when the email is sent.

export interface FollowUpEmail {
  subject: string;
  body: string;
}

function greeting(firstName: string | null | undefined): string {
  const name = (firstName ?? '').trim();
  return name ? `Hi ${name},` : 'Hi there,';
}

// `when` is how long ago it was, as saidWhen in lib/dates.ts puts it
// ("today", "yesterday", "on Friday"). `phone`: it was booked as a phone call.
export function missedInterviewEmail(input: { firstName: string | null; when: string; phone: boolean }): FollowUpEmail {
  const ask = input.phone
    ? "Is there another day this week or next that works? I can just give you a call, so tell me a time and I'll ring you then."
    : "Is there another day this week or next that works? Happy to just give you a call instead if that's easier than a video call.";
  return {
    subject: 'sorry we missed each other',
    body: [
      greeting(input.firstName),
      `I think we missed each other ${input.when}. No worries at all, I know things come up.`,
      ask,
      "Or if it's easier, I can send over 3 quick questions by email and you can answer whenever you have a minute.",
      'Thanks,',
    ].join('\n\n'),
  };
}

// They called it off ahead: they replied, so thank them and offer another
// time. `phone`: it was booked as a phone call.
export function canceledInterviewEmail(input: { firstName: string | null; phone: boolean }): FollowUpEmail {
  const ask = input.phone
    ? "Is there another day this week or next that works better? Tell me a time and I'll give you a call then."
    : "Is there another day this week or next that works better? Happy to just give you a call instead if that's easier than a video call.";
  return {
    subject: 'thanks for letting me know',
    body: [
      greeting(input.firstName),
      'Thanks for letting me know. No worries at all.',
      ask,
      "Or if it's easier, I can send over 3 quick questions by email and you can answer whenever you have a minute.",
      'Thanks,',
    ].join('\n\n'),
  };
}

// The last try: says so, and leaves the door open without asking again.
export function closeTheLoopEmail(input: { firstName: string | null }): FollowUpEmail {
  return {
    subject: 'closing the loop',
    body: [
      greeting(input.firstName),
      "I tried you a couple of times and didn't want to keep bugging you, so I'll leave it here for now.",
      "If things free up later, I'd still love to hear how you run things on your end. Just reply here, or I can send over 3 quick questions by email.",
      'Thanks,',
    ].join('\n\n'),
  };
}
