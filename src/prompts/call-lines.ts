// How Claude writes the call script's two lines about a prospect, the
// World and the Pedestal (lib/fit.ts reads them, save_call_lines writes
// them). Not a skill copy: the rep's to edit. They are the email's Vision and
// Pedestal said out loud, so a call after the email sounds like the same
// person with the same reason.

export const CALL_LINES_RULES = `## The call script's lines (save_call_lines)

The rep's call script says "I'm researching {their_world}, and I'm calling you because {pedestal}." Write both for the company, to be heard, not read.

- their_world: what the rep is researching, in their industry's own words: "how <their peer group, plural> handle <the two or three jobs the rep asks about>". For example "how freight forwarders handle quoting and shipments" or "how trucking companies handle quoting and dispatch". Lowercase, no final period, 15 words at most. The same Vision as the email's first paragraph.
- pedestal: why them in particular, said to them. One clause in the second person, under 20 words (25 at most), built on the same verified specific as the email's second paragraph, with what it probably means for their day. For example "you run both LTL and TL out of five terminals, so quoting must change lane to lane" or "you handle ocean and air out of Miami, so no two quotes look alike".
- Never a registry number, a fleet count, a list of facts, a year founded ("since 1987"), flattery or a superlative, or "small". No em-dashes or semicolons.
- Say it out loud. If it sounds read off a research page, rewrite it.
- Save both together every time. If the research found nothing specific and verified, save pedestal: null. The call page shows the missing pedestal, and the rep says something general.`;
