// Public, unauthenticated routes hit by recipients' mail clients. They sit
// outside Cloudflare Access (see middleware/access.ts and the README's Access
// setup). The only way in is a random 128-bit token that exists in D1.

import { Hono } from 'hono';
import { findByOpenToken, findLink, recordTrackingEvent, type TrackingTarget } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import { escapeHtml } from '../lib/richtext';
import { PIXEL_GIF } from '../lib/tracking';
import type { AppEnv, Env } from '../types';
import { noteOnce } from '../workflows/tracking-notes';

export const trackingRoute = new Hono<AppEnv>();

const TOKEN = /^[0-9a-f]{32}$/;

// Gmail loads images in the sender's own Sent view right after sending. Opens
// this soon after the send are almost always that, so they're ignored.
const SELF_OPEN_GRACE_MS = 60_000;

function noteOnContact(env: Env, target: TrackingTarget, bodyHtml: string): () => Promise<unknown> {
  return () =>
    createHubSpot(env.HUBSPOT_ACCESS_TOKEN).createNote(bodyHtml, {
      contactId: target.contact_id,
      companyId: target.company_id,
    });
}

// Every open is counted in the app. Only the first becomes a HubSpot note, so
// repeat opens don't clutter the contact's timeline.
async function recordOpen(env: Env, target: TrackingTarget, userAgent: string | null): Promise<void> {
  await recordTrackingEvent(env.DB, { emailTaskId: target.email_task_id, kind: 'open', userAgent });
  await noteOnce(
    env.DB,
    { emailTaskId: target.email_task_id, kind: 'open', url: null },
    noteOnContact(
      env,
      target,
      `<p><strong>Email opened</strong>: "${escapeHtml(target.subject)}"</p>` +
        `<p>Tracked by Causeway. Opens are approximate: some mail apps load images automatically.</p>`
    )
  );
}

// Every click is counted. One note per distinct link, on its first click.
async function recordClick(
  env: Env,
  target: TrackingTarget & { url: string },
  userAgent: string | null
): Promise<void> {
  await recordTrackingEvent(env.DB, { emailTaskId: target.email_task_id, kind: 'click', url: target.url, userAgent });
  await noteOnce(
    env.DB,
    { emailTaskId: target.email_task_id, kind: 'click', url: target.url },
    noteOnContact(
      env,
      target,
      `<p><strong>Link clicked</strong> in "${escapeHtml(target.subject)}": ${escapeHtml(target.url)}</p>` +
        `<p>Tracked by Causeway.</p>`
    )
  );
}

trackingRoute.get('/t/o/:token', async (c) => {
  const token = c.req.param('token').replace(/\.gif$/, '');
  const target = TOKEN.test(token) ? await findByOpenToken(c.env.DB, token) : null;
  const tooSoon = target?.sent_at ? Date.now() - Date.parse(target.sent_at) < SELF_OPEN_GRACE_MS : false;
  if (target && !tooSoon) {
    // Record after responding, so the image loads instantly.
    c.executionCtx.waitUntil(
      recordOpen(c.env, target, c.req.header('User-Agent') ?? null).catch((err) => console.error('open tracking', err))
    );
  }
  return new Response(PIXEL_GIF, {
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' },
  });
});

trackingRoute.get('/t/c/:token', async (c) => {
  const token = c.req.param('token');
  const link = TOKEN.test(token) ? await findLink(c.env.DB, token) : null;
  if (!link || !/^https?:\/\//i.test(link.url)) return c.text('Link not found', 404);
  c.executionCtx.waitUntil(
    recordClick(c.env, link, c.req.header('User-Agent') ?? null).catch((err) => console.error('click tracking', err))
  );
  return c.redirect(link.url, 302);
});
