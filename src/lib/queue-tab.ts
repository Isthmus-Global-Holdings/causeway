// The Queue link opens the tab the rep was last on: someone working through
// calls gets straight back to Calls to make. A cookie remembers it; the tabs
// themselves always link to their own page.

import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export type QueueTab = 'emails' | 'calls';

export const QUEUE_TAB_PATHS: Record<QueueTab, string> = { emails: '/', calls: '/queue/calls' };

const COOKIE = 'queue_tab';
const MAX_AGE_SEC = 90 * 86_400;

export function rememberQueueTab(c: Context, tab: QueueTab): void {
  setCookie(c, COOKIE, tab, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/',
    maxAge: MAX_AGE_SEC,
  });
}

// Emails unless the rep was last on Calls to make.
export function rememberedQueueTab(c: Context): QueueTab {
  return getCookie(c, COOKIE) === 'calls' ? 'calls' : 'emails';
}
