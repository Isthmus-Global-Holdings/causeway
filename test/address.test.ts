import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAddress, formatPlace, mapEmbedUrl, mapsUrl, partyTimeZone } from '../src/lib/address.ts';

test('a full US address reads like a mailing label, without the country', () => {
  assert.deepEqual(
    formatAddress({
      address: '2150 S 1300 W',
      address2: 'Suite 400',
      city: 'Salt Lake City',
      state: 'UT',
      zip: '84119',
      country: 'United States',
    }),
    ['2150 S 1300 W', 'Suite 400', 'Salt Lake City, UT 84119']
  );
});

test('missing parts are left out, not shown as gaps', () => {
  assert.deepEqual(formatAddress({ city: 'Ogden', state: 'UT' }), ['Ogden, UT']);
  assert.deepEqual(formatAddress({ state: 'UT', zip: '84401' }), ['UT 84401']);
  assert.deepEqual(formatAddress({ address: '  12  Main St ', city: 'Provo' }), ['12 Main St', 'Provo']);
  assert.deepEqual(formatAddress({ city: 'Provo', state: null, zip: '' }), ['Provo']);
});

test('a country other than the US is shown', () => {
  assert.deepEqual(formatAddress({ city: 'Panama City', country: 'Panama' }), ['Panama City', 'Panama']);
  assert.deepEqual(formatAddress({ city: 'Boise', state: 'ID', country: 'USA' }), ['Boise, ID']);
});

test('no address at all is null', () => {
  assert.equal(formatAddress({}), null);
  assert.equal(formatAddress({ address: ' ', city: null, country: 'US' }), null);
});

test('the Maps link searches the whole address', () => {
  assert.equal(
    mapsUrl(['12 Main St', 'Provo, UT 84601']),
    'https://www.google.com/maps/search/?api=1&query=12%20Main%20St%2C%20Provo%2C%20UT%2084601'
  );
});

test('the place is the city and state, with the country only outside the US', () => {
  assert.equal(
    formatPlace({ city: 'Salt Lake City', state: 'UT', zip: '84119', country: 'United States' }),
    'Salt Lake City, UT'
  );
  assert.equal(formatPlace({ city: 'Panama City', country: 'Panama' }), 'Panama City, Panama');
  assert.equal(formatPlace({ state: 'UT' }), 'UT');
  assert.equal(formatPlace({ address: '12 Main St', country: 'US' }), null);
});

test('the map zooms in on a street and out on a city', () => {
  assert.equal(
    mapEmbedUrl(['12 Main St', 'Provo, UT 84601'], true),
    'https://maps.google.com/maps?q=12%20Main%20St%2C%20Provo%2C%20UT%2084601&z=14&output=embed'
  );
  assert.equal(mapEmbedUrl(['Provo, UT'], false), 'https://maps.google.com/maps?q=Provo%2C%20UT&z=10&output=embed');
});

test("their time zone is the contact's, else their company's", () => {
  const at = (state: string | null, country: string | null = null) => ({ properties: { state, country } });
  assert.equal(partyTimeZone(at('NY'), at('CA')), 'America/New_York');
  assert.equal(partyTimeZone(at(null), at('California')), 'America/Los_Angeles');
  assert.equal(partyTimeZone(null, at(null, 'Panama')), 'America/Panama');
  assert.equal(partyTimeZone(at(null), null), null);
});
