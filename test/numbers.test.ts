import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { numberChanges, phoneBoxes, saveContactNumbers } from '../src/workflows/numbers.ts';
import { FakeHubSpot } from './fakes.ts';

let hs: FakeHubSpot;

beforeEach(() => {
  hs = new FakeHubSpot();
  hs.put('contacts', '10', { firstname: 'Jeremy', phone: '(385) 555-0100', mobilephone: null });
});

test('saves a new mobile, as the app writes numbers', async () => {
  const changes = await saveContactNumbers(hs, '10', {
    phone: { number: '(385) 555-0100', ext: '' },
    mobilephone: { number: '801 555 0143', ext: '' },
  });
  assert.deepEqual(changes, { mobilephone: '+1 801-555-0143' }, 'the phone was the same number, written differently');
  assert.equal(hs.objects.get('contacts/10')?.properties.mobilephone, '+1 801-555-0143');
  assert.equal(hs.objects.get('contacts/10')?.properties.phone, '(385) 555-0100', 'left as the rep wrote it');
});

test('an extension is a change; the same numbers again write nothing', async () => {
  const input = { phone: { number: '385-555-0100', ext: '204' } };
  assert.deepEqual(await saveContactNumbers(hs, '10', input), { phone: '+1 385-555-0100 x204' });
  assert.deepEqual(await saveContactNumbers(hs, '10', input), {});
});

test('an emptied box clears the number', () => {
  const contact = { id: '10', properties: { phone: '(385) 555-0100', mobilephone: null } };
  assert.deepEqual(numberChanges(contact, { phone: { number: '', ext: '' }, mobilephone: { number: '', ext: '' } }), {
    phone: '',
  });
});

test('nothing is written when one of the numbers is wrong', async () => {
  await assert.rejects(
    saveContactNumbers(hs, '10', {
      phone: { number: '801 555 0143', ext: '' },
      mobilephone: { number: '555-0143', ext: '' },
    }),
    /Mobile: "555-0143" isn't a number the app can dial/
  );
  assert.equal(hs.objects.get('contacts/10')?.properties.phone, '(385) 555-0100');
});

test("a number left as the page showed it isn't written back over a newer one", async () => {
  // The page loaded with this phone; it was changed in HubSpot since.
  const shown = phoneBoxes('(385) 555-0100 x12');
  assert.deepEqual(shown, { number: '+1 385-555-0100', ext: '12' });
  hs.put('contacts', '10', { firstname: 'Jeremy', phone: '(385) 555-0199', mobilephone: null });

  const changes = await saveContactNumbers(hs, '10', {
    phone: { ...shown, was: '(385) 555-0100 x12' },
    mobilephone: { number: '801 555 0143', ext: '', was: '' },
  });
  assert.deepEqual(changes, { mobilephone: '+1 801-555-0143' });
  assert.equal(hs.objects.get('contacts/10')?.properties.phone, '(385) 555-0199', 'the newer phone stays');
});

test("an untouched number HubSpot has in a form the app can't dial doesn't block the other", async () => {
  hs.put('contacts', '10', { firstname: 'Jeremy', phone: 'ask for dispatch', mobilephone: null });
  const changes = await saveContactNumbers(hs, '10', {
    phone: { number: 'ask for dispatch', ext: '', was: 'ask for dispatch' },
    mobilephone: { number: '801 555 0143', ext: '', was: '' },
  });
  assert.deepEqual(changes, { mobilephone: '+1 801-555-0143' });
});
