import { html, raw } from 'hono/html';
import { formatLocal } from '../lib/dates';
import { sqliteTime, type RecentSend, type SentLogRow } from '../lib/db';
import { heat } from '../lib/sent-rank';
import type { EmailQueue, QueueRow } from '../workflows/email-queue';
import type { RecordNames } from '../workflows/records';
import { OUTCOME_LABELS } from './calls';
import type { TodayCounts } from '../workflows/today';
import { flash as flashBox, layout, queueTabs, todayStrip, type Html } from './layout';

export interface QueueFlash {
  sentTaskId: string;
  // The follow-up, when it was created before the page answered. Null while
  // it's still being created (saving).
  followUp: { callTaskId: string; created: boolean } | null;
  viaGmail: boolean; // sent by the app, logged on the contact
}

// For emails sent by hand from HubSpot's own compose window.
function sentButton(row: QueueRow): Html {
  const confirmText = `Confirm the email for "${row.subject}" was already sent from HubSpot? This completes the task and creates a follow-up call for tomorrow.`;
  return html`<form method="post" action="/tasks/${row.taskId}/sent" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${confirmText}">
    <button type="submit" class="quiet">Mark sent</button>
  </form>`;
}

// For a task that won't be sent. The confirm names what happens in HubSpot.
// `data-inline-drop`: the page's script drops it in place (DROP_SCRIPT).
function dropButton(row: QueueRow): Html {
  const confirmText = `Drop "${row.subject}"? The task is marked Deferred in HubSpot and leaves the queue. No follow-up is created.`;
  return html`<form method="post" action="/tasks/${row.taskId}/drop" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${confirmText}" data-inline-drop>
    <button type="submit" class="quiet">Drop</button>
  </form>`;
}

// The notice after a drop: on the queue the redirect lands on, and alone as
// the answer to the page's script.
export function droppedFlash(taskId: string): Html {
  return flashBox('ok', html`Task ${taskId} dropped: it's marked Deferred in HubSpot.`);
}

// Drop without leaving the page: one request, then the row goes and the
// counts above it drop by one, instead of a redirect that reads the whole
// queue from HubSpot again. The confirm (the form's onsubmit) runs first.
// Dropping the Next up task, or a table's last row, reloads the queue: what's
// next is the server's to rank. A failure shows the error page's message;
// a request that never got an answer submits the form as usual (a drop is
// safe to repeat).
const DROP_SCRIPT = `
document.addEventListener('submit', async (event) => {
  const form = event.target;
  if (!form.matches('form[data-inline-drop]') || event.defaultPrevented) return;
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  let res;
  try {
    res = await fetch(form.action, { method: 'POST', headers: { 'X-Fragment': '1' } });
  } catch {
    form.submit();
    return;
  }
  const body = await res.text();
  const notice = document.getElementById('drop-flash');
  if (!res.ok) {
    const err = new DOMParser().parseFromString(body, 'text/html').querySelector('.flash.err');
    notice.replaceChildren(...(err ? [err] : []));
    button.disabled = false;
    notice.scrollIntoView({ block: 'nearest' });
    return;
  }
  const row = form.closest('tr');
  const taskId = row.dataset.task;
  if (document.querySelector('[data-next-up="' + taskId + '"]') || row.parentElement.children.length === 1) {
    location.assign('/?dropped=' + encodeURIComponent(taskId));
    return;
  }
  notice.innerHTML = body;
  for (const name of row.dataset.counts.split(' ')) {
    for (const count of document.querySelectorAll('[data-count="' + name + '"]')) {
      count.textContent = Math.max(0, Number(count.textContent) - 1);
    }
  }
  row.remove();
});`;

// "off" when that kind of tracking wasn't in the email: a 0 would read as
// "nobody opened it" when the app simply couldn't know.
function trackedCount(tracked: number | null, count: number): Html {
  return tracked === 0 ? html`<span class="muted" title="Tracking was off for this email">off</span>` : html`${count}`;
}

// The count, and when the last open was.
function openCount(s: RecentSend, timeZone: string): Html {
  const last = s.track_opens === 0 ? null : sqliteTime(s.last_open_at);
  return last === null
    ? trackedCount(s.track_opens, s.opens)
    : html`${s.opens} <span class="muted">· last ${formatLocal(last, timeZone)}</span>`;
}

function party(row: QueueRow): Html {
  return html`<div class="tight">
    <span><strong>${row.companyName ?? html`<span class="muted">no company</span>`}</strong> ·
      ${row.contactName ?? html`<span class="muted">no contact</span>`}${row.warm ? html` <span class="fit">Follow-up</span>` : ''}</span>
    <span class="muted">${row.subject}</span>
  </div>`;
}

// The counts on the page a row is part of (data-count), for DROP_SCRIPT.
function counts(row: QueueRow, kind: 'ready' | 'draft'): string {
  return `all ${kind}${row.fit === 'DROP' ? ' flagged' : ''}`;
}

function readyRow(row: QueueRow): Html {
  return html`<tr class="${row.fit === 'DROP' ? 'drop' : ''}" data-task="${row.taskId}" data-counts="${counts(row, 'ready')}">
    <td class="fit-cell"><span class="fit">${row.fit}</span></td>
    <td>${party(row)}</td>
    <td class="row-actions">
      <div class="actions">
        <a class="button" href="/tasks/${row.taskId}/send">Preview &amp; send</a>
        <a class="button" href="/tasks/${row.taskId}/draft" data-prefetch-hover>Edit draft</a>
        ${sentButton(row)}
        ${dropButton(row)}
      </div>
    </td>
  </tr>`;
}

function toDraftRow(row: QueueRow): Html {
  return html`<tr class="${row.fit === 'DROP' ? 'drop' : ''}" data-task="${row.taskId}" data-counts="${counts(row, 'draft')}">
    <td class="fit-cell"><span class="fit">${row.fit}</span></td>
    <td>${party(row)}</td>
    <td class="row-actions">
      <div class="actions">
        <a class="button" href="/tasks/${row.taskId}/draft" data-prefetch-hover>Draft</a>
        ${sentButton(row)}
        ${dropButton(row)}
      </div>
    </td>
  </tr>`;
}

function taskTable(rows: QueueRow[], render: (row: QueueRow) => Html): Html {
  return html`<table class="stacked">
    <thead><tr><th>Fit</th><th>Company · contact · task</th><th></th></tr></thead>
    <tbody>${rows.map(render)}</tbody>
  </table>`;
}

function nextUpCard(queue: EmailQueue): Html {
  const { nextUp } = queue;
  if (!nextUp) return html`<p class="muted">Nothing to suggest. Every open email task is drop-flagged.</p>`;
  const { item } = nextUp;
  return html`<div class="card split next-up" data-next-up="${item.taskId}">
    <div class="tight">
      <p><span class="fit">${item.fit}</span></p>
      <p class="next-company">${item.companyName ?? 'No company'}</p>
      <p>${item.contactName ?? 'No contact'} · <span class="muted">${item.subject}</span></p>
      <p class="muted">
        ${
          item.warm
            ? nextUp.step === 'draft'
              ? 'A follow-up to someone you’ve talked to, due now. Drafting saves to the HubSpot task. Nothing is sent from the draft page.'
              : 'A follow-up to someone you’ve talked to, due now, and its draft is ready. Read it over and send.'
            : nextUp.step === 'draft'
              ? 'Best fit with no draft yet. Drafting saves to the HubSpot task. Nothing is sent from the draft page.'
              : 'Every open email task worth sending is drafted. This is the best one to send next.'
        }
      </p>
    </div>
    <div class="actions">
      ${
        nextUp.step === 'draft'
          ? html`<a class="button primary" href="/tasks/${item.taskId}/draft" data-prefetch>Approve &amp; draft</a>`
          : html`<a class="button primary" href="/tasks/${item.taskId}/send">Preview &amp; send</a>
            <a class="button" href="/tasks/${item.taskId}/draft" data-prefetch-hover>Edit draft</a>`
      }
    </div>
  </div>`;
}

// Who it went to: the contact and company, each linked to their page, with
// the address underneath. Without names (HubSpot's read failed), the address
// links to the contact.
function recipient(s: SentLogRow, names: RecordNames): Html {
  const contact = names.contacts.get(s.contact_id);
  const company = s.company_id ? names.companies.get(s.company_id) : undefined;
  const heatBadge =
    heat(s) === 'clicked'
      ? html` <span class="fit clicked" title="Clicked a link and not called since">Clicked</span>`
      : heat(s) === 'opened'
        ? html` <span class="fit opened" title="Opened and not called since. Approximate: some mail apps load images on their own.">Opened</span>`
        : '';
  return html`<div class="tight">
    <span>
      <strong><a href="/contacts/${s.contact_id}" data-prefetch-hover>${contact ?? s.to_email}</a></strong>${
        company && s.company_id ? html` · <a href="/companies/${s.company_id}" data-prefetch-hover>${company}</a>` : ''
      }${heatBadge}
    </span>
    ${contact ? html`<span class="muted">${s.to_email}</span>` : ''}
    <span class="muted">${s.subject}</span>
  </div>`;
}

// The next step with them: the follow-up call the send created, or how the
// last call since went (and the call it set up), or, when the app doesn't
// know the task, the contact's open call task (created if there's none).
function nextStep(s: SentLogRow, timeZone: string): Html {
  if (s.status !== 'sent') return html``;
  const primary = heat(s) ? 'button primary' : 'button';
  const callLink = (taskId: string, label: string) =>
    html`<a class="${primary}" href="/calls/${taskId}" data-prefetch-hover>${label}</a>`;
  if (s.called_at) {
    const when = sqliteTime(s.called_at);
    return html`<div class="actions">
      <div class="tight muted nowrap">
        <span>Called · ${OUTCOME_LABELS[s.called_outcome ?? ''] ?? s.called_outcome}</span>
        ${when === null ? '' : html`<span>${formatLocal(when, timeZone)}</span>`}
      </div>
      ${s.next_call_task_id ? callLink(s.next_call_task_id, 'Call again') : ''}
    </div>`;
  }
  if (s.call_task_id) return html`<div class="actions">${callLink(s.call_task_id, 'Call')}</div>`;
  return html`<div class="actions">
    <form method="post" action="/contacts/${s.contact_id}/call">
      ${s.company_id ? html`<input type="hidden" name="company_id" value="${s.company_id}" />` : ''}
      <button type="submit" class="${heat(s) ? 'primary' : ''}">Call</button>
    </form>
  </div>`;
}

function recentSendsSection(sends: SentLogRow[], names: RecordNames, timeZone: string): Html {
  if (!sends.length) return html``;
  const hot = sends.filter((s) => heat(s)).length;
  return html`<section>
    <div class="row">
      <h2>Sent from this app</h2>
      <p class="muted">
        ${hot ? `${hot} opened or clicked and not called yet, on top. ` : ''}Clicks are reliable. Opens are approximate. "off" means that tracking wasn't in the email.
      </p>
    </div>
    <table class="stacked">
      <thead><tr><th>Sent</th><th>To</th><th>Opens</th><th>Clicks</th><th></th></tr></thead>
      <tbody>
        ${sends.map(
          (s) => html`<tr>
            <td class="nowrap">${s.status === 'sent' ? (s.sent_at?.slice(0, 16).replace('T', ' ') ?? '') : html`<a href="/tasks/${s.email_task_id}/send">${s.status}</a>`}</td>
            <td>${recipient(s, names)}</td>
            <td data-label="Opens">${openCount(s, timeZone)}</td>
            <td data-label="Clicks">${trackedCount(s.track_clicks, s.clicks)}</td>
            <td class="row-actions">${nextStep(s, timeZone)}</td>
          </tr>`
        )}
      </tbody>
    </table>
    <p class="muted">Opens in the first minute (usually your own Sent folder) are ignored.</p>
  </section>`;
}

export function queuePage(
  queue: EmailQueue,
  sends: SentLogRow[], // ranked (lib/sent-rank.ts)
  names: RecordNames,
  flash: QueueFlash | null,
  droppedTaskId: string | null,
  today: TodayCounts,
  waiting: number, // callers waiting on a call back, for the Calls to make tab
  timeZone: string,
  actor: string
): Html {
  const ready = queue.rows.filter((r) => r.hasDraft);
  const toDraft = queue.rows.filter((r) => !r.hasDraft);
  const dropped = queue.rows.filter((r) => r.fit === 'DROP').length;
  return layout(
    'Emails to send',
    actor,
    html`
      ${queueTabs('emails', waiting)}
      ${
        flash
          ? flashBox(
              'ok',
              html`${flash.viaGmail ? html`Email sent from Gmail.` : html`Task ${flash.sentTaskId} marked sent.`}
              ${
                flash.followUp === null
                  ? html`The task is completed and tomorrow's follow-up call task created in HubSpot in a few seconds. If anything fails, a notice at the top of the page says so.`
                  : flash.followUp.created
                    ? html`Task completed and follow-up call task ${flash.followUp.callTaskId} created for tomorrow.`
                    : html`Task completed. Follow-up call task ${flash.followUp.callTaskId} already existed, so no new one was created.`
              }`
            )
          : ''
      }
      <div id="drop-flash">${droppedTaskId ? droppedFlash(droppedTaskId) : ''}</div>
      ${queue.truncated ? flashBox('warn', 'Showing the oldest 1,000 open email tasks only.') : ''}
      ${todayStrip(today)}

      <div class="row">
        <h1>${queue.nextUp?.step === 'send' ? 'Next to send' : 'Next up'}</h1>
        <p class="muted">
          <span data-count="all">${queue.rows.length}</span> open email tasks · <span data-count="ready">${ready.length}</span> ready to send ·
          <span data-count="draft">${toDraft.length}</span> to draft${dropped ? html` · <span data-count="flagged">${dropped}</span> drop-flagged` : ''}
        </p>
      </div>
      ${nextUpCard(queue)}

      ${
        ready.length
          ? html`<section>
            <div class="row">
              <h2>Ready to send (<span data-count="ready">${ready.length}</span>)</h2>
              <p class="muted">Drafted and saved. Preview shows the exact email before anything goes out.</p>
            </div>
            ${taskTable(ready, readyRow)}
          </section>`
          : ''
      }

      <section>
        <div class="row">
          <h2>To draft (<span data-count="draft">${toDraft.length}</span>)</h2>
          <p class="muted">Ranked by the fit label in each company's description: STRONG, GOOD, weaker, unlabelled, then drop-flagged.</p>
        </div>
        ${
          toDraft.length
            ? taskTable(toDraft, toDraftRow)
            : html`<p class="muted">${queue.rows.length ? 'Every open email task has a draft.' : 'No open email tasks in HubSpot.'}</p>`
        }
        <p class="muted">Mark sent is for an email you already sent from HubSpot yourself: it completes the task and creates tomorrow's call. Drop is for one you won't send: the task is marked Deferred and no call is created. You confirm both first.</p>
      </section>

      ${recentSendsSection(sends, names, timeZone)}
      <script>${raw(DROP_SCRIPT)}</script>
    `,
    'queue'
  );
}
