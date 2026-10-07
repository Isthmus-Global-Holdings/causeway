// The contact's own numbers, edited from the call and interview pages (a
// caller gives their mobile, or the extension to reach them at the office) or
// the Claude connector. The company's line stays in HubSpot: the app only has
// write access to contacts.
//
// One HubSpot write, of the numbers that changed. Saving the same numbers
// again changes nothing, so it's safe to repeat.

import type { HubSpot, HubSpotObject } from '../lib/hubspot';
import { extensionOf, formatPhone, phoneValue, toE164 } from '../lib/phone';
import { WorkflowError } from './parties';

export const CONTACT_PHONE_FIELDS = [
  { field: 'phone', label: 'Phone' },
  { field: 'mobilephone', label: 'Mobile' },
] as const;
export type ContactPhoneField = (typeof CONTACT_PHONE_FIELDS)[number]['field'];

// What the rep typed for one number: the number and its extension, and,
// from a page, the HubSpot value the page was showing (`was`).
export interface TypedNumber {
  number: string;
  ext: string;
  was?: string;
}

// What the edit form's two boxes show for a HubSpot number: a number the app
// can dial, formatted, with its extension apart; anything else as it is.
export function phoneBoxes(raw: string | null | undefined): TypedNumber {
  const value = raw?.trim() ?? '';
  const e164 = toE164(value);
  return e164 ? { number: formatPhone(e164), ext: extensionOf(value) ?? '' } : { number: value, ext: '' };
}

// The boxes still show what the page loaded: the rep didn't touch this one.
function untouched(typed: TypedNumber): boolean {
  if (typed.was === undefined) return false;
  const shown = phoneBoxes(typed.was);
  return typed.number.trim() === shown.number && typed.ext.trim() === shown.ext;
}

export type NumbersInput = Partial<Record<ContactPhoneField, TypedNumber>>;

// The same number, extension included, however it's written.
function samePhone(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return !a.trim() && !b.trim();
  return toE164(a) !== null && toE164(a) === toE164(b) && extensionOf(a) === extensionOf(b);
}

// The HubSpot properties to write: each typed number that differs from the
// contact's, as phoneValue saves it ('' clears one). A number the rep left as
// the page showed it is skipped, so a page loaded before a change in HubSpot
// doesn't write the old number back. Checks every number before anything is
// written.
export function numberChanges(contact: HubSpotObject, input: NumbersInput): Record<string, string> {
  const changes: Record<string, string> = {};
  for (const { field, label } of CONTACT_PHONE_FIELDS) {
    const typed = input[field];
    if (!typed || untouched(typed)) continue;
    const value = phoneValue(typed.number, typed.ext);
    if (value === null) {
      const shown = [typed.number.trim(), typed.ext.trim() && `ext. ${typed.ext.trim()}`].filter(Boolean).join(' ');
      throw new WorkflowError(
        `${label}: "${shown}" isn't a number the app can dial. Type the full number (with the country code if it's outside the US), and only digits for the extension.`
      );
    }
    if (!samePhone(contact.properties[field] ?? '', value)) changes[field] = value;
  }
  return changes;
}

export async function saveContactNumbers(
  hs: HubSpot,
  contactId: string,
  input: NumbersInput
): Promise<Record<string, string>> {
  // Read fresh: the page may be older than a change made in HubSpot.
  const contact = await hs.getObject(
    'contacts',
    contactId,
    CONTACT_PHONE_FIELDS.map((f) => f.field)
  );
  const changes = numberChanges(contact, input);
  if (Object.keys(changes).length) await hs.updateObject('contacts', contactId, changes);
  return changes;
}
