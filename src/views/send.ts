import { html } from 'hono/html';
import { previewDocument } from '../lib/compose';
import type { SentEmail } from '../lib/db';
import { companyName, contactName } from '../workflows/parties';
import type { OutgoingEmail } from '../workflows/send-email';
import { flash, layout, steps, type Html } from './layout';

export interface SendPageState {
  email: OutgoingEmail;
  fromEmail: string | null; // null: no Gmail connected yet
  fromName: string;
  hasSignature: boolean;
  warnings: string[];
  notes: string[]; // "[Note: …]" left in the body, which the prospect would see
  trackOpens: boolean;
  trackClicks: boolean;
  notice: string | null; // about the email just sent, when the rep came here from it
}

export function trackingNote(opens: boolean, clicks: boolean): string {
  if (opens && clicks)
    return 'When sent, an invisible tracking image is added and links go through the app to count clicks. Nothing visible changes.';
  if (opens) return 'When sent, an invisible tracking image is added. Links are left as they are.';
  if (clicks) return 'When sent, links go through the app to count clicks. No tracking image is added.';
  return 'Tracking is off: this is sent exactly as shown.';
}

export function sendPage(state: SendPageState, actor: string): Html {
  const { email } = state;
  const taskId = email.task.id;
  const to = email.toName ? `${email.toName} <${email.toEmail}>` : email.toEmail;
  const ready = Boolean(state.fromEmail);
  const company = companyName(email.company);
  const contact = contactName(email.contact);

  return layout(
    `Send · ${company ?? contact}`,
    actor,
    html`
      <div class="row">
        <a href="/tasks/${taskId}/draft">← Back to the draft</a>
        ${steps('send')}
      </div>
      ${state.notice ? flash('ok', state.notice) : ''}
      <div class="tight">
        <h1>Preview &amp; send</h1>
        <p class="muted">${company ?? 'No company'} · ${contact} · Task ${taskId}</p>
      </div>

      ${!ready ? flash('warn', html`No Gmail account connected. <a href="/settings">Connect one in Settings</a> first.`) : ''}
      ${!state.hasSignature ? flash('warn', html`No signature set. <a href="/settings">Add it in Settings</a> or this goes out without one.`) : ''}
      ${
        state.notes.length
          ? flash(
              'err',
              html`The email still has a note to yourself in it, and the prospect would see it:
                ${state.notes.map((note) => html`<q>${note}</q> `)}<a href="/tasks/${taskId}/draft">Edit the draft</a> to remove it.`
            )
          : ''
      }
      ${
        state.warnings.length
          ? flash(
              'warn',
              html`Voice check: ${state.warnings.join(' ')} <a href="/tasks/${taskId}/draft">Edit the draft</a> or send it as it is.`
            )
          : ''
      }

      <div class="with-aside">
        <div class="card">
          <dl class="headers">
            <dt>From</dt><dd>${state.fromName} &lt;${state.fromEmail ?? 'not connected'}&gt;</dd>
            <dt>To</dt><dd>${to}</dd>
            <dt>Subject</dt><dd><strong>${email.composed.subject}</strong></dd>
          </dl>
          <iframe class="email-preview" sandbox srcdoc="${previewDocument(email.composed.html)}" title="Email preview"></iframe>
          <p class="muted">This is exactly what the recipient sees.</p>
        </div>

        <form class="card" method="post" action="/tasks/${taskId}/send" onsubmit="return confirm(this.dataset.confirm)" data-confirm="Send this email to ${email.toEmail} now?">
          <h2>When you send</h2>
          <ol class="consequences">
            <li>Gmail sends it from ${state.fromEmail ?? 'your connected account'}.</li>
            <li>The HubSpot task is marked completed.</li>
            <li>A follow-up call task is created for tomorrow.</li>
          </ol>
          <p class="muted">HubSpot logs the email on the contact from your connected inbox within about a minute.</p>
          <p class="muted">${trackingNote(state.trackOpens, state.trackClicks)} <a href="/settings">Change tracking</a></p>
          <button type="submit" class="primary wide" ${ready ? '' : 'disabled'}>Send from Gmail</button>
          <p class="muted">${ready ? 'You confirm once more before it goes. The app never sends the same email twice.' : 'Connect Gmail in Settings first.'}</p>
        </form>
      </div>
    `
  );
}

export function unknownSendPage(taskId: string, subject: string | null, toEmail: string | null, actor: string): Html {
  return layout(
    'Check Gmail',
    actor,
    html`
      <p><a href="/">← Queue</a></p>
      <h1>Did this email go out?</h1>
      ${flash(
        'warn',
        "A send started for this task but never confirmed, so the app can't tell whether Gmail sent it. It won't guess, because guessing wrong means a prospect gets the email twice."
      )}
      <div class="card">
        <p>Open the <strong>Sent</strong> folder in Gmail and look for:</p>
        <dl class="headers">
          <dt>To</dt><dd>${toEmail ?? 'unknown'}</dd>
          <dt>Subject</dt><dd>${subject ?? 'unknown'}</dd>
        </dl>
        <div class="grid-2 divided">
          <form method="post" action="/tasks/${taskId}/send/resolve" class="tight">
            <input type="hidden" name="went_out" value="1" />
            <div><button type="submit" class="primary">It's in Sent: continue</button></div>
            <p class="muted">Completes the task and creates tomorrow's call. Nothing is sent.</p>
          </form>
          <form method="post" action="/tasks/${taskId}/send/resolve" class="tight">
            <input type="hidden" name="went_out" value="0" />
            <div><button type="submit">It's not there: let me send again</button></div>
            <p class="muted">Takes you back to Preview &amp; send. Check Sent first: this is the only way a prospect gets it twice.</p>
          </form>
        </div>
      </div>
    `
  );
}

export function alreadySentPage(taskId: string, sent: SentEmail, followUpDone: boolean, actor: string): Html {
  return layout(
    'Already sent',
    actor,
    html`
      <p><a href="/">← Queue</a></p>
      <h1>This email was already sent</h1>
      ${
        followUpDone
          ? ''
          : flash(
              'warn',
              "The email went out, but the follow-up didn't finish: the task isn't completed or the call task wasn't created (HubSpot may have failed)."
            )
      }
      <div class="card">
        <dl class="headers">
          <dt>To</dt><dd>${sent.to_email}</dd>
          <dt>Subject</dt><dd>${sent.subject}</dd>
          <dt>Sent</dt><dd>${sent.sent_at?.slice(0, 16).replace('T', ' ') ?? "yes (confirmed from Gmail's Sent folder)"}</dd>
        </dl>
        ${
          followUpDone
            ? html`<p class="muted">The task is completed and the follow-up call is scheduled. Nothing left to do.</p>`
            : html`<form method="post" action="/tasks/${taskId}/send" class="actions divided">
              <button type="submit" class="primary">Finish the follow-up</button>
              <span class="muted">Completes the task and creates tomorrow's call. The email is not sent again.</span>
            </form>`
        }
      </div>
    `
  );
}
