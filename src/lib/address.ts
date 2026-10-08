// A contact's or company's address from HubSpot's properties (address,
// address2, city, state, zip, country), as the lines of a mailing label:
//   2150 S 1300 W
//   Suite 400
//   Salt Lake City, UT 84119
// The country is left off for the US, where the prospects are.

type AddressProps = Record<string, string | null | undefined>;

const US = new Set(['us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america']);

function clean(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

// Null when HubSpot has no part of the address.
export function formatAddress(props: AddressProps): string[] | null {
  const street = [clean(props.address), clean(props.address2)].filter(Boolean);
  const city = clean(props.city);
  const region = [clean(props.state), clean(props.zip)].filter(Boolean).join(' ');
  const locality = [city, region].filter(Boolean).join(', ');
  const country = clean(props.country);
  const lines = [...street, locality, US.has(country.toLowerCase()) ? '' : country].filter(Boolean);
  return lines.length ? lines : null;
}

// The address on Google Maps (a search, so no API key).
export function mapsUrl(lines: string[]): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lines.join(', '))}`;
}

// "Salt Lake City, UT", or "Panama City, Panama" outside the US: where they
// are at a glance. Null without a city, state or country.
export function formatPlace(props: AddressProps): string | null {
  const country = clean(props.country);
  const parts = [clean(props.city), clean(props.state), US.has(country.toLowerCase()) ? '' : country];
  return parts.filter(Boolean).join(', ') || null;
}

// A small Google map of the address for an iframe. Google's keyless embed
// (output=embed) costs nothing and takes the address as written, so there's
// no geocoding. Closer in with a street, the whole area with only a city.
export function mapEmbedUrl(lines: string[], hasStreet: boolean): string {
  return `https://maps.google.com/maps?q=${encodeURIComponent(lines.join(', '))}&z=${hasStreet ? 14 : 10}&output=embed`;
}

// --- Their time zone, from where they are ---

// Each US state's main zone (the one most of its people are in), by its
// postal code. Close enough to say what time it is for them and to group
// calls by zone; a state split between zones gets its larger side.
const EASTERN = 'America/New_York';
const CENTRAL = 'America/Chicago';
const MOUNTAIN = 'America/Denver';
const PACIFIC = 'America/Los_Angeles';
// prettier-ignore
const STATE_ZONES: Record<string, string> = {
  CT: EASTERN, DE: EASTERN, DC: EASTERN, FL: EASTERN, GA: EASTERN, IN: EASTERN, KY: EASTERN, ME: EASTERN,
  MD: EASTERN, MA: EASTERN, MI: EASTERN, NH: EASTERN, NJ: EASTERN, NY: EASTERN, NC: EASTERN, OH: EASTERN,
  PA: EASTERN, RI: EASTERN, SC: EASTERN, VT: EASTERN, VA: EASTERN, WV: EASTERN,
  AL: CENTRAL, AR: CENTRAL, IL: CENTRAL, IA: CENTRAL, KS: CENTRAL, LA: CENTRAL, MN: CENTRAL, MS: CENTRAL,
  MO: CENTRAL, NE: CENTRAL, ND: CENTRAL, OK: CENTRAL, SD: CENTRAL, TN: CENTRAL, TX: CENTRAL, WI: CENTRAL,
  CO: MOUNTAIN, ID: MOUNTAIN, MT: MOUNTAIN, NM: MOUNTAIN, UT: MOUNTAIN, WY: MOUNTAIN,
  AZ: 'America/Phoenix',
  CA: PACIFIC, NV: PACIFIC, OR: PACIFIC, WA: PACIFIC,
  AK: 'America/Anchorage',
  HI: 'Pacific/Honolulu',
  PR: 'America/Puerto_Rico',
};
// prettier-ignore
const STATE_CODES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
// Outside the US, the countries the app's prospects are in.
const COUNTRY_ZONES: Record<string, string> = {
  panama: 'America/Panama',
  'costa rica': 'America/Costa_Rica',
  colombia: 'America/Bogota',
  mexico: 'America/Mexico_City',
};

// The IANA zone a contact or company is in, from its state (a postal code or
// the name) and country. Null when the address doesn't say.
export function stateTimeZone(state: string | null | undefined, country?: string | null): string | null {
  const c = clean(country).toLowerCase();
  if (c && !US.has(c)) return COUNTRY_ZONES[c] ?? null;
  const s = clean(state);
  const code = s.length === 2 ? s.toUpperCase() : STATE_CODES[s.toLowerCase().replace(/\.$/, '')];
  return (code && STATE_ZONES[code]) ?? null;
}

// A contact's zone, else their company's: where a call to them lands.
export function partyTimeZone(
  contact: { properties: AddressProps } | null,
  company: { properties: AddressProps } | null
): string | null {
  const zone = (r: { properties: AddressProps } | null) =>
    r ? stateTimeZone(r.properties.state, r.properties.country) : null;
  return zone(contact) ?? zone(company);
}

// The zones a time can be typed in, east to west: where the prospects are.
export const PROSPECT_ZONES = [
  'America/Puerto_Rico',
  EASTERN,
  'America/Panama',
  'America/Bogota',
  CENTRAL,
  'America/Mexico_City',
  'America/Costa_Rica',
  MOUNTAIN,
  'America/Phoenix',
  PACIFIC,
  'America/Anchorage',
  'Pacific/Honolulu',
];

const ZONE_LABELS: Record<string, string> = {
  [EASTERN]: 'Eastern',
  [CENTRAL]: 'Central',
  [MOUNTAIN]: 'Mountain',
  [PACIFIC]: 'Pacific',
  'America/Phoenix': 'Arizona',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
};

// "Mountain", "Arizona", or the zone's city ("Panama") for the rest.
export function zoneLabel(timeZone: string): string {
  return ZONE_LABELS[timeZone] ?? (timeZone.split('/').pop() ?? timeZone).replace(/_/g, ' ');
}
