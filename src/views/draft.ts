import { html } from 'hono/html';
import { composeEmail, previewDocument } from '../lib/compose';
import { parseFitLabel } from '../lib/fit';
import { companyName, contactName } from '../workflows/parties';
import { trackingNote } from './send';
import type { ClaudeDraftAudit } from '../routes/draft';
import type { DraftContext } from '../workflows/draft-email';
import { isTemplatedFollowUp } from '../workflows/email-queue';
import { flash, layout, recordUrl, steps, type Html } from './layout';

export interface DraftForm {
  subject: string;
  body: string;
  overwrite: boolean;
}

export interface DraftPageState {
  form: DraftForm;
  error: string | null;
  saved: string | null; // confirmation message after a save
  claudeDraft: ClaudeDraftAudit | null; // shown right after "Draft with Claude"
  claudeReady: boolean;
  sender: { name: string; email: string | null }; // email null: no Gmail connected
  signature: string | null; // as saved on /settings (plain text or HTML)
  tracking: { opens: boolean; clicks: boolean };
}

// The final email, built by the same composeEmail the send uses, so the
// preview can't drift from what goes out. The script below re-renders it
// through POST /tasks/:id/preview as the rep types.
function finalEmailCard(ctx: DraftContext, state: DraftPageState): Html {
  const toEmail = ctx.contact.properties.email;
  const toName = [ctx.contact.properties.firstname, ctx.contact.properties.lastname].filter(Boolean).join(' ');
  const composed = composeEmail(state.form.subject, state.form.body, state.signature);
  const hasSignature = Boolean(state.signature?.trim());

  return html`<div class="card" id="final">
    <div class="row">
      <h2>Exactly as it will be sent</h2>
      <span class="muted">Updates as you type</span>
    </div>
    <dl class="headers">
      <dt>From</dt><dd>${state.sender.name} &lt;${state.sender.email ?? 'no Gmail connected'}&gt;</dd>
      <dt>To</dt><dd>${toName ? `${toName} <${toEmail ?? 'no email'}>` : (toEmail ?? 'no email address in HubSpot')}</dd>
      <dt>Subject</dt><dd><strong id="final-subject">${composed.subject || '(no subject yet)'}</strong></dd>
    </dl>
    <iframe id="final-preview" data-preview-url="/tasks/${ctx.task.id}/preview" class="email-preview" sandbox srcdoc="${previewDocument(composed.html)}" title="Final email preview"></iframe>
    <p class="muted">
      ${hasSignature ? 'Your signature is included at the end' : 'No signature: this email would go out without one'}
      (<a href="/settings">edit in Settings</a>). ${trackingNote(state.tracking.opens, state.tracking.clicks)}
    </p>
  </div>`;
}

function editorCard(ctx: DraftContext, state: DraftPageState): Html {
  return html`<form method="post" action="/tasks/${ctx.task.id}/draft" class="card">
    <h2>Write the email</h2>
    <div class="field">
      <label for="subject">Subject</label>
      <input type="text" id="subject" name="subject" value="${state.form.subject}" required />
    </div>
    <div class="field">
      <label for="body">Body</label>
      <textarea id="body" name="body" required>${state.form.body}</textarea>
    </div>
    ${
      ctx.existingDraft
        ? html`<label class="check plain"><input type="checkbox" name="overwrite" value="1" ${state.form.overwrite ? 'checked' : ''} />
          Replace the existing draft on this task</label>`
        : ''
    }
    <div class="actions">
      <button type="submit" class="primary">Save draft to task</button>
      <span class="muted">Saving writes it to the HubSpot task. Nothing is sent.</span>
    </div>
  </form>`;
}

function claudeCard(taskId: string, hasDraft: boolean, ready: boolean): Html {
  const confirmText = hasDraft
    ? 'Replace the current draft with a new one from Claude? The current draft is kept in the audit log.'
    : 'Research this prospect and draft the email with Claude? This takes a minute or two.';
  return html`<form class="card" method="post" action="/tasks/${taskId}/draft/claude" onsubmit="if(!confirm(this.dataset.confirm))return false;this.querySelector('button').disabled=true;this.querySelector('.status').textContent='Researching and drafting. This takes a minute or two.';return true" data-confirm="${confirmText}">
    <h2>${hasDraft ? 'Redraft with Claude' : 'Let Claude draft it'}</h2>
    <p class="status muted">
      ${
        ready
          ? `Researches the company on the web, then writes the email in your voice and saves it to the task. Takes a minute or two.${hasDraft ? ' The current draft is kept in the audit log.' : ''}`
          : 'Needs ANTHROPIC_API_KEY (see Settings).'
      }
    </p>
    <div><button type="submit" class="${hasDraft ? '' : 'primary'}" ${ready ? '' : 'disabled'}>${hasDraft ? 'Redraft with Claude' : 'Draft with Claude'}</button></div>
  </form>`;
}

function copyContextCard(claudeContext: string): Html {
  return html`<div class="card">
    <div class="row">
      <div class="tight">
        <strong>Draft in your own Claude chat</strong>
        <span class="muted">Copies the research and drafting rules to paste into claude.ai.</span>
      </div>
      <div class="actions">
        <button type="button" id="copy-context">Copy context</button>
        <span id="copy-status" class="muted" aria-live="polite"></span>
      </div>
    </div>
    <details>
      <summary class="muted">Show the context</summary>
      <textarea id="claude-context" class="context" readonly>${claudeContext}</textarea>
    </details>
  </div>`;
}

function claudeResult(d: ClaudeDraftAudit): Html {
  return flash(
    'ok',
    html`Drafted by ${d.model} (effort ${d.effort}) with ${d.usage.webSearches} web searches and saved to the task. Read it over, then preview.
      ${d.research ? html`<details><summary>What Claude found</summary><pre>${d.research}</pre></details>` : ''}`
  );
}

function researchCard(ctx: DraftContext, company: string | null, contact: string): Html {
  const description = ctx.company?.properties.description?.trim();
  const { jobtitle, email } = ctx.contact.properties;
  return html`<div class="card">
    <div class="grid-2">
      <div class="tight">
        <h3>${company ?? 'No company on record'} ${ctx.company ? html`<span class="fit">${parseFitLabel(description)}</span>` : ''}</h3>
        <pre class="muted scroll">${description || '(no description)'}</pre>
      </div>
      <div class="tight">
        <h3>${contact}${jobtitle ? ` · ${jobtitle}` : ''}</h3>
        ${email ? html`<p class="muted">${email}</p>` : ''}
        <div class="scroll tight">
          ${
            ctx.notes.length
              ? ctx.notes.map((n) => html`<p class="muted">${n.timestamp?.slice(0, 10) ?? ''} · ${n.text}</p>`)
              : html`<p class="muted">No notes on this contact.</p>`
          }
        </div>
      </div>
    </div>
  </div>`;
}

export function draftPage(ctx: DraftContext, state: DraftPageState, portalId: string, actor: string): Html {
  const contact = contactName(ctx.contact);
  const company = companyName(ctx.company);
  const taskId = ctx.task.id;
  const hasDraft = Boolean(ctx.existingDraft);
  const templated = isTemplatedFollowUp(ctx.task.properties.hs_task_subject);

  return layout(
    `Draft · ${company ?? contact}`,
    actor,
    html`
      <div class="row">
        <a href="/">← Queue</a>
        ${steps('draft')}
      </div>
      <div class="tight">
        <h1>Draft email: ${company ?? 'No company'} · ${contact}</h1>
        <p class="muted">
          Task ${taskId}: ${ctx.task.properties.hs_task_subject ?? '(no subject)'} ·
          <a href="${recordUrl(portalId, '0-1', ctx.contact.id)}" target="_blank" rel="noopener">contact in HubSpot</a>
          ${
            ctx.company
              ? html` · <a href="${recordUrl(portalId, '0-2', ctx.company.id)}" target="_blank" rel="noopener">company in HubSpot</a>`
              : ''
          }
        </p>
      </div>

      ${state.saved ? flash('ok', state.saved) : ''}
      ${state.claudeDraft ? claudeResult(state.claudeDraft) : ''}
      ${state.error ? flash('err', state.error) : ''}

      ${researchCard(ctx, company, contact)}

      <div class="grid-2">
        <div class="stack">
          ${
            templated
              ? html`${editorCard(ctx, state)}
                  <div class="card">
                    <p class="muted">This follow-up was drafted from your template in <code>src/prompts/follow-up-emails.ts</code>. Claude's drafting rules are for cold emails, so they're left out here. Edit it above if you want to change anything.</p>
                  </div>`
              : hasDraft
                ? html`${editorCard(ctx, state)} ${claudeCard(taskId, true, state.claudeReady)}`
                : html`${claudeCard(taskId, false, state.claudeReady)} ${editorCard(ctx, state)}`
          }
          ${templated ? '' : copyContextCard(ctx.claudeContext)}
        </div>
        ${finalEmailCard(ctx, state)}
      </div>

      ${
        ctx.existingDraft
          ? html`<details class="card">
            <summary>Draft currently saved on the task</summary>
            <pre>${ctx.existingDraft}</pre>
          </details>`
          : ''
      }

      <div class="bar">
        ${
          hasDraft
            ? html`<span class="muted">Nothing is sent from this page.</span>
              <a class="button primary" href="/tasks/${taskId}/send">Preview &amp; send →</a>`
            : html`<span class="muted">Save a draft to the task, then preview and send it.</span>`
        }
      </div>

      <script>
        (function () {
          var fields = ['subject', 'body'].map(function (id) { return document.getElementById(id); });
          var frame = document.getElementById('final-preview');
          var subjectOut = document.getElementById('final-subject');
          var timer = null;
          function refresh() {
            var data = new URLSearchParams();
            fields.forEach(function (f) { if (f) data.append(f.name, f.value); });
            fetch(frame.dataset.previewUrl, { method: 'POST', body: data })
              .then(function (res) { return res.ok ? res.text() : null; })
              .then(function (doc) { if (doc !== null) frame.srcdoc = doc; });
            subjectOut.textContent = document.getElementById('subject').value.trim() || '(no subject yet)';
          }
          fields.forEach(function (f) {
            if (f) f.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(refresh, 350); });
          });
        })();

        document.getElementById('copy-context').addEventListener('click', async () => {
          const context = document.getElementById('claude-context');
          const status = document.getElementById('copy-status');
          try {
            await navigator.clipboard.writeText(context.value);
            status.textContent = 'Copied.';
          } catch {
            context.closest('details').open = true;
            context.select();
            status.textContent = 'Selected. Press Cmd/Ctrl+C.';
          }
        });
      </script>
    `
  );
}
