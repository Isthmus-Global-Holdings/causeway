// Phone numbers in HubSpot are typed by hand: "(385) 255-1234",
// "385.255.1234 x12", "+1 385 255 1234", "+507 6123-4567". Twilio needs E.164.
// Without a "+", a number is read as North American (the prospects are US
// carriers); anything else must carry its country code in HubSpot.

const EXTENSION = /\s*(?:x|ext\.?|extension|#)\s*(\d+)\s*$/i;

export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Drop an extension: the app dials the main line, and the rep asks for the
  // extension or keys it in on the dial pad (extensionOf shows it).
  const main = raw.trim().replace(EXTENSION, '');
  const digits = main.replace(/\D/g, '');
  if (main.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  // NANP area codes and exchanges never start with 0 or 1.
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national) ? `+1${national}` : null;
}

// The extension typed after a number in HubSpot: "385.255.1234 x12" → "12".
export function extensionOf(raw: string | null | undefined): string | null {
  return (raw && EXTENSION.exec(raw.trim())?.[1]) || null;
}

// "+13852557051" → "+1 385-255-7051". Other countries stay as E.164.
export function formatPhone(e164: string): string {
  const us = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return us ? `+1 ${us[1]}-${us[2]}-${us[3]}` : e164;
}

// A number and its extension as the rep types them on a call page, as they're
// saved in HubSpot: ("801 555 0143", "12") → "+1 801-555-0143 x12". An
// extension typed after the number counts when the box for it is empty. Empty
// clears the number; null means it isn't one the app can dial.
export function phoneValue(number: string, ext: string): string | null {
  const typed = number.trim();
  const extension = ext.trim().replace(/^(?:x|ext\.?|#)\s*/i, '') || extensionOf(typed) || '';
  if (!/^\d{0,10}$/.test(extension)) return null;
  if (!typed) return extension ? null : '';
  const e164 = toE164(typed);
  if (!e164) return null;
  return formatPhone(e164) + (extension ? ` x${extension}` : '');
}
