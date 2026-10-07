// What a page shows about a contact or company, shared by the call and
// interview pages and the contact and company pages.

import { html } from 'hono/html';
import { formatAddress, formatPlace, mapEmbedUrl, mapsUrl } from '../lib/address';
import type { HubSpotObject } from '../lib/hubspot';
import { companyName, contactName } from '../workflows/parties';
import { recordUrl, type Html } from './layout';

// HubSpot's enum values (ATTEMPTED_TO_CONTACT, COMPUTER_SOFTWARE) as words.
export function humanize(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const LIFECYCLE_LABELS: Record<string, string> = {
  marketingqualifiedlead: 'Marketing qualified lead',
  salesqualifiedlead: 'Sales qualified lead',
};

export function lifecycle(value: string | null | undefined): string | null {
  return value ? (LIFECYCLE_LABELS[value] ?? humanize(value)) : null;
}

// Label and value rows; a row with no value is left out.
export function facts(rows: [string, Html | string | null][]): Html | '' {
  const shown = rows.filter((r): r is [string, Html | string] => Boolean(r[1]));
  if (!shown.length) return '';
  return html`<dl class="headers">${shown.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
}

// The record's address, one line per line, linked to Google Maps.
export function address(record: HubSpotObject | null): Html | null {
  const lines = record ? formatAddress(record.properties) : null;
  if (!lines) return null;
  return html`<a href="${mapsUrl(lines)}" target="_blank" rel="noopener">${lines.map((l, i) => html`${i ? html`<br />` : ''}${l}`)}</a>`;
}

// "Ogden, UT" for a table cell.
export function place(record: HubSpotObject | null): string | null {
  return record ? formatPlace(record.properties) : null;
}

// Where they are, under a call's or interview's heading: the city in large
// type, the street under it, and a small map. The company's address (where
// the business is), else the contact's. Nothing when neither has one.
export function whereTheyAre(contact: HubSpotObject, company: HubSpotObject | null): Html | '' {
  const record =
    company && formatAddress(company.properties) ? company : formatAddress(contact.properties) ? contact : null;
  if (!record) return '';
  const lines = formatAddress(record.properties) ?? [];
  const city = formatPlace(record.properties);
  // formatAddress puts the street first, a line for each part HubSpot has.
  const street = lines.slice(
    0,
    [record.properties.address, record.properties.address2].filter((v) => v?.trim()).length
  );
  return html`<div class="where">
    <iframe src="${mapEmbedUrl(lines, street.length > 0)}" title="Map of ${lines.join(', ')}" loading="lazy" referrerpolicy="no-referrer"></iframe>
    <div class="tight">
      <a class="place" href="${mapsUrl(lines)}" target="_blank" rel="noopener">${city ?? lines.join(', ')}</a>
      ${city && street.length ? html`<span>${street.join(' · ')}</span>` : ''}
      <span class="muted">${record === company ? 'Company address' : 'Contact’s address'}</span>
    </div>
  </div>`;
}

export function website(company: HubSpotObject | null): Html | null {
  const domain = company?.properties.domain?.trim();
  return domain ? html`<a href="https://${domain}" target="_blank" rel="noopener">${domain}</a>` : null;
}

// The contact's and company's pages in the app, and the records in HubSpot.
export function contactLinks(portalId: string, contact: HubSpotObject): Html {
  return html`<a href="/contacts/${contact.id}">${contactName(contact)}</a>
    <span class="muted">· <a href="${recordUrl(portalId, '0-1', contact.id)}" target="_blank" rel="noopener">HubSpot</a></span>`;
}

export function companyLinks(portalId: string, company: HubSpotObject): Html {
  return html`<a href="/companies/${company.id}">${companyName(company)}</a>
    <span class="muted">· <a href="${recordUrl(portalId, '0-2', company.id)}" target="_blank" rel="noopener">HubSpot</a></span>`;
}
