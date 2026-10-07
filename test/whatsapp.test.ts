// WhatsApp through the rep's own account: the click-to-chat links, which
// numbers get one, the hours warning, the messages written in, and how an
// interview's time is said in one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { saidAhead } from '../src/lib/dates.ts';
import { contactHoursNote, whatsappLink, whatsappNumber, whatsappOpens } from '../src/lib/whatsapp.ts';
import { whatsappInterviewNote, whatsappOpener } from '../src/prompts/whatsapp-messages.ts';

const NY = 'America/New_York';

test('the link opens the chat with the number as digits and the message written in', () => {
  assert.equal(
    whatsappLink('+13855550100', "Hi Ana, it's me & you?", 'app'),
    'whatsapp://send?phone=13855550100&text=Hi%20Ana%2C%20it%27s%20me%20%26%20you%3F'
  );
  assert.equal(
    whatsappLink('+50761234567', 'Hola', 'web'),
    'https://web.whatsapp.com/send?phone=50761234567&text=Hola'
  );
  assert.equal(whatsappLink('+13855550100', '', 'app'), 'whatsapp://send?phone=13855550100', 'no text, no text param');
  assert.doesNotMatch(whatsappLink('+13855550100', 'a + b', 'app'), /a\+/, 'a plus sign stays a plus, not a space');
});

test('only a readable number without an extension gets WhatsApp', () => {
  assert.equal(whatsappNumber('(385) 555-0100'), '+13855550100');
  assert.equal(whatsappNumber('+507 6123-4567'), '+50761234567');
  assert.equal(whatsappNumber('385.555.0100 x12'), null, 'an office line');
  assert.equal(whatsappNumber('n/a'), null);
  assert.equal(whatsappNumber(null), null);
});

test('WhatsApp opens in the app unless Web was picked', () => {
  assert.equal(whatsappOpens('web'), 'web');
  assert.equal(whatsappOpens('app'), 'app');
  assert.equal(whatsappOpens(undefined), 'app');
  assert.equal(whatsappOpens('nonsense'), 'app');
});

test('the hours warning shows before 8am and from 8pm, the rep’s time', () => {
  const at = (iso: string) => contactHoursNote(Date.parse(iso), NY);
  assert.match(at('2026-10-01T11:59:00Z')!, /8am to 8pm/); // 7:59 New York
  assert.equal(at('2026-10-01T12:00:00Z'), null); // 8:00
  assert.equal(at('2026-10-01T23:59:00Z'), null); // 19:59
  assert.match(at('2026-10-02T00:00:00Z')!, /Florida/); // 20:00
});

test('the opener: who, why, one ask, from the rep by first name', () => {
  const text = whatsappOpener({ firstName: 'Ana', repName: 'Anel Canto', company: 'Acme Freight' });
  assert.match(text, /^Hi Ana, this is Anel\. /);
  assert.match(text, /how Acme Freight handles quoting, dispatch and invoicing/);
  assert.match(text, /15 minutes/);
  assert.doesNotMatch(text, /\n/, 'one paragraph, as a chat message');
  const bare = whatsappOpener({ firstName: '  ', repName: 'Anel', company: null });
  assert.match(bare, /^Hi, this is Anel\. .*how trucking companies handle/);
});

test('the interview note says when, the way you would in a message', () => {
  const now = Date.parse('2026-10-01T14:00:00Z'); // Thursday 10:00 New York
  assert.equal(saidAhead(Date.parse('2026-10-01T18:30:00Z'), now, NY), 'today at 2:30 PM');
  assert.equal(saidAhead(Date.parse('2026-10-02T14:00:00Z'), now, NY), 'tomorrow at 10:00 AM');
  assert.equal(saidAhead(Date.parse('2026-10-05T13:00:00Z'), now, NY), 'on Monday at 9:00 AM');
  assert.equal(saidAhead(Date.parse('2026-10-14T13:00:00Z'), now, NY), 'on Oct 14 at 9:00 AM');
  const note = whatsappInterviewNote({ firstName: 'Ana', repName: 'Anel Canto', when: 'tomorrow at 10:00 AM' });
  assert.equal(
    note,
    "Hi Ana, it's Anel. Just checking we're still good for our chat tomorrow at 10:00 AM. If another time works better, tell me and I'll move it."
  );
});
