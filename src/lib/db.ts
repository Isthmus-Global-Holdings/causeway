import {
  CALL_BACK_LIMIT,
  CALL_BACK_WINDOW_SEC,
  likePattern,
  mergeHistory,
  numberPattern,
  type HandLoggedCall,
  type HistoryDial,
  type HistoryFilters,
  type HistoryPage,
} from './call-history';
import {
  parseCorrections,
  REVIEW_RULES_VERSION,
  type CallReview,
  type InsightFields,
  type InsightSource,
  type Reviewer,
} from './call-insight';
import { parsePlan, withoutItem, withSetTimeCall, type WorkPlan } from './work-plan';

export interface Confirmation {
  email_task_id: string;
  contact_id: string;
  company_id: string | null;
  completed_at: string | null;
  call_task_id: string | null;
  last_error: string | null; // why the last run stopped short, until one finishes
}

// What the "email sent" workflow needs from storage. D1 in production, an
// in-memory map in tests.
export interface ConfirmationStore {
  get(emailTaskId: string): Promise<Confirmation | null>;
  // No-op if the row already exists: the first confirmation's parties stick.
  create(row: { emailTaskId: string; contactId: string; companyId: string | null }): Promise<void>;
  // True if this caller now holds the lock. Expired locks can be taken over,
  // so a crashed run doesn't block the task forever.
  acquireLock(emailTaskId: string, nowSec: number, ttlSec: number): Promise<boolean>;
  releaseLock(emailTaskId: string): Promise<void>;
  markCompleted(emailTaskId: string, at: string): Promise<void>;
  setCallTask(emailTaskId: string, callTaskId: string): Promise<void>;
  // Why a run stopped short (null once one finishes), for the notice.
  setError(emailTaskId: string, error: string | null): Promise<void>;
}

export function d1ConfirmationStore(db: D1Database): ConfirmationStore {
  return {
    async get(emailTaskId) {
      return db
        .prepare(
          `SELECT email_task_id, contact_id, company_id, completed_at, call_task_id, last_error
           FROM sent_confirmations WHERE email_task_id = ?`
        )
        .bind(emailTaskId)
        .first<Confirmation>();
    },

    async create(row) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO sent_confirmations (email_task_id, contact_id, company_id)
           VALUES (?, ?, ?)`
        )
        .bind(row.emailTaskId, row.contactId, row.companyId)
        .run();
    },

    async acquireLock(emailTaskId, nowSec, ttlSec) {
      // A single UPDATE is atomic in D1, so two concurrent requests can't both
      // see the lock as free.
      const result = await db
        .prepare(
          `UPDATE sent_confirmations SET lock_until = ?
           WHERE email_task_id = ? AND (lock_until IS NULL OR lock_until < ?)`
        )
        .bind(nowSec + ttlSec, emailTaskId, nowSec)
        .run();
      return result.meta.changes === 1;
    },

    async releaseLock(emailTaskId) {
      await db
        .prepare('UPDATE sent_confirmations SET lock_until = NULL WHERE email_task_id = ?')
        .bind(emailTaskId)
        .run();
    },

    async markCompleted(emailTaskId, at) {
      await db
        .prepare('UPDATE sent_confirmations SET completed_at = ? WHERE email_task_id = ?')
        .bind(at, emailTaskId)
        .run();
    },

    async setCallTask(emailTaskId, callTaskId) {
      await db
        .prepare('UPDATE sent_confirmations SET call_task_id = ? WHERE email_task_id = ?')
        .bind(callTaskId, emailTaskId)
        .run();
    },

    async setError(emailTaskId, error) {
      await db
        .prepare('UPDATE sent_confirmations SET last_error = ? WHERE email_task_id = ?')
        .bind(error === null ? null : error.slice(0, 500), emailTaskId)
        .run();
    },
  };
}

export interface AuditEntry {
  actor: string;
  workflow: 'draft-email' | 'email-sent' | 'send-email' | 'call' | 'task-action' | 'meeting' | 'connector' | 'pitch';
  taskId: string;
  action: string;
  outcome: 'success' | 'failed';
  error?: string | null;
  detail?: unknown;
}

export async function insertAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (actor, workflow, task_id, action, outcome, error, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      entry.actor,
      entry.workflow,
      entry.taskId,
      entry.action,
      entry.outcome,
      entry.error ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail)
    )
    .run();
}

// D1 names the missing column or table when the code is ahead of the
// database, which happens when a migration hasn't been applied. Returns that
// part of the message ("no such column: mode"), else null.
export function missingMigration(err: unknown): string | null {
  const text = err instanceof Error ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ''}` : '';
  return /no such (column|table): [\w.]+/.exec(text)?.[0] ?? null;
}

// --- Settings (edited on /settings) ---

export type SettingKey =
  | 'signature_html'
  | 'from_name'
  | 'claude_model'
  | 'claude_effort'
  | 'google_email'
  | 'google_refresh_token'
  | 'track_opens'
  | 'track_clicks'
  | 'log_to_hubspot'
  | 'rep_phone'
  | 'twilio_from_number'
  | 'record_calls'
  | 'call_with'
  | 'whatsapp_opens' // 'app' | 'web' (lib/whatsapp.ts)
  | 'time_zone'
  | 'call_script'
  | 'call_plan' // today's calls in order (lib/work-plan.ts)
  | 'email_plan'; // today's emails in order

export async function getSettings(db: D1Database): Promise<Partial<Record<SettingKey, string>>> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: SettingKey; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: SettingKey): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run();
}

// --- Today's order of work (lib/work-plan.ts) ---

export async function savePlan(db: D1Database, key: 'call_plan' | 'email_plan', plan: WorkPlan): Promise<void> {
  await setSetting(db, key, JSON.stringify(plan));
}

// Takes a task out of the plan: snoozed or dropped, it isn't next any more.
export async function removeFromPlan(db: D1Database, key: 'call_plan' | 'email_plan', taskId: string): Promise<void> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
  const plan = parsePlan(row?.value);
  if (plan?.items.some((i) => i.id === taskId)) await savePlan(db, key, withoutItem(plan, taskId));
}

// Puts a set-time call into today's plan (withSetTimeCall), from `at`.
export async function addSetTimeCallToPlan(db: D1Database, today: string, taskId: string, at: number): Promise<void> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind('call_plan').first<{ value: string }>();
  const plan = withSetTimeCall(parsePlan(row?.value), today, taskId, at);
  if (plan) await savePlan(db, 'call_plan', plan);
}

// Tasks worked through the app in the last two days, which a plan (at most a
// day old) and the queues (HubSpot's search trails writes) skip: calls
// logged, emails sent, marked sent or dropped. A drop leaves no row of its
// own, only its audit entry.
export async function recentlyWorked(db: D1Database, kind: 'call' | 'email'): Promise<Set<string>> {
  const sql =
    kind === 'call'
      ? `SELECT call_task_id AS id FROM call_logs WHERE created_at >= datetime('now', '-2 days')`
      : `SELECT email_task_id AS id FROM sent_confirmations WHERE created_at >= datetime('now', '-2 days')
         UNION SELECT email_task_id FROM sent_emails WHERE created_at >= datetime('now', '-2 days')
         UNION SELECT task_id FROM audit_log
           WHERE action = 'drop email task' AND outcome = 'success' AND created_at >= datetime('now', '-2 days')`;
  const { results } = await db.prepare(sql).all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

// --- Sent emails ---

export type SendStatus = 'sending' | 'sent' | 'unknown';

export interface SentEmail {
  email_task_id: string;
  contact_id: string;
  company_id: string | null;
  from_email: string;
  to_email: string;
  subject: string;
  html: string;
  open_token: string;
  status: SendStatus;
  gmail_message_id: string | null;
  logged_email_id: string | null;
  log_attempted_at: string | null;
  sent_at: string | null;
}

export interface NewSentEmail {
  emailTaskId: string;
  contactId: string;
  companyId: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string;
  html: string;
  openToken: string;
  links: { token: string; url: string }[];
  trackOpens: boolean;
  trackClicks: boolean;
}

// What the send workflow needs from storage. D1 in production, in-memory in tests.
export interface SentEmailStore {
  get(emailTaskId: string): Promise<SentEmail | null>;
  // Records the email as 'sending' and takes the lock, only if nothing has
  // been recorded for this task yet. False means another run got there first.
  beginSend(row: NewSentEmail, nowSec: number, ttlSec: number): Promise<boolean>;
  markSent(emailTaskId: string, gmailMessageId: string, at: string): Promise<void>;
  // A 'sending' row whose lock has expired: we can't tell whether Gmail took it.
  markUnknownIfStale(emailTaskId: string, nowSec: number): Promise<boolean>;
  // The rep checked Gmail's Sent folder and says it went out.
  markSentManually(emailTaskId: string, at: string): Promise<void>;
  // Forget an attempt so it can be retried: 'sending' when Gmail definitely
  // rejected it, 'unknown' when the rep checked and it didn't go out.
  discard(emailTaskId: string, status: 'sending' | 'unknown'): Promise<void>;
  setLoggedEmail(emailTaskId: string, loggedEmailId: string): Promise<void>;
  // True if this caller may log the email to HubSpot: no earlier attempt.
  markLogAttempted(emailTaskId: string, at: string): Promise<boolean>;
  // HubSpot definitely rejected the log, so a retry may try again.
  clearLogAttempt(emailTaskId: string): Promise<void>;
}

export function d1SentEmailStore(db: D1Database): SentEmailStore {
  return {
    async get(emailTaskId) {
      return db
        .prepare(
          `SELECT email_task_id, contact_id, company_id, from_email, to_email, subject, html, open_token,
                  status, gmail_message_id, logged_email_id, log_attempted_at, sent_at
           FROM sent_emails WHERE email_task_id = ?`
        )
        .bind(emailTaskId)
        .first<SentEmail>();
    },

    async beginSend(row, nowSec, ttlSec) {
      // INSERT OR IGNORE on the primary key is the atomic "first one wins".
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO sent_emails
             (email_task_id, contact_id, company_id, from_email, to_email, subject, html, open_token, status, lock_until,
              track_opens, track_clicks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`
        )
        .bind(
          row.emailTaskId,
          row.contactId,
          row.companyId,
          row.fromEmail,
          row.toEmail,
          row.subject,
          row.html,
          row.openToken,
          nowSec + ttlSec,
          row.trackOpens ? 1 : 0,
          row.trackClicks ? 1 : 0
        )
        .run();
      if (result.meta.changes !== 1) return false;
      if (row.links.length) {
        await db.batch(
          row.links.map((link) =>
            db
              .prepare('INSERT INTO tracked_links (token, email_task_id, url) VALUES (?, ?, ?)')
              .bind(link.token, row.emailTaskId, link.url)
          )
        );
      }
      return true;
    },

    async markSent(emailTaskId, gmailMessageId, at) {
      await db
        .prepare(
          `UPDATE sent_emails SET status = 'sent', gmail_message_id = ?, sent_at = ?, lock_until = NULL
           WHERE email_task_id = ?`
        )
        .bind(gmailMessageId, at, emailTaskId)
        .run();
    },

    async markUnknownIfStale(emailTaskId, nowSec) {
      const result = await db
        .prepare(
          `UPDATE sent_emails SET status = 'unknown', lock_until = NULL
           WHERE email_task_id = ? AND status = 'sending' AND lock_until < ?`
        )
        .bind(emailTaskId, nowSec)
        .run();
      return result.meta.changes === 1;
    },

    async markSentManually(emailTaskId, at) {
      await db
        .prepare(`UPDATE sent_emails SET status = 'sent', sent_at = ? WHERE email_task_id = ? AND status = 'unknown'`)
        .bind(at, emailTaskId)
        .run();
    },

    async discard(emailTaskId, status) {
      const row = await db
        .prepare('SELECT status FROM sent_emails WHERE email_task_id = ?')
        .bind(emailTaskId)
        .first<{ status: SendStatus }>();
      if (row?.status !== status) return;
      await db.batch([
        db.prepare('DELETE FROM tracked_links WHERE email_task_id = ?').bind(emailTaskId),
        db.prepare('DELETE FROM sent_emails WHERE email_task_id = ? AND status = ?').bind(emailTaskId, status),
      ]);
    },

    async setLoggedEmail(emailTaskId, loggedEmailId) {
      await db
        .prepare('UPDATE sent_emails SET logged_email_id = ? WHERE email_task_id = ?')
        .bind(loggedEmailId, emailTaskId)
        .run();
    },

    async markLogAttempted(emailTaskId, at) {
      const result = await db
        .prepare('UPDATE sent_emails SET log_attempted_at = ? WHERE email_task_id = ? AND log_attempted_at IS NULL')
        .bind(at, emailTaskId)
        .run();
      return result.meta.changes === 1;
    },

    async clearLogAttempt(emailTaskId) {
      await db
        .prepare('UPDATE sent_emails SET log_attempted_at = NULL WHERE email_task_id = ? AND logged_email_id IS NULL')
        .bind(emailTaskId)
        .run();
    },
  };
}

// --- Tracking ---

export interface TrackingTarget {
  email_task_id: string;
  contact_id: string;
  company_id: string | null;
  subject: string;
  to_email: string;
  sent_at: string | null;
}

export async function findByOpenToken(db: D1Database, token: string): Promise<TrackingTarget | null> {
  return db
    .prepare(
      `SELECT email_task_id, contact_id, company_id, subject, to_email, sent_at
       FROM sent_emails WHERE open_token = ? AND status = 'sent'`
    )
    .bind(token)
    .first<TrackingTarget>();
}

export async function findLink(db: D1Database, token: string): Promise<(TrackingTarget & { url: string }) | null> {
  return db
    .prepare(
      `SELECT l.url, s.email_task_id, s.contact_id, s.company_id, s.subject, s.to_email, s.sent_at
       FROM tracked_links l JOIN sent_emails s ON s.email_task_id = l.email_task_id
       WHERE l.token = ?`
    )
    .bind(token)
    .first<TrackingTarget & { url: string }>();
}

// Returns how many matching events came before this one: opens of this
// email, or clicks on this same link.
export async function recordTrackingEvent(
  db: D1Database,
  event: { emailTaskId: string; kind: 'open' | 'click'; url?: string | null; userAgent?: string | null }
): Promise<number> {
  const prior = await db
    .prepare('SELECT COUNT(*) AS n FROM tracking_events WHERE email_task_id = ? AND kind = ? AND url IS ?')
    .bind(event.emailTaskId, event.kind, event.url ?? null)
    .first<{ n: number }>();
  await db
    .prepare('INSERT INTO tracking_events (email_task_id, kind, url, user_agent) VALUES (?, ?, ?, ?)')
    .bind(event.emailTaskId, event.kind, event.url ?? null, event.userAgent ?? null)
    .run();
  return prior?.n ?? 0;
}

export async function latestAuditDetail<T>(db: D1Database, taskId: string, action: string): Promise<T | null> {
  const row = await db
    .prepare(
      `SELECT detail_json FROM audit_log
       WHERE task_id = ? AND action = ? AND outcome = 'success' ORDER BY id DESC LIMIT 1`
    )
    .bind(taskId, action)
    .first<{ detail_json: string | null }>();
  return row?.detail_json ? (JSON.parse(row.detail_json) as T) : null;
}

export interface NoteKey {
  emailTaskId: string;
  kind: 'open' | 'click';
  url: string | null; // null for opens
}

// True if this caller now owns writing the note for this key.
export async function claimTrackingNote(db: D1Database, key: NoteKey): Promise<boolean> {
  const result = await db
    .prepare('INSERT OR IGNORE INTO tracking_notes (email_task_id, kind, url_key) VALUES (?, ?, ?)')
    .bind(key.emailTaskId, key.kind, key.url ?? '')
    .run();
  return result.meta.changes === 1;
}

export async function releaseTrackingNote(db: D1Database, key: NoteKey): Promise<void> {
  await db
    .prepare('DELETE FROM tracking_notes WHERE email_task_id = ? AND kind = ? AND url_key = ?')
    .bind(key.emailTaskId, key.kind, key.url ?? '')
    .run();
}

export interface RecentSend {
  email_task_id: string;
  to_email: string;
  subject: string;
  status: SendStatus;
  sent_at: string | null;
  track_opens: number | null; // 0 = sent with open tracking off
  track_clicks: number | null;
  opens: number;
  clicks: number;
  last_event_at: string | null;
  last_open_at: string | null; // SQLite UTC, "YYYY-MM-DD HH:MM:SS" (see sqliteTime)
}

// A row of "Sent from this app", with what to do next: who it went to, the
// follow-up CALL task the send created, and the last call logged to the
// contact since (its outcome, and the next call it set up, if any).
export interface SentLogRow extends RecentSend {
  contact_id: string;
  company_id: string | null;
  call_task_id: string | null; // the send's follow-up CALL task (sent_confirmations)
  called_outcome: string | null; // the latest call logged to the contact since the send
  called_at: string | null; // SQLite UTC
  next_call_task_id: string | null; // the CALL task that call set up
}

export async function recentSends(db: D1Database, limit = 20): Promise<SentLogRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.email_task_id, s.contact_id, s.company_id, s.to_email, s.subject, s.status, s.sent_at,
              s.track_opens, s.track_clicks,
              COALESCE(SUM(e.kind = 'open'), 0) AS opens, COALESCE(SUM(e.kind = 'click'), 0) AS clicks,
              MAX(e.created_at) AS last_event_at, MAX(CASE WHEN e.kind = 'open' THEN e.created_at END) AS last_open_at,
              c.call_task_id, l.outcome AS called_outcome, l.created_at AS called_at,
              CASE WHEN l.next_type = 'CALL' THEN l.next_task_id END AS next_call_task_id
       FROM sent_emails s
       LEFT JOIN tracking_events e ON e.email_task_id = s.email_task_id
       LEFT JOIN sent_confirmations c ON c.email_task_id = s.email_task_id
       LEFT JOIN call_logs l ON l.call_task_id = (
         SELECT call_task_id FROM call_logs
         WHERE contact_id = s.contact_id AND julianday(created_at) >= julianday(s.sent_at)
         ORDER BY created_at DESC LIMIT 1
       )
       GROUP BY s.email_task_id ORDER BY COALESCE(s.sent_at, s.created_at) DESC LIMIT ?`
    )
    .bind(limit)
    .all<SentLogRow>();
  return results;
}

// Latest email the app sent to a contact, with its tracking counts, for the
// call page ("they clicked your link yesterday").
export async function latestSendToContact(db: D1Database, contactId: string): Promise<RecentSend | null> {
  return db
    .prepare(
      `SELECT s.email_task_id, s.to_email, s.subject, s.status, s.sent_at, s.track_opens, s.track_clicks,
              COALESCE(SUM(e.kind = 'open'), 0) AS opens, COALESCE(SUM(e.kind = 'click'), 0) AS clicks,
              MAX(e.created_at) AS last_event_at, MAX(CASE WHEN e.kind = 'open' THEN e.created_at END) AS last_open_at
       FROM sent_emails s LEFT JOIN tracking_events e ON e.email_task_id = s.email_task_id
       WHERE s.contact_id = ? AND s.status = 'sent'
       GROUP BY s.email_task_id ORDER BY s.sent_at DESC LIMIT 1`
    )
    .bind(contactId)
    .first<RecentSend>();
}

// CURRENT_TIMESTAMP is UTC with no zone marker ("2026-09-25 15:00:00").
export function sqliteTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : ms;
}

// Opens and clicks on every email the app sent each contact, for ranking the
// calls due: someone who clicked a link, or opened the email, is worth calling
// first. Contacts with no tracked email are left out. It reads every sent
// email rather than a list of contacts, since D1 caps a query at 100 bound
// values.
export interface ContactEngagement {
  opens: number;
  clicks: number;
  lastOpenAt: number | null; // epoch ms
}

export async function engagementByContact(db: D1Database): Promise<Map<string, ContactEngagement>> {
  const { results } = await db
    .prepare(
      `SELECT s.contact_id, COALESCE(SUM(e.kind = 'open'), 0) AS opens, COALESCE(SUM(e.kind = 'click'), 0) AS clicks,
              MAX(CASE WHEN e.kind = 'open' THEN e.created_at END) AS last_open_at
       FROM sent_emails s JOIN tracking_events e ON e.email_task_id = s.email_task_id
       WHERE s.status = 'sent'
       GROUP BY s.contact_id`
    )
    .all<{ contact_id: string; opens: number; clicks: number; last_open_at: string | null }>();
  return new Map(
    results.map((r) => [r.contact_id, { opens: r.opens, clicks: r.clicks, lastOpenAt: sqliteTime(r.last_open_at) }])
  );
}

// --- Today's counts ---

export interface DayActivity {
  emailsSent: number;
  peopleCalled: number;
}

// What the rep did between two instants (unix seconds, end exclusive), for
// the counts at the top of the pages.
// - Emails: sent through Gmail by the app, plus those marked sent by hand
//   (a confirmation with no Gmail send behind it).
// - People called: distinct contacts the app dialled (when the rep pressed 1,
//   or the browser placed the call: connected_at) or the rep logged a call
//   with, so a call made from their own phone and logged here counts too.
export async function dayActivity(db: D1Database, startSec: number, endSec: number): Promise<DayActivity> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sent_emails
          WHERE status = 'sent' AND unixepoch(sent_at) >= ?1 AND unixepoch(sent_at) < ?2)
         + (SELECT COUNT(*) FROM sent_confirmations c
            WHERE unixepoch(c.created_at) >= ?1 AND unixepoch(c.created_at) < ?2
              AND NOT EXISTS (SELECT 1 FROM sent_emails s WHERE s.email_task_id = c.email_task_id)) AS emails_sent,
         (SELECT COUNT(DISTINCT contact_id) FROM (
            -- A call back to someone not in HubSpot has no contact: their number stands in.
            SELECT COALESCE(NULLIF(contact_id, ''), 'tel:' || to_number) AS contact_id FROM dials
            WHERE unixepoch(connected_at) >= ?1 AND unixepoch(connected_at) < ?2
            UNION
            SELECT contact_id FROM call_logs WHERE unixepoch(created_at) >= ?1 AND unixepoch(created_at) < ?2
          )) AS people_called`
    )
    .bind(startSec, endSec)
    .first<{ emails_sent: number; people_called: number }>();
  return { emailsSent: row?.emails_sent ?? 0, peopleCalled: row?.people_called ?? 0 };
}

// --- Dials (click-to-call through Twilio) ---

// 'phone': Twilio rings the rep's phone, and pressing 1 dials the prospect.
// 'browser': the rep talks through the call page, which starts the call.
export const DIAL_MODES = ['phone', 'browser'] as const;
export type DialMode = (typeof DIAL_MODES)[number];

// What a dial was started from: a CALL task, an interview, or a call to the
// Twilio number being called back (its Inbound page).
export type DialSubject = 'task' | 'meeting' | 'inbound';

export interface Dial {
  id: string;
  task_id: string; // the CALL task, the meeting or the inbound call (see subject) the dial was started from
  subject: DialSubject;
  contact_id: string; // '' for a call back to a caller who isn't in HubSpot
  contact_label: string;
  to_number: string;
  to_extension: string | null; // keyed in once the line answers
  from_number: string;
  rep_number: string; // E.164, or 'browser'
  mode: DialMode;
  started_sec: number;
  rep_call_sid: string | null;
  rep_status: string | null;
  connected_at: string | null;
  prospect_call_sid: string | null;
  prospect_status: string | null;
  prospect_duration_sec: number | null;
  rep_ended_sec: number | null;
  record: number; // 1 if the call was recorded
  recording_sid: string | null;
  recording_duration_sec: number | null;
  recording_channels: number | null;
  transcript_status: 'transcribing' | 'done' | 'failed' | null;
  transcript_started_sec: number | null;
  transcript_json: string | null;
  summary: string | null;
  transcript_error: string | null;
  // A call back (subject 'inbound') logs itself on the contact; these are
  // that log's markers, like inbound_calls'. Unused for the other subjects,
  // whose calls the rep logs (call_logs, meeting_logs).
  log_attempted_at: string | null;
  logged_call_id: string | null;
  transcript_synced_at: string | null;
}

export type NewDial = Pick<
  Dial,
  | 'id'
  | 'task_id'
  | 'contact_id'
  | 'contact_label'
  | 'to_number'
  | 'to_extension'
  | 'from_number'
  | 'rep_number'
  | 'mode'
  | 'started_sec'
  | 'record'
  | 'subject'
>;

export interface DialStore {
  get(id: string): Promise<Dial | null>;
  getByRepCallSid(sid: string): Promise<Dial | null>;
  latestForTask(taskId: string): Promise<Dial | null>;
  // Records the dial only if no other dial for the task started within
  // `windowSec` and is still live. False means one is already ringing.
  begin(dial: NewDial, windowSec: number): Promise<boolean>;
  setRepCallSid(id: string, sid: string): Promise<void>;
  setRepStatus(id: string, status: string, endedSec?: number | null): Promise<void>;
  markConnected(id: string, at: string): Promise<void>;
  // The browser started a browser dial's call. The claimed dial only for the
  // first call on a dial that hasn't ended or been cancelled and started after
  // `notBeforeSec`, null otherwise: each dial connects at most once.
  claimBrowserCall(id: string, callSid: string, at: string, notBeforeSec: number): Promise<Dial | null>;
  // The page's browser call is over. Before it connected (the mic was
  // refused, the SDK failed) that's 'canceled', which frees the task to be
  // dialled again; after, 'completed'. Does nothing once Twilio's status
  // callback has reported the end, and that callback overwrites it.
  endBrowserCall(id: string, endedSec: number): Promise<void>;
  setProspectResult(id: string, result: { sid: string; status: string; durationSec: number | null }): Promise<void>;
  setRecording(
    id: string,
    recording: { sid: string; durationSec: number | null; channels: number | null }
  ): Promise<void>;
  // True if this caller now owns transcribing the recording: nobody has, the
  // last attempt failed, or a run that claimed it is older than `staleSec`.
  beginTranscript(id: string, nowSec: number, staleSec: number): Promise<boolean>;
  saveTranscript(id: string, transcriptJson: string, summary: string | null): Promise<void>;
  failTranscript(id: string, error: string): Promise<void>;
  // Recorded dials whose transcription died: claimed longer than `staleSec`
  // ago and never finished, or never claimed `staleSec` after the call.
  // Oldest first, for the cron sweep to run again.
  staleTranscripts(nowSec: number, staleSec: number, limit: number): Promise<string[]>;
  // A call back's own log on the contact, the same markers as InboundCallStore's.
  markLogAttempted(id: string, at: string): Promise<boolean>;
  clearLogAttempt(id: string): Promise<void>;
  setLoggedCall(id: string, loggedCallId: string): Promise<void>;
  markTranscriptSynced(id: string, at: string): Promise<void>;
}

const DIAL_COLUMNS = `id, task_id, subject, contact_id, contact_label, to_number, to_extension, from_number, rep_number, mode, started_sec,
  rep_call_sid, rep_status, connected_at, prospect_call_sid, prospect_status, prospect_duration_sec, rep_ended_sec,
  record, recording_sid, recording_duration_sec, recording_channels, transcript_status, transcript_started_sec,
  transcript_json, summary, transcript_error, log_attempted_at, logged_call_id, transcript_synced_at`;

export function d1DialStore(db: D1Database): DialStore {
  return {
    async get(id) {
      return db.prepare(`SELECT ${DIAL_COLUMNS} FROM dials WHERE id = ?`).bind(id).first<Dial>();
    },

    async getByRepCallSid(sid) {
      return db.prepare(`SELECT ${DIAL_COLUMNS} FROM dials WHERE rep_call_sid = ?`).bind(sid).first<Dial>();
    },

    async latestForTask(taskId) {
      return db
        .prepare(`SELECT ${DIAL_COLUMNS} FROM dials WHERE task_id = ? ORDER BY started_sec DESC, rowid DESC LIMIT 1`)
        .bind(taskId)
        .first<Dial>();
    },

    async begin(dial, windowSec) {
      // One statement, so two clicks at once can't both pass the check.
      const result = await db
        .prepare(
          `INSERT INTO dials (id, task_id, contact_id, contact_label, to_number, to_extension, from_number, rep_number, mode, started_sec, record, subject)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM dials WHERE task_id = ? AND rep_status IS NULL AND started_sec > ?
           )`
        )
        .bind(
          dial.id,
          dial.task_id,
          dial.contact_id,
          dial.contact_label,
          dial.to_number,
          dial.to_extension,
          dial.from_number,
          dial.rep_number,
          dial.mode,
          dial.started_sec,
          dial.record,
          dial.subject,
          dial.task_id,
          dial.started_sec - windowSec
        )
        .run();
      return result.meta.changes === 1;
    },

    async setRepCallSid(id, sid) {
      await db.prepare('UPDATE dials SET rep_call_sid = ? WHERE id = ?').bind(sid, id).run();
    },

    async setRepStatus(id, status, endedSec = null) {
      await db
        .prepare('UPDATE dials SET rep_status = ?, rep_ended_sec = ? WHERE id = ?')
        .bind(status, endedSec, id)
        .run();
    },

    async markConnected(id, at) {
      await db.prepare('UPDATE dials SET connected_at = COALESCE(connected_at, ?) WHERE id = ?').bind(at, id).run();
    },

    async claimBrowserCall(id, callSid, at, notBeforeSec) {
      // One statement, so it and endBrowserCall can't both win.
      return db
        .prepare(
          `UPDATE dials SET rep_call_sid = ?, connected_at = ?
           WHERE id = ? AND mode = 'browser' AND connected_at IS NULL AND rep_status IS NULL AND started_sec >= ?
           RETURNING ${DIAL_COLUMNS}`
        )
        .bind(callSid, at, id, notBeforeSec)
        .first<Dial>();
    },

    async endBrowserCall(id, endedSec) {
      await db
        .prepare(
          `UPDATE dials SET rep_status = CASE WHEN connected_at IS NULL THEN 'canceled' ELSE 'completed' END,
             rep_ended_sec = ?
           WHERE id = ? AND mode = 'browser' AND rep_status IS NULL`
        )
        .bind(endedSec, id)
        .run();
    },

    async setProspectResult(id, result) {
      await db
        .prepare('UPDATE dials SET prospect_call_sid = ?, prospect_status = ?, prospect_duration_sec = ? WHERE id = ?')
        .bind(result.sid, result.status, result.durationSec, id)
        .run();
    },

    async setRecording(id, recording) {
      await db
        .prepare('UPDATE dials SET recording_sid = ?, recording_duration_sec = ?, recording_channels = ? WHERE id = ?')
        .bind(recording.sid, recording.durationSec, recording.channels, id)
        .run();
    },

    async beginTranscript(id, nowSec, staleSec) {
      // One UPDATE, so a Twilio retry and a rep's Retry click can't both win.
      const result = await db
        .prepare(
          `UPDATE dials SET transcript_status = 'transcribing', transcript_started_sec = ?, transcript_error = NULL
           WHERE id = ? AND recording_sid IS NOT NULL
             AND (transcript_status IS NULL OR transcript_status = 'failed'
                  OR (transcript_status = 'transcribing' AND transcript_started_sec < ?))`
        )
        .bind(nowSec, id, nowSec - staleSec)
        .run();
      return result.meta.changes === 1;
    },

    async staleTranscripts(nowSec, staleSec, limit) {
      const { results } = await db
        .prepare(
          `SELECT id FROM dials
           WHERE recording_sid IS NOT NULL
             AND ((transcript_status = 'transcribing' AND transcript_started_sec < ?1)
                  OR (transcript_status IS NULL AND started_sec + COALESCE(prospect_duration_sec, 0) < ?1))
           ORDER BY started_sec LIMIT ?2`
        )
        .bind(nowSec - staleSec, limit)
        .all<{ id: string }>();
      return results.map((r) => r.id);
    },

    async saveTranscript(id, transcriptJson, summary) {
      await db
        .prepare(
          `UPDATE dials SET transcript_status = 'done', transcript_json = ?, summary = ?, transcript_error = NULL
           WHERE id = ?`
        )
        .bind(transcriptJson, summary, id)
        .run();
    },

    async failTranscript(id, error) {
      await db
        .prepare(`UPDATE dials SET transcript_status = 'failed', transcript_error = ? WHERE id = ?`)
        .bind(error.slice(0, 500), id)
        .run();
    },

    async markLogAttempted(id, at) {
      const result = await db
        .prepare('UPDATE dials SET log_attempted_at = ? WHERE id = ? AND log_attempted_at IS NULL')
        .bind(at, id)
        .run();
      return result.meta.changes === 1;
    },

    async clearLogAttempt(id) {
      await db
        .prepare('UPDATE dials SET log_attempted_at = NULL WHERE id = ? AND logged_call_id IS NULL')
        .bind(id)
        .run();
    },

    async setLoggedCall(id, loggedCallId) {
      await db.prepare('UPDATE dials SET logged_call_id = ? WHERE id = ?').bind(loggedCallId, id).run();
    },

    async markTranscriptSynced(id, at) {
      await db.prepare('UPDATE dials SET transcript_synced_at = ? WHERE id = ?').bind(at, id).run();
    },
  };
}

// --- Call logs (the rep's outcome, written to HubSpot) ---

// How the rep reached them: a phone call (from the app or another way), or
// from their own WhatsApp (lib/whatsapp.ts), a call or a message.
export const CALL_CHANNELS = ['phone', 'whatsapp_call', 'whatsapp_message'] as const;
export type CallChannel = (typeof CALL_CHANNELS)[number];

export interface CallLog {
  call_task_id: string;
  contact_id: string;
  company_id: string | null;
  owner_id: string | null;
  title: string;
  channel: CallChannel;
  outcome: string;
  notes: string; // a WhatsApp message's text
  twilio_status: string | null;
  duration_sec: number | null;
  from_number: string | null;
  to_number: string | null;
  next_type: 'CALL' | 'EMAIL' | null;
  next_subject: string | null;
  next_due: string | null;
  next_set_time: number; // 1: next_due is the time the contact asked to be called at (lib/set-time.ts)
  next_body: string | null; // an EMAIL follow-up's draft ("Subject: …" task body), from a template
  log_attempted_at: string | null;
  logged_call_id: string | null;
  logged_message_id: string | null; // a WhatsApp message's step 1, in place of logged_call_id
  completed_at: string | null;
  next_task_id: string | null;
  lead_status_at: string | null;
  dial_id: string | null;
  transcript_synced_at: string | null;
  book_start: string | null; // the interview the call booked, ISO; NULL for none
  book_title: string | null;
  book_minutes: number | null;
  book_join_url: string | null;
  book_phone: string | null; // E.164: a phone interview, the rep calls this number; NULL for video
  book_invite: number; // 1: send the contact a calendar invite for the interview
  book_invitee_email: string | null;
  book_calendar_event_id: string | null; // the invite went out
  booked_meeting_id: string | null;
  lock_until: number | null; // epoch seconds: a run is writing to HubSpot until then
  last_error: string | null; // why the last run stopped short, until one finishes
}

export type NewCallLog = Omit<
  CallLog,
  | 'lock_until'
  | 'last_error'
  | 'log_attempted_at'
  | 'logged_call_id'
  | 'logged_message_id'
  | 'completed_at'
  | 'next_task_id'
  | 'lead_status_at'
  | 'transcript_synced_at'
  | 'booked_meeting_id'
  | 'book_calendar_event_id'
>;

// What the "call logged" workflow needs from storage.
export interface CallLogStore {
  get(callTaskId: string): Promise<CallLog | null>;
  // No-op if the row already exists: the first submission's values stick.
  create(row: NewCallLog): Promise<void>;
  acquireLock(callTaskId: string, nowSec: number, ttlSec: number): Promise<boolean>;
  releaseLock(callTaskId: string): Promise<void>;
  // True if this caller may log the call to HubSpot: no earlier attempt.
  markLogAttempted(callTaskId: string, at: string): Promise<boolean>;
  // HubSpot definitely rejected the log, so a retry may try again.
  clearLogAttempt(callTaskId: string): Promise<void>;
  setLoggedCall(callTaskId: string, loggedCallId: string): Promise<void>;
  setLoggedMessage(callTaskId: string, loggedMessageId: string): Promise<void>;
  markCompleted(callTaskId: string, at: string): Promise<void>;
  setNextTask(callTaskId: string, taskId: string): Promise<void>;
  markLeadStatusDone(callTaskId: string, at: string): Promise<void>;
  // The call task whose logged call belongs to this dial, if the rep logged one.
  taskForDial(dialId: string): Promise<string | null>;
  markTranscriptSynced(callTaskId: string, at: string): Promise<void>;
  setBookedMeeting(callTaskId: string, meetingId: string): Promise<void>;
  setBookedInvite(callTaskId: string, eventId: string, joinUrl: string | null): Promise<void>;
  // Why a run stopped short (null once one finishes), for the notice.
  setError(callTaskId: string, error: string | null): Promise<void>;
}

export function d1CallLogStore(db: D1Database): CallLogStore {
  return {
    async get(callTaskId) {
      return db
        .prepare(
          `SELECT call_task_id, contact_id, company_id, owner_id, title, channel, outcome, notes, twilio_status,
                  duration_sec, from_number, to_number, next_type, next_subject, next_due, next_set_time, next_body,
                  log_attempted_at, logged_call_id, logged_message_id, completed_at, next_task_id, lead_status_at, dial_id, transcript_synced_at,
                  book_start, book_title, book_minutes, book_join_url, book_phone, book_invite, book_invitee_email,
                  book_calendar_event_id, booked_meeting_id, lock_until, last_error
           FROM call_logs WHERE call_task_id = ?`
        )
        .bind(callTaskId)
        .first<CallLog>();
    },

    async create(row) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO call_logs
             (call_task_id, contact_id, company_id, owner_id, title, channel, outcome, notes, twilio_status,
              duration_sec, from_number, to_number, next_type, next_subject, next_due, next_set_time, next_body,
              dial_id, book_start, book_title, book_minutes, book_join_url, book_phone, book_invite, book_invitee_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.call_task_id,
          row.contact_id,
          row.company_id,
          row.owner_id,
          row.title,
          row.channel,
          row.outcome,
          row.notes,
          row.twilio_status,
          row.duration_sec,
          row.from_number,
          row.to_number,
          row.next_type,
          row.next_subject,
          row.next_due,
          row.next_set_time,
          row.next_body,
          row.dial_id,
          row.book_start,
          row.book_title,
          row.book_minutes,
          row.book_join_url,
          row.book_phone,
          row.book_invite,
          row.book_invitee_email
        )
        .run();
    },

    async acquireLock(callTaskId, nowSec, ttlSec) {
      const result = await db
        .prepare(
          `UPDATE call_logs SET lock_until = ?
           WHERE call_task_id = ? AND (lock_until IS NULL OR lock_until < ?)`
        )
        .bind(nowSec + ttlSec, callTaskId, nowSec)
        .run();
      return result.meta.changes === 1;
    },

    async releaseLock(callTaskId) {
      await db.prepare('UPDATE call_logs SET lock_until = NULL WHERE call_task_id = ?').bind(callTaskId).run();
    },

    async markLogAttempted(callTaskId, at) {
      const result = await db
        .prepare('UPDATE call_logs SET log_attempted_at = ? WHERE call_task_id = ? AND log_attempted_at IS NULL')
        .bind(at, callTaskId)
        .run();
      return result.meta.changes === 1;
    },

    async clearLogAttempt(callTaskId) {
      await db
        .prepare(
          `UPDATE call_logs SET log_attempted_at = NULL
           WHERE call_task_id = ? AND logged_call_id IS NULL AND logged_message_id IS NULL`
        )
        .bind(callTaskId)
        .run();
    },

    async setLoggedCall(callTaskId, loggedCallId) {
      await db
        .prepare('UPDATE call_logs SET logged_call_id = ? WHERE call_task_id = ?')
        .bind(loggedCallId, callTaskId)
        .run();
    },

    async setLoggedMessage(callTaskId, loggedMessageId) {
      await db
        .prepare('UPDATE call_logs SET logged_message_id = ? WHERE call_task_id = ?')
        .bind(loggedMessageId, callTaskId)
        .run();
    },

    async markCompleted(callTaskId, at) {
      await db.prepare('UPDATE call_logs SET completed_at = ? WHERE call_task_id = ?').bind(at, callTaskId).run();
    },

    async setNextTask(callTaskId, taskId) {
      await db.prepare('UPDATE call_logs SET next_task_id = ? WHERE call_task_id = ?').bind(taskId, callTaskId).run();
    },

    async taskForDial(dialId) {
      const row = await db
        .prepare('SELECT call_task_id FROM call_logs WHERE dial_id = ?')
        .bind(dialId)
        .first<{ call_task_id: string }>();
      return row?.call_task_id ?? null;
    },

    async markTranscriptSynced(callTaskId, at) {
      await db
        .prepare('UPDATE call_logs SET transcript_synced_at = ? WHERE call_task_id = ?')
        .bind(at, callTaskId)
        .run();
    },

    async markLeadStatusDone(callTaskId, at) {
      await db.prepare('UPDATE call_logs SET lead_status_at = ? WHERE call_task_id = ?').bind(at, callTaskId).run();
    },

    async setBookedInvite(callTaskId, eventId, joinUrl) {
      await db
        .prepare('UPDATE call_logs SET book_calendar_event_id = ?, book_join_url = ? WHERE call_task_id = ?')
        .bind(eventId, joinUrl, callTaskId)
        .run();
    },

    async setBookedMeeting(callTaskId, meetingId) {
      await db
        .prepare('UPDATE call_logs SET booked_meeting_id = ? WHERE call_task_id = ?')
        .bind(meetingId, callTaskId)
        .run();
    },

    async setError(callTaskId, error) {
      await db
        .prepare('UPDATE call_logs SET last_error = ? WHERE call_task_id = ?')
        .bind(error === null ? null : error.slice(0, 500), callTaskId)
        .run();
    },
  };
}

// A call the rep logged from the app, for the Claude connector's recently
// logged calls, with its dial's transcript summary when there is one.
export interface RecentCallLog {
  call_task_id: string;
  contact_id: string;
  company_id: string | null;
  title: string;
  outcome: string;
  notes: string;
  duration_sec: number | null;
  created_at: string; // SQLite UTC (see sqliteTime)
  summary: string | null;
  transcript_status: string | null;
}

export async function recentCallLogs(db: D1Database, limit: number): Promise<RecentCallLog[]> {
  const { results } = await db
    .prepare(
      `SELECT l.call_task_id, l.contact_id, l.company_id, l.title, l.outcome, l.notes, l.duration_sec, l.created_at,
              d.summary, d.transcript_status
       FROM call_logs l LEFT JOIN dials d ON d.id = l.dial_id
       ORDER BY l.created_at DESC LIMIT ?`
    )
    .bind(limit)
    .all<RecentCallLog>();
  return results;
}

// --- The Calls page (/calls: the record of every call, in and out) ---

// The dial's columns, for a query that joins another table that has some of
// the same names.
const HISTORY_DIAL_COLUMNS = DIAL_COLUMNS.split(',')
  .map((c) => `d.${c.trim()}`)
  .join(', ');

// A search matches the spoken words of a transcript, not its JSON's keys.
const transcriptMatches = (column: string) =>
  `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_extract(value, '$.text') LIKE ?2 ESCAPE '\\')`;

// Calls after the page's cursor (?1 its time, ?5 its key), newest first: the
// same order as mergeHistory, time then key (historyKey in lib/call-history.ts).
const afterCursor = (at: string, key: string) => `(${at} < ?1 OR (${at} = ?1 AND ${key} < ?5))`;

// One page of the record, newest first (see lib/call-history.ts). Each query
// takes ?1 and ?5 the cursor to page after, ?2 the search's LIKE pattern (or
// NULL), ?3 the phone-number pattern (or NULL) and ?4 how many rows.
export async function callHistory(db: D1Database, filters: HistoryFilters, limit: number): Promise<HistoryPage> {
  const params = [
    filters.before?.sec ?? Number.MAX_SAFE_INTEGER,
    filters.q === null ? null : likePattern(filters.q),
    filters.q === null ? null : numberPattern(filters.q),
    limit + 1,
    filters.before?.key ?? '',
  ];
  const all = async <T>(sql: string): Promise<T[]> =>
    (
      await db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  const [dials, inbound, logged] = await Promise.all([
    filters.dir === 'in'
      ? []
      : all<HistoryDial>(
          `SELECT ${HISTORY_DIAL_COLUMNS}, l.call_task_id AS log_task_id, l.outcome AS log_outcome, l.notes AS log_notes
           FROM dials d LEFT JOIN call_logs l ON l.dial_id = d.id
           WHERE ${afterCursor('d.started_sec', "'d:' || d.id")}
             AND (?2 IS NULL OR d.contact_label LIKE ?2 ESCAPE '\\' OR d.summary LIKE ?2 ESCAPE '\\'
                  OR l.notes LIKE ?2 ESCAPE '\\' OR ${transcriptMatches('d.transcript_json')}
                  OR d.to_number LIKE ?3)
           ORDER BY d.started_sec DESC, 'd:' || d.id DESC LIMIT ?4`
        ),
    filters.dir === 'out'
      ? []
      : all<InboundCall>(
          `SELECT ${INBOUND_COLUMNS} FROM inbound_calls
           WHERE ${afterCursor('started_sec', "'i:' || id")}
             AND (?2 IS NULL OR contact_label LIKE ?2 ESCAPE '\\' OR caller_name LIKE ?2 ESCAPE '\\'
                  OR summary LIKE ?2 ESCAPE '\\' OR ${transcriptMatches('transcript_json')}
                  OR from_number LIKE ?3)
           ORDER BY started_sec DESC, 'i:' || id DESC LIMIT ?4`
        ),
    filters.dir === 'in'
      ? []
      : all<HandLoggedCall>(
          `SELECT * FROM (
             SELECT call_task_id, contact_id, title, channel, outcome, notes, duration_sec, to_number,
                    CAST(strftime('%s', created_at) AS INTEGER) AS at_sec
             FROM call_logs WHERE dial_id IS NULL
               AND (?2 IS NULL OR title LIKE ?2 ESCAPE '\\' OR notes LIKE ?2 ESCAPE '\\' OR to_number LIKE ?3)
           ) WHERE ${afterCursor('at_sec', "'l:' || call_task_id")}
           ORDER BY at_sec DESC, 'l:' || call_task_id DESC LIMIT ?4`
        ),
  ]);
  return mergeHistory(dials, inbound, logged, limit);
}

// Missed calls and voicemails from the last CALL_BACK_WINDOW_SEC that nobody has returned: the
// number hasn't actually been dialled from the app since (a call back, or a call from
// a task or an interview), hasn't called in again and been answered, and the
// rep hasn't dismissed it. One row per number, its latest call, newest first.
export async function waitingOnCallBack(db: D1Database, nowSec: number): Promise<InboundCall[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INBOUND_COLUMNS} FROM inbound_calls i
       WHERE i.started_sec > ?1 AND i.status IS NOT NULL AND i.answered_at IS NULL
         AND i.callback_dismissed_at IS NULL AND i.from_number LIKE '+%'
         -- connected_at: the rep pressed 1 or the browser call started, so their
         -- number was really dialled. A dial the rep never confirmed returns nothing.
         AND NOT EXISTS (SELECT 1 FROM dials d WHERE d.to_number = i.from_number AND d.started_sec > i.started_sec
                                                  AND d.connected_at IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM inbound_calls j
                         WHERE j.from_number = i.from_number AND j.started_sec > i.started_sec)
       ORDER BY i.started_sec DESC LIMIT ?2`
    )
    .bind(nowSec - CALL_BACK_WINDOW_SEC, CALL_BACK_LIMIT)
    .all<InboundCall>();
  return results;
}

// Takes the caller off "Waiting on a call back": every unanswered call from
// their number up to this one. False if there's no such call.
export async function dismissCallBack(db: D1Database, inboundCallId: string, at: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE inbound_calls SET callback_dismissed_at = ?1
       WHERE callback_dismissed_at IS NULL AND answered_at IS NULL
         AND from_number = (SELECT from_number FROM inbound_calls WHERE id = ?2)
         AND started_sec <= (SELECT started_sec FROM inbound_calls WHERE id = ?2)`
    )
    .bind(at, inboundCallId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

// --- Opening a contact's task from their page ---

export interface ContactTaskLockStore {
  // The lease (its expiry, epoch seconds) if this caller may open or create
  // the contact's task of this type; null while another holds it.
  acquire(contactId: string, type: 'CALL' | 'EMAIL', nowSec: number, ttlSec: number): Promise<number | null>;
  // Frees this caller's lease only: once it expired, a later caller may hold
  // the lock, and that one stays.
  release(contactId: string, type: 'CALL' | 'EMAIL', lease: number): Promise<void>;
}

export function d1ContactTaskLockStore(db: D1Database): ContactTaskLockStore {
  return {
    async acquire(contactId, type, nowSec, ttlSec) {
      const result = await db
        .prepare(
          `INSERT INTO contact_task_locks (contact_id, type, lock_until) VALUES (?, ?, ?)
           ON CONFLICT (contact_id, type) DO UPDATE SET lock_until = excluded.lock_until
           WHERE contact_task_locks.lock_until < ?`
        )
        .bind(contactId, type, nowSec + ttlSec, nowSec)
        .run();
      return result.meta.changes === 1 ? nowSec + ttlSec : null;
    },

    // A later lease always ends later (it's only taken once this one ended),
    // so the expiry tells them apart.
    async release(contactId, type, lease) {
      await db
        .prepare('DELETE FROM contact_task_locks WHERE contact_id = ? AND type = ? AND lock_until = ?')
        .bind(contactId, type, lease)
        .run();
    },
  };
}

// --- Writes to HubSpot still running, or stopped short ---

// A logged call or a sent email whose HubSpot steps haven't all landed:
// still being written (a run holds the lock), or stopped short (an error, or
// the Worker was stopped mid-run). Opening its page finishes it.
export interface UnfinishedWrite {
  kind: 'call' | 'email';
  taskId: string;
  label: string;
  saving: boolean;
  error: string | null;
  sentByApp: boolean; // an email sent from here (else marked sent by hand)
}

// The last week's, newest first. The call conditions mirror callLogDone
// (workflows/call-logged.ts); an email is done once its task is completed
// and the follow-up call task exists.
export async function unfinishedWrites(db: D1Database, nowSec: number): Promise<UnfinishedWrite[]> {
  const { results } = await db
    .prepare(
      `SELECT 'call' AS kind, call_task_id AS task_id, title AS label, lock_until, last_error, 0 AS sent_by_app,
              created_at
       FROM call_logs
       WHERE created_at >= datetime('now', '-7 days')
         AND NOT ((logged_call_id IS NOT NULL OR logged_message_id IS NOT NULL OR log_attempted_at IS NOT NULL)
                  AND completed_at IS NOT NULL
                  AND (next_type IS NULL OR next_task_id IS NOT NULL)
                  AND lead_status_at IS NOT NULL
                  AND (book_start IS NULL OR booked_meeting_id IS NOT NULL))
       UNION ALL
       SELECT 'email', c.email_task_id, COALESCE('Email to ' || s.to_email, 'Email task ' || c.email_task_id),
              c.lock_until, c.last_error, s.email_task_id IS NOT NULL, c.created_at
       FROM sent_confirmations c LEFT JOIN sent_emails s ON s.email_task_id = c.email_task_id
       WHERE c.created_at >= datetime('now', '-7 days')
         AND (c.completed_at IS NULL OR c.call_task_id IS NULL)
       ORDER BY created_at DESC
       LIMIT 20`
    )
    .all<{
      kind: 'call' | 'email';
      task_id: string;
      label: string;
      lock_until: number | null;
      last_error: string | null;
      sent_by_app: number;
    }>();
  return results.map((r) => ({
    kind: r.kind,
    taskId: r.task_id,
    label: r.label,
    saving: r.lock_until !== null && r.lock_until >= nowSec,
    error: r.last_error,
    sentByApp: r.sent_by_app === 1,
  }));
}

// --- Inbound calls (someone rang the Twilio number) ---

export interface InboundCall {
  id: string;
  call_sid: string;
  from_number: string;
  to_number: string;
  rep_number: string | null;
  started_sec: number;
  contact_id: string | null;
  company_id: string | null;
  owner_id: string | null;
  contact_label: string | null;
  record: number;
  answered_at: string | null;
  talk_sec: number | null;
  voicemail: number;
  status: string | null;
  ended_sec: number | null;
  recording_sid: string | null;
  recording_duration_sec: number | null;
  recording_channels: number | null;
  transcript_status: 'transcribing' | 'done' | 'failed' | null;
  transcript_started_sec: number | null;
  transcript_json: string | null;
  summary: string | null;
  transcript_error: string | null;
  log_attempted_at: string | null;
  logged_call_id: string | null;
  transcript_synced_at: string | null;
  // From Twilio's webhook: where the number is registered, and the caller ID
  // name (only with Caller Name Lookup on). NULL when Twilio sent nothing.
  from_city: string | null;
  from_state: string | null;
  from_country: string | null;
  caller_name: string | null;
  callback_dismissed_at: string | null; // the rep took it off "Waiting on a call back"
}

// The HubSpot contact a call is from, found by its number.
export type InboundCaller = Pick<InboundCall, 'contact_id' | 'company_id' | 'owner_id' | 'contact_label'>;

export type NewInboundCall = Pick<
  InboundCall,
  | 'id'
  | 'call_sid'
  | 'from_number'
  | 'to_number'
  | 'rep_number'
  | 'started_sec'
  | 'contact_id'
  | 'company_id'
  | 'owner_id'
  | 'contact_label'
  | 'record'
  | 'from_city'
  | 'from_state'
  | 'from_country'
  | 'caller_name'
>;

export interface InboundCallStore {
  get(id: string): Promise<InboundCall | null>;
  byCallSid(callSid: string): Promise<InboundCall | null>;
  recent(limit: number): Promise<InboundCall[]>;
  // The latest calls from this number, newest first.
  fromNumber(number: string, limit: number): Promise<InboundCall[]>;
  // No-op if Twilio already reported this call: the first row sticks.
  create(call: NewInboundCall): Promise<void>;
  // True the first time only: the caller who gets it starts the recording,
  // so a Twilio retry of the rep's key press can't start a second one.
  markAnswered(id: string, at: string): Promise<boolean>;
  setTalk(id: string, talkSec: number | null): Promise<void>;
  markVoicemail(id: string): Promise<void>;
  // The caller turned out to be a HubSpot contact after all (the number was
  // added to them since). Only fills a call that has no contact yet.
  setCaller(id: string, caller: InboundCaller): Promise<boolean>;
  setStatus(id: string, status: string, endedSec: number): Promise<void>;
  setRecording(
    id: string,
    recording: { sid: string; durationSec: number | null; channels: number | null }
  ): Promise<void>;
  beginTranscript(id: string, nowSec: number, staleSec: number): Promise<boolean>;
  saveTranscript(id: string, transcriptJson: string, summary: string | null): Promise<void>;
  failTranscript(id: string, error: string): Promise<void>;
  // True if this caller may log the call to HubSpot: no earlier attempt.
  markLogAttempted(id: string, at: string): Promise<boolean>;
  // HubSpot definitely rejected the log, so a retry may try again.
  clearLogAttempt(id: string): Promise<void>;
  setLoggedCall(id: string, loggedCallId: string): Promise<void>;
  markTranscriptSynced(id: string, at: string): Promise<void>;
}

const INBOUND_COLUMNS = `id, call_sid, from_number, to_number, rep_number, started_sec, contact_id, company_id, owner_id,
  contact_label, record, answered_at, talk_sec, voicemail, status, ended_sec, recording_sid, recording_duration_sec,
  recording_channels, transcript_status, transcript_started_sec, transcript_json, summary, transcript_error,
  log_attempted_at, logged_call_id, transcript_synced_at, from_city, from_state, from_country, caller_name,
  callback_dismissed_at`;

export function d1InboundCallStore(db: D1Database): InboundCallStore {
  const set = async (sql: string, ...params: unknown[]) => {
    await db
      .prepare(`UPDATE inbound_calls SET ${sql}`)
      .bind(...params)
      .run();
  };
  return {
    async get(id) {
      return db.prepare(`SELECT ${INBOUND_COLUMNS} FROM inbound_calls WHERE id = ?`).bind(id).first<InboundCall>();
    },

    async byCallSid(callSid) {
      return db
        .prepare(`SELECT ${INBOUND_COLUMNS} FROM inbound_calls WHERE call_sid = ?`)
        .bind(callSid)
        .first<InboundCall>();
    },

    async recent(limit) {
      const { results } = await db
        .prepare(`SELECT ${INBOUND_COLUMNS} FROM inbound_calls ORDER BY started_sec DESC, rowid DESC LIMIT ?`)
        .bind(limit)
        .all<InboundCall>();
      return results;
    },

    async fromNumber(number, limit) {
      const { results } = await db
        .prepare(
          `SELECT ${INBOUND_COLUMNS} FROM inbound_calls WHERE from_number = ?
           ORDER BY started_sec DESC, rowid DESC LIMIT ?`
        )
        .bind(number, limit)
        .all<InboundCall>();
      return results;
    },

    async create(call) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO inbound_calls
             (id, call_sid, from_number, to_number, rep_number, started_sec, contact_id, company_id, owner_id,
              contact_label, record, from_city, from_state, from_country, caller_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          call.id,
          call.call_sid,
          call.from_number,
          call.to_number,
          call.rep_number,
          call.started_sec,
          call.contact_id,
          call.company_id,
          call.owner_id,
          call.contact_label,
          call.record,
          call.from_city,
          call.from_state,
          call.from_country,
          call.caller_name
        )
        .run();
    },

    async markAnswered(id, at) {
      const result = await db
        .prepare('UPDATE inbound_calls SET answered_at = ? WHERE id = ? AND answered_at IS NULL')
        .bind(at, id)
        .run();
      return result.meta.changes === 1;
    },

    async setTalk(id, talkSec) {
      await set('talk_sec = ? WHERE id = ?', talkSec, id);
    },

    async markVoicemail(id) {
      await set('voicemail = 1 WHERE id = ?', id);
    },

    async setCaller(id, caller) {
      const result = await db
        .prepare(
          `UPDATE inbound_calls SET contact_id = ?, company_id = ?, owner_id = ?, contact_label = ?
           WHERE id = ? AND contact_id IS NULL`
        )
        .bind(caller.contact_id, caller.company_id, caller.owner_id, caller.contact_label, id)
        .run();
      return result.meta.changes === 1;
    },

    async setStatus(id, status, endedSec) {
      await set('status = ?, ended_sec = ? WHERE id = ?', status, endedSec, id);
    },

    async setRecording(id, recording) {
      await set(
        'recording_sid = ?, recording_duration_sec = ?, recording_channels = ? WHERE id = ?',
        recording.sid,
        recording.durationSec,
        recording.channels,
        id
      );
    },

    async beginTranscript(id, nowSec, staleSec) {
      // One UPDATE, so a Twilio retry and a rep's Retry click can't both win.
      const result = await db
        .prepare(
          `UPDATE inbound_calls SET transcript_status = 'transcribing', transcript_started_sec = ?, transcript_error = NULL
           WHERE id = ? AND recording_sid IS NOT NULL
             AND (transcript_status IS NULL OR transcript_status = 'failed'
                  OR (transcript_status = 'transcribing' AND transcript_started_sec < ?))`
        )
        .bind(nowSec, id, nowSec - staleSec)
        .run();
      return result.meta.changes === 1;
    },

    async saveTranscript(id, transcriptJson, summary) {
      await set(
        `transcript_status = 'done', transcript_json = ?, summary = ?, transcript_error = NULL WHERE id = ?`,
        transcriptJson,
        summary,
        id
      );
    },

    async failTranscript(id, error) {
      await set(`transcript_status = 'failed', transcript_error = ? WHERE id = ?`, error.slice(0, 500), id);
    },

    async markLogAttempted(id, at) {
      const result = await db
        .prepare('UPDATE inbound_calls SET log_attempted_at = ? WHERE id = ? AND log_attempted_at IS NULL')
        .bind(at, id)
        .run();
      return result.meta.changes === 1;
    },

    async clearLogAttempt(id) {
      await set('log_attempted_at = NULL WHERE id = ? AND logged_call_id IS NULL', id);
    },

    async setLoggedCall(id, loggedCallId) {
      await set('logged_call_id = ? WHERE id = ?', loggedCallId, id);
    },

    async markTranscriptSynced(id, at) {
      await set('transcript_synced_at = ? WHERE id = ?', at, id);
    },
  };
}

// --- Meeting logs (the rep's interview outcome, written to HubSpot) ---

// Who called a canceled interview off: 'them' told the rep ahead (a reply),
// 'rep' is the rep.
export type CanceledBy = 'them' | 'rep';

export interface MeetingLog {
  log_id: string;
  meeting_id: string;
  contact_id: string;
  company_id: string | null;
  owner_id: string | null;
  outcome: 'COMPLETED' | 'NO_SHOW' | 'CANCELED' | 'RESCHEDULED';
  canceled_by: CanceledBy | null; // CANCELED only: who called it off (D1 only)
  notes: string;
  internal_notes_html: string;
  new_start: string | null;
  new_end: string | null;
  next_type: 'CALL' | 'EMAIL' | null;
  next_subject: string | null;
  next_due: string | null;
  next_body: string | null; // an EMAIL follow-up's draft ("Subject: …" task body), from a template
  calendar_event_id: string | null; // the invite the app sent for this interview, if any
  outcome_at: string | null;
  calendar_at: string | null; // step 2 done: the invite moved or canceled (only when there's one to change)
  next_task_id: string | null;
  lead_status_at: string | null;
}

export type NewMeetingLog = Omit<MeetingLog, 'outcome_at' | 'calendar_at' | 'next_task_id' | 'lead_status_at'>;

export interface MeetingLogStore {
  get(logId: string): Promise<MeetingLog | null>;
  // The meeting's log that stopped partway, if any. A reschedule that landed
  // moves the meeting off the start time in its key, so it's found by meeting.
  unfinished(meetingId: string): Promise<MeetingLog | null>;
  // The calendar invite the app sent when it booked this meeting, if any.
  calendarEventFor(meetingId: string): Promise<string | null>;
  // The meeting's latest log (how the interview went, as of now), if any;
  // with `sinceSec`, only one made at or after then (the log of the call
  // started then, not of an earlier occurrence, moved since).
  latest(meetingId: string, sinceSec?: number | null): Promise<MeetingLog | null>;
  // No-op if the row already exists: the first submission's values stick.
  create(row: NewMeetingLog): Promise<void>;
  acquireLock(logId: string, nowSec: number, ttlSec: number): Promise<boolean>;
  releaseLock(logId: string): Promise<void>;
  markOutcome(logId: string, at: string): Promise<void>;
  markCalendarDone(logId: string, at: string): Promise<void>;
  setNextTask(logId: string, taskId: string): Promise<void>;
  markLeadStatusDone(logId: string, at: string): Promise<void>;
}

const MEETING_LOG_COLUMNS = `log_id, meeting_id, contact_id, company_id, owner_id, outcome, canceled_by, notes, internal_notes_html,
  new_start, new_end, next_type, next_subject, next_due, next_body, calendar_event_id, outcome_at, calendar_at,
  next_task_id, lead_status_at`;

export function d1MeetingLogStore(db: D1Database): MeetingLogStore {
  return {
    async get(logId) {
      return db
        .prepare(`SELECT ${MEETING_LOG_COLUMNS} FROM meeting_logs WHERE log_id = ?`)
        .bind(logId)
        .first<MeetingLog>();
    },

    async latest(meetingId, sinceSec = null) {
      return db
        .prepare(
          `SELECT ${MEETING_LOG_COLUMNS} FROM meeting_logs
           WHERE meeting_id = ?1 AND (?2 IS NULL OR CAST(strftime('%s', created_at) AS INTEGER) >= ?2)
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(meetingId, sinceSec)
        .first<MeetingLog>();
    },

    async unfinished(meetingId) {
      // Not done: the same test as meetingLogDone in workflows/meeting-logged.ts.
      return db
        .prepare(
          `SELECT ${MEETING_LOG_COLUMNS} FROM meeting_logs
           WHERE meeting_id = ?
             AND NOT (outcome_at IS NOT NULL
                      AND (calendar_event_id IS NULL OR outcome NOT IN ('RESCHEDULED', 'CANCELED') OR calendar_at IS NOT NULL)
                      AND (next_type IS NULL OR next_task_id IS NOT NULL)
                      AND lead_status_at IS NOT NULL)
           ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
        .bind(meetingId)
        .first<MeetingLog>();
    },

    async calendarEventFor(meetingId) {
      const row = await db
        .prepare(
          `SELECT calendar_event_id AS id FROM meeting_bookings WHERE meeting_id = ? AND calendar_event_id IS NOT NULL
           UNION ALL
           SELECT book_calendar_event_id FROM call_logs WHERE booked_meeting_id = ? AND book_calendar_event_id IS NOT NULL
           LIMIT 1`
        )
        .bind(meetingId, meetingId)
        .first<{ id: string }>();
      return row?.id ?? null;
    },

    async create(row) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO meeting_logs
             (log_id, meeting_id, contact_id, company_id, owner_id, outcome, canceled_by, notes, internal_notes_html,
              new_start, new_end, next_type, next_subject, next_due, next_body, calendar_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.log_id,
          row.meeting_id,
          row.contact_id,
          row.company_id,
          row.owner_id,
          row.outcome,
          row.canceled_by,
          row.notes,
          row.internal_notes_html,
          row.new_start,
          row.new_end,
          row.next_type,
          row.next_subject,
          row.next_due,
          row.next_body,
          row.calendar_event_id
        )
        .run();
    },

    async acquireLock(logId, nowSec, ttlSec) {
      const result = await db
        .prepare(`UPDATE meeting_logs SET lock_until = ? WHERE log_id = ? AND (lock_until IS NULL OR lock_until < ?)`)
        .bind(nowSec + ttlSec, logId, nowSec)
        .run();
      return result.meta.changes === 1;
    },

    async releaseLock(logId) {
      await db.prepare('UPDATE meeting_logs SET lock_until = NULL WHERE log_id = ?').bind(logId).run();
    },

    async markOutcome(logId, at) {
      await db.prepare('UPDATE meeting_logs SET outcome_at = ? WHERE log_id = ?').bind(at, logId).run();
    },

    async markCalendarDone(logId, at) {
      await db.prepare('UPDATE meeting_logs SET calendar_at = ? WHERE log_id = ?').bind(at, logId).run();
    },

    async setNextTask(logId, taskId) {
      await db.prepare('UPDATE meeting_logs SET next_task_id = ? WHERE log_id = ?').bind(taskId, logId).run();
    },

    async markLeadStatusDone(logId, at) {
      await db.prepare('UPDATE meeting_logs SET lead_status_at = ? WHERE log_id = ?').bind(at, logId).run();
    },
  };
}

// --- Meeting bookings (an interview booked from a call task) ---

export interface MeetingBooking {
  booking_id: string;
  task_id: string;
  contact_id: string;
  company_id: string | null;
  owner_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  join_url: string | null;
  phone: string | null; // E.164: a phone interview, the rep calls this number; NULL for video
  invite: number; // 1: send the contact a calendar invite
  invitee_email: string | null;
  calendar_event_id: string | null;
  meeting_id: string | null;
}

export type NewMeetingBooking = Omit<MeetingBooking, 'meeting_id' | 'calendar_event_id'>;

export interface MeetingBookingStore {
  get(bookingId: string): Promise<MeetingBooking | null>;
  // No-op if the row already exists: the first submission's values stick.
  create(row: NewMeetingBooking): Promise<void>;
  acquireLock(bookingId: string, nowSec: number, ttlSec: number): Promise<boolean>;
  releaseLock(bookingId: string): Promise<void>;
  setMeeting(bookingId: string, meetingId: string): Promise<void>;
  // The invite went out; `joinUrl` is the one to put on the meeting.
  setCalendarEvent(bookingId: string, eventId: string, joinUrl: string | null): Promise<void>;
}

const BOOKING_COLUMNS = `booking_id, task_id, contact_id, company_id, owner_id, title, start_at, end_at, join_url,
  phone, invite, invitee_email, calendar_event_id, meeting_id`;

export function d1MeetingBookingStore(db: D1Database): MeetingBookingStore {
  return {
    async get(bookingId) {
      return db
        .prepare(`SELECT ${BOOKING_COLUMNS} FROM meeting_bookings WHERE booking_id = ?`)
        .bind(bookingId)
        .first<MeetingBooking>();
    },

    async create(row) {
      await db
        .prepare(
          `INSERT OR IGNORE INTO meeting_bookings
             (booking_id, task_id, contact_id, company_id, owner_id, title, start_at, end_at, join_url,
              phone, invite, invitee_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          row.booking_id,
          row.task_id,
          row.contact_id,
          row.company_id,
          row.owner_id,
          row.title,
          row.start_at,
          row.end_at,
          row.join_url,
          row.phone,
          row.invite,
          row.invitee_email
        )
        .run();
    },

    async acquireLock(bookingId, nowSec, ttlSec) {
      const result = await db
        .prepare(
          `UPDATE meeting_bookings SET lock_until = ? WHERE booking_id = ? AND (lock_until IS NULL OR lock_until < ?)`
        )
        .bind(nowSec + ttlSec, bookingId, nowSec)
        .run();
      return result.meta.changes === 1;
    },

    async releaseLock(bookingId) {
      await db.prepare('UPDATE meeting_bookings SET lock_until = NULL WHERE booking_id = ?').bind(bookingId).run();
    },

    async setMeeting(bookingId, meetingId) {
      await db
        .prepare('UPDATE meeting_bookings SET meeting_id = ? WHERE booking_id = ?')
        .bind(meetingId, bookingId)
        .run();
    },

    async setCalendarEvent(bookingId, eventId, joinUrl) {
      await db
        .prepare('UPDATE meeting_bookings SET calendar_event_id = ?, join_url = ? WHERE booking_id = ?')
        .bind(eventId, joinUrl, bookingId)
        .run();
    },
  };
}

// --- Coaching (call_insights: what happened on each logged call) ---

export interface CallInsight extends InsightFields {
  call_task_id: string; // the CALL task, or the meeting for an interview (see subject)
  subject: InsightSubject;
  meeting_log_id: string | null; // an interview's: the log it was read with (none yet: null)
  contact_id: string;
  company_id: string | null;
  dial_id: string | null;
  label: string;
  at_sec: number;
  contact_tz: string | null;
  outcome: string;
  duration_sec: number | null;
  prospect_talk_share: number | null;
  rep_questions: number | null;
  you_focus: number | null;
  source: InsightSource;
  rules_version: number;
  unsure: string; // JSON: the tags nothing was sure of (Tag[])
  sources: string; // JSON: tag → { by, p }, who decided each (TagSources)
  // JSON: the call drawn to scale (Timeline, lib/call-timeline.ts); null when
  // there's nothing to draw, or when the query left it out (allCallInsights,
  // callInsightsNear: every call page loads those, and the pages that draw
  // read their few rows with callInsightsFor or get).
  timeline_json: string | null;
  excluded: number; // 1: left out of coaching; only setExcluded changes it
  extracted_at: string;
}

// What a call_insights row reads: a CALL task's logged call, or an
// interview's recorded dial (its meeting id in call_task_id).
export type InsightSubject = 'task' | 'meeting';

const INSIGHT_COLUMNS = [
  'call_task_id',
  'subject',
  'meeting_log_id',
  'contact_id',
  'company_id',
  'dial_id',
  'label',
  'at_sec',
  'contact_tz',
  'outcome',
  'duration_sec',
  'gate',
  'gatekeeper_result',
  'gatekeeper_name',
  'phone_tree_sec',
  'phone_tree_digit',
  'reached',
  'talk_sec',
  'stage',
  'objection',
  'objection_kind',
  'got_past_objection',
  'next_step',
  'next_step_text',
  'opening',
  'gatekeeper_line',
  'what_worked',
  'adjust',
  'asked_last_time',
  'pitched',
  'longest_story_sec',
  'fluff_caught',
  'commitment',
  'prospect_talk_share',
  'rep_questions',
  'you_focus',
  'source',
  'rules_version',
  'unsure',
  'sources',
  'timeline_json',
  'excluded',
  'extracted_at',
] as const satisfies readonly (keyof CallInsight)[];
// Everything a reading writes: whether the call is left out is the rep's.
const WRITTEN_COLUMNS = INSIGHT_COLUMNS.filter((c) => c !== 'excluded');
// The columns for a list every page loads: the timeline (a few KB a call)
// comes back null, the row's shape unchanged.
const LIGHT_COLUMNS = INSIGHT_COLUMNS.map((c) => (c === 'timeline_json' ? 'NULL AS timeline_json' : c));

// A reading by newer rules is never replaced by one by older rules (a run
// from before a deploy that finishes after it), and among the same rules,
// one from a better source never by one from a worse (a read from the notes
// that finishes after the transcript's is dropped).
const sourceRank = (column: string) => `CASE ${column} WHEN 'transcript' THEN 2 WHEN 'notes' THEN 1 ELSE 0 END`;

// The most calls coaching reads at once: years of calls at the rep's pace.
const MAX_INSIGHTS = 5_000;

export interface CallInsightStore {
  get(callTaskId: string): Promise<CallInsight | null>;
  // Writes the call's reading, replacing an earlier one by older rules, by
  // the same rules from the same or a worse source (the transcript, then the
  // notes, then the outcome), or of another dial (an interview dialled
  // again). Leaves `excluded` as it was, unless the dial changed: a new
  // call starts in.
  save(row: CallInsight): Promise<void>;
  // When the call was logged (epoch seconds): when it was made, for a call
  // not dialled from the app.
  loggedAt(callTaskId: string): Promise<number | null>;
  // Calls to read: logged calls (by CALL task) and interviews' calls (by
  // meeting, once the call ended) never read, read by rules older than
  // `rulesVersion`, read from the notes before their transcript arrived, or
  // reviewed since they were read.
  // Newest first; WhatsApp messages aren't calls, and left-out calls stay out.
  // `dialsEndedBySec`: an interview's dial started before this with no final
  // status counts as ended (its webhooks were lost: dialState's timeout).
  needing(
    limit: number,
    rulesVersion: number,
    dialsEndedBySec?: number
  ): Promise<{ id: string; subject: InsightSubject }[]>;
  // Leaves the call out of coaching, or puts it back. False when it hasn't
  // been read yet (read it, then try again).
  setExcluded(callTaskId: string, excluded: boolean): Promise<boolean>;
}

export function d1CallInsightStore(db: D1Database): CallInsightStore {
  return {
    async get(callTaskId) {
      return db
        .prepare(`SELECT ${INSIGHT_COLUMNS.join(', ')} FROM call_insights WHERE call_task_id = ?`)
        .bind(callTaskId)
        .first<CallInsight>();
    },

    async save(row) {
      const updates = WRITTEN_COLUMNS.filter((c) => c !== 'call_task_id').map((c) => `${c} = excluded.${c}`);
      // Whether the call is left out is the rep's, and stays through a reread
      // of the same call; a new call (an interview dialled again) starts in.
      updates.push(
        'excluded = CASE WHEN excluded.dial_id IS NOT call_insights.dial_id THEN 0 ELSE call_insights.excluded END'
      );
      await db
        .prepare(
          `INSERT INTO call_insights (${WRITTEN_COLUMNS.join(', ')})
           VALUES (${WRITTEN_COLUMNS.map(() => '?').join(', ')})
           ON CONFLICT(call_task_id) DO UPDATE SET ${updates.join(', ')}
           WHERE excluded.rules_version > call_insights.rules_version
              -- An interview dialled again: a new call, whatever it was read from.
              OR excluded.dial_id IS NOT call_insights.dial_id
              OR (excluded.rules_version = call_insights.rules_version
                  AND ${sourceRank('excluded.source')} >= ${sourceRank('call_insights.source')})`
        )
        .bind(...WRITTEN_COLUMNS.map((c) => row[c]))
        .run();
    },

    async loggedAt(callTaskId) {
      const row = await db
        .prepare(`SELECT created_at FROM call_logs WHERE call_task_id = ?`)
        .bind(callTaskId)
        .first<{ created_at: string }>();
      const ms = sqliteTime(row?.created_at ?? null);
      return ms === null ? null : Math.floor(ms / 1000);
    },

    async needing(limit, rulesVersion, dialsEndedBySec = 0) {
      // Why a read row wants reading again, for either kind.
      const stale = (id: string) => `
             (i.excluded = 0 AND i.rules_version < ?1)
             -- A review saved after its last read (a read that failed after review_call).
             OR (i.excluded = 0 AND EXISTS (SELECT 1 FROM call_reviews r
                 WHERE r.call_task_id = ${id} AND r.reviewed_at > i.extracted_at
                   AND (r.dial_id IS NULL OR r.dial_id IS i.dial_id)))
             -- A silent recording's transcript is done with no turns: nothing to read again.
             OR (i.excluded = 0 AND i.source != 'transcript' AND d.transcript_status = 'done'
                 AND json_array_length(d.transcript_json) > 0)`;
      const { results } = await db
        .prepare(
          `SELECT id, subject FROM (
             SELECT l.call_task_id AS id, 'task' AS subject, CAST(strftime('%s', l.created_at) AS INTEGER) AS at
             FROM call_logs l
             LEFT JOIN call_insights i ON i.call_task_id = l.call_task_id AND i.subject = 'task'
             LEFT JOIN dials d ON d.id = l.dial_id
             WHERE l.channel != 'whatsapp_message' AND (i.call_task_id IS NULL OR ${stale('l.call_task_id')})
             UNION ALL
             -- An interview's latest call from its page, once it ended.
             SELECT d.task_id AS id, 'meeting' AS subject, d.started_sec AS at
             FROM dials d
             LEFT JOIN call_insights i ON i.call_task_id = d.task_id AND i.subject = 'meeting'
             WHERE d.subject = 'meeting'
               AND (d.rep_status IS NOT NULL OR d.prospect_status IS NOT NULL OR d.started_sec < ?3)
               -- The latest dial, as latestForTask picks it.
               AND d.id = (SELECT d2.id FROM dials d2 WHERE d2.task_id = d.task_id AND d2.subject = 'meeting'
                           ORDER BY d2.started_sec DESC, d2.rowid DESC LIMIT 1)
               -- Read of an earlier dial, or with an earlier log (or none) of this call: read again.
               -- A log from before the dial is an earlier occurrence's (moved since), not this call's.
               AND (i.call_task_id IS NULL OR i.dial_id IS NOT d.id
                    OR (i.excluded = 0 AND i.meeting_log_id IS NOT
                        (SELECT m.log_id FROM meeting_logs m WHERE m.meeting_id = d.task_id
                           AND CAST(strftime('%s', m.created_at) AS INTEGER) >= d.started_sec
                         ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1))
                    OR ${stale('d.task_id')})
           )
           ORDER BY at DESC LIMIT ?2`
        )
        .bind(rulesVersion, limit, dialsEndedBySec)
        .all<{ id: string; subject: InsightSubject }>();
      return results.map((r) => ({ id: r.id, subject: r.subject }));
    },

    async setExcluded(callTaskId, excluded) {
      const result = await db
        .prepare(`UPDATE call_insights SET excluded = ? WHERE call_task_id = ?`)
        .bind(excluded ? 1 : 0, callTaskId)
        .run();
      return result.meta.changes === 1;
    },
  };
}

// Every read call coaching counts, oldest first, for the coaching report
// (without the timelines: callInsightsFor has them): the calls from CALL
// tasks, or the interviews' calls.
export async function allCallInsights(db: D1Database, subject: InsightSubject = 'task'): Promise<CallInsight[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (SELECT ${LIGHT_COLUMNS.join(', ')} FROM call_insights WHERE excluded = 0 AND subject = ?1
                      ORDER BY at_sec DESC LIMIT ?2)
       ORDER BY at_sec`
    )
    .bind(subject, MAX_INSIGHTS)
    .all<CallInsight>();
  return results;
}

// The calls to this contact and to others at their company, newest first,
// for the coaching before a call (without the timelines).
export async function callInsightsNear(
  db: D1Database,
  contactId: string,
  companyId: string | null
): Promise<CallInsight[]> {
  const { results } = await db
    .prepare(
      `SELECT ${LIGHT_COLUMNS.join(', ')} FROM call_insights
       WHERE excluded = 0 AND subject = 'task' AND (contact_id = ?1 OR (?2 IS NOT NULL AND company_id = ?2))
       ORDER BY at_sec DESC LIMIT 50`
    )
    .bind(contactId, companyId)
    .all<CallInsight>();
  return results;
}

// The readings of these calls, left-out ones included, for the Calls page.
export async function callInsightsFor(db: D1Database, callTaskIds: string[]): Promise<Map<string, CallInsight>> {
  if (!callTaskIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT ${INSIGHT_COLUMNS.join(', ')} FROM call_insights
       WHERE call_task_id IN (SELECT value FROM json_each(?))`
    )
    .bind(JSON.stringify(callTaskIds))
    .all<CallInsight>();
  return new Map(results.map((r) => [r.call_task_id, r]));
}

// --- Reviews of a call (call_reviews): the rep's, or Claude's through the connector ---

export interface CallReviewStore {
  // The call's reviews, at most one per reviewer: those of this dial (an
  // interview dialled again is a new call), and those of no dial in particular.
  list(callTaskId: string, dialId?: string | null): Promise<CallReview[]>;
  // Writes the reviewer's review of the call under the current review rules
  // (REVIEW_RULES_VERSION). It replaces their earlier one whole, unless that
  // one was under older rules: a reviewer asked again only for what's new
  // answers only that, so its corrections go over the earlier ones.
  save(callTaskId: string, review: CallReview): Promise<void>;
}

export function d1CallReviewStore(db: D1Database): CallReviewStore {
  return {
    async list(callTaskId, dialId) {
      const { results } = await db
        .prepare(
          `SELECT reviewer, corrections, what_worked, adjust, reviewed_at, dial_id FROM call_reviews
           WHERE call_task_id = ?1 AND (?2 IS NULL OR dial_id IS NULL OR dial_id = ?2) ORDER BY reviewer`
        )
        .bind(callTaskId, dialId ?? null)
        .all<{
          reviewer: Reviewer;
          corrections: string;
          what_worked: string | null;
          adjust: string | null;
          reviewed_at: string;
          dial_id: string | null;
        }>();
      return results.map((r) => ({ ...r, corrections: parseCorrections(r.corrections) }));
    },

    async save(callTaskId, review) {
      const dialId = review.dial_id ?? null;
      const earlier = await db
        .prepare(`SELECT corrections, rules_version, dial_id FROM call_reviews WHERE call_task_id = ? AND reviewer = ?`)
        .bind(callTaskId, review.reviewer)
        .first<{ corrections: string; rules_version: number; dial_id: string | null }>();
      // An earlier review under older rules, of this same call, is added to.
      const corrections =
        earlier &&
        earlier.rules_version < REVIEW_RULES_VERSION &&
        (earlier.dial_id === null || earlier.dial_id === dialId)
          ? { ...parseCorrections(earlier.corrections), ...review.corrections }
          : review.corrections;
      await db
        .prepare(
          `INSERT INTO call_reviews (call_task_id, reviewer, corrections, what_worked, adjust, reviewed_at, rules_version, dial_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(call_task_id, reviewer) DO UPDATE SET corrections = excluded.corrections,
             what_worked = excluded.what_worked, adjust = excluded.adjust, reviewed_at = excluded.reviewed_at,
             rules_version = excluded.rules_version, dial_id = excluded.dial_id`
        )
        .bind(
          callTaskId,
          review.reviewer,
          JSON.stringify(corrections),
          review.what_worked,
          review.adjust,
          review.reviewed_at,
          REVIEW_RULES_VERSION,
          dialId
        )
        .run();
    },
  };
}

// Calls worth a review, newest first: someone picked up (them or the front
// desk), coaching counts it, and nobody has reviewed it under the current
// review rules yet (a review under older rules couldn't answer the new tags).
export async function callsToReview(db: D1Database, limit: number): Promise<CallInsight[]> {
  const { results } = await db
    .prepare(
      `SELECT ${INSIGHT_COLUMNS.map((c) => `i.${c}`).join(', ')} FROM call_insights i
       WHERE i.excluded = 0 AND i.gate IN ('owner', 'gatekeeper')
         AND NOT EXISTS (SELECT 1 FROM call_reviews r
                         WHERE r.call_task_id = i.call_task_id AND r.rules_version >= ?1
                           AND (r.dial_id IS NULL OR r.dial_id IS i.dial_id))
       ORDER BY i.at_sec DESC LIMIT ?2`
    )
    .bind(REVIEW_RULES_VERSION, limit)
    .all<CallInsight>();
  return results;
}

// --- What they've told the rep (coaching's What you've heard) ---

export interface HeardRow {
  call_task_id: string;
  subject: InsightSubject;
  label: string;
  at_sec: number;
  transcript_json: string | null; // the dial's finished transcript, if any
  notes: string; // the rep's notes on the call, or the interview's latest log
}

// Every call and interview that reached them, newest first, with its
// transcript and the rep's notes: what there is to hear them in.
export async function heardSources(db: D1Database, limit = 500): Promise<HeardRow[]> {
  const { results } = await db
    .prepare(
      `SELECT i.call_task_id, i.subject, i.label, i.at_sec,
              CASE WHEN d.transcript_status = 'done' THEN d.transcript_json END AS transcript_json,
              COALESCE(CASE WHEN i.subject = 'task' THEN l.notes
                            ELSE (SELECT m.notes FROM meeting_logs m WHERE m.meeting_id = i.call_task_id
                                  ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) END, '') AS notes
       FROM call_insights i
       LEFT JOIN dials d ON d.id = i.dial_id
       LEFT JOIN call_logs l ON i.subject = 'task' AND l.call_task_id = i.call_task_id
       WHERE i.excluded = 0 AND i.reached = 1
       ORDER BY i.at_sec DESC LIMIT ?`
    )
    .bind(limit)
    .all<HeardRow>();
  return results;
}

// --- Interviews booked from calls, and how each turned out (coaching) ---

export interface BookedInterview {
  meeting_id: string;
  call_task_id: string; // the CALL task that booked it
  contact_id: string;
  label: string; // who it's with: the call's label, else the interview's title
  booked_sec: number; // when it was booked
  first_start: string; // ISO: the time it was booked for
  start: string; // ISO: its time now, after any move
  invite: number; // 1: the contact got a calendar invite
  by_phone: number; // 1: a phone interview; 0: video
  outcome: MeetingLog['outcome'] | null; // the last one the rep logged; NULL: none yet
  canceled_by: CanceledBy | null; // with CANCELED: who called it off (NULL: logged before it was asked)
  moves: number; // times the rep logged it as moved
  call_sec: number | null; // how long they talked on the call that booked it, once that call is read
}

// Every interview booked from a call task (while logging the call, or on its
// own), oldest first, with the outcome the rep last logged for it on
// Interviews; with `contactId`, only theirs. A meeting booked twice (a retry)
// counts once, from its first booking; one from a call left out of coaching
// stays out. The newest MAX_INSIGHTS, like allCallInsights.
export async function allBookedInterviews(db: D1Database, contactId: string | null = null): Promise<BookedInterview[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
       WITH booked AS (
         SELECT booked_meeting_id AS meeting_id, call_task_id AS task_id, contact_id, title, created_at,
                book_start AS start_at, book_invite AS invite, book_phone AS phone
         FROM call_logs WHERE booked_meeting_id IS NOT NULL
         UNION ALL
         SELECT meeting_id, task_id, contact_id, title, created_at, start_at, invite, phone
         FROM meeting_bookings WHERE meeting_id IS NOT NULL
       ),
       firsts AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY meeting_id ORDER BY created_at) AS n FROM booked
       )
       SELECT f.meeting_id, f.task_id AS call_task_id, f.contact_id, COALESCE(i.label, f.title) AS label,
              CAST(strftime('%s', f.created_at) AS INTEGER) AS booked_sec, f.start_at AS first_start,
              COALESCE((SELECT m.new_start FROM meeting_logs m
                        WHERE m.meeting_id = f.meeting_id AND m.outcome = 'RESCHEDULED' AND m.new_start IS NOT NULL
                        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1), f.start_at) AS start,
              f.invite, CASE WHEN f.phone IS NULL THEN 0 ELSE 1 END AS by_phone,
              l.outcome, l.canceled_by,
              (SELECT COUNT(*) FROM meeting_logs m WHERE m.meeting_id = f.meeting_id AND m.outcome = 'RESCHEDULED') AS moves,
              CASE WHEN i.reached = 1 THEN COALESCE(i.talk_sec, i.duration_sec) END AS call_sec
       FROM firsts f
       LEFT JOIN call_insights i ON i.call_task_id = f.task_id
       LEFT JOIN meeting_logs l ON l.rowid = (SELECT m.rowid FROM meeting_logs m WHERE m.meeting_id = f.meeting_id
                                             ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)
       WHERE f.n = 1 AND COALESCE(i.excluded, 0) = 0 AND (?1 IS NULL OR f.contact_id = ?1)
       ORDER BY f.created_at DESC, f.meeting_id DESC LIMIT ?2)
       ORDER BY booked_sec, meeting_id`
    )
    .bind(contactId, MAX_INSIGHTS)
    .all<BookedInterview>();
  return results;
}
