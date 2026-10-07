import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extensionOf, formatPhone, phoneValue, toE164 } from '../src/lib/phone.ts';

test('US numbers as people type them in HubSpot', () => {
  for (const raw of [
    '(385) 255-7051',
    '385.255.7051',
    '385 255 7051',
    '1-385-255-7051',
    '+1 385 255 7051',
    '3852557051',
  ]) {
    assert.equal(toE164(raw), '+13852557051', raw);
  }
});

test('drops an extension', () => {
  assert.equal(toE164('(385) 255-7051 x12'), '+13852557051');
  assert.equal(toE164('385-255-7051 ext. 4'), '+13852557051');
});

test('keeps the extension for the rep to dial', () => {
  assert.equal(extensionOf('(385) 255-7051 x12'), '12');
  assert.equal(extensionOf('385-255-7051 ext. 4'), '4');
  assert.equal(extensionOf('385 255 7051 extension 301'), '301');
  assert.equal(extensionOf('385-255-7051 #22'), '22');
  for (const raw of [null, undefined, '', '(385) 255-7051', '+1 385 255 7051']) {
    assert.equal(extensionOf(raw), null, String(raw));
  }
});

test('keeps any country code given with a +', () => {
  assert.equal(toE164('+507 6123-4567'), '+50761234567');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
});

test('refuses what it would have to guess at', () => {
  for (const raw of [null, undefined, '', 'n/a', '255-7051', '6123-4567', '(085) 255-7051', '385 155 7051', '+12']) {
    assert.equal(toE164(raw), null, String(raw));
  }
});

test('formats US numbers for reading, leaves others as E.164', () => {
  assert.equal(formatPhone('+13852557051'), '+1 385-255-7051');
  assert.equal(formatPhone('+50761234567'), '+50761234567');
});

test('a number typed on the call page, as it is saved in HubSpot', () => {
  assert.equal(phoneValue('801 555 0143', ''), '+1 801-555-0143');
  assert.equal(phoneValue('(801) 555-0143', '12'), '+1 801-555-0143 x12');
  assert.equal(phoneValue('801-555-0143', 'ext. 12'), '+1 801-555-0143 x12');
  assert.equal(phoneValue('801-555-0143 x305', ''), '+1 801-555-0143 x305', 'an extension typed after the number');
  assert.equal(phoneValue('801-555-0143 x305', '7'), '+1 801-555-0143 x7', 'the extension box wins');
  assert.equal(phoneValue('+507 6123-4567', ''), '+50761234567');
  assert.equal(phoneValue('  ', ''), '', 'empty clears the number');
  for (const [number, ext] of [
    ['555-0143', ''],
    ['801 555 0143', '12a'],
    ['', '12'],
    ['801 555 0143', '12345678901'],
  ]) {
    assert.equal(phoneValue(number, ext), null, `${number} / ${ext}`);
  }
});
