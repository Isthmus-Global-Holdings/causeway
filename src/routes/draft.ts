import { Hono } from 'hono';
import { saveEmailDraft } from '../actions/emails';
import { loadAppSettings, type AppSettings } from '../lib/app-settings';
import { composeEmail, previewDocument } from '../lib/compose';
import { ClaudeDraftError, draftWithClaude, type ClaudeDraft } from '../lib/claude';
import { insertAudit, latestAuditDetail } from '../lib/db';
import { createHubSpot } from '../lib/hubspot';
import { parseTaskBody } from '../lib/richtext';
import type { AppEnv } from '../types';
import { sentNotice } from './next-email';
import { draftPage, type DraftForm } from '../views/draft';
import { loadDraftContext, saveDraft } from '../workflows/draft-email';
import { isTemplatedFollowUp } from '../workflows/email-queue';
import { WorkflowError } from '../workflows/parties';

export const draftRoute = new Hono<AppEnv>();

// GET /tasks/:id/draft — research for the task plus the draft form, prefilled
// with whatever draft is already on the task.
draftRoute.get('/:id/draft', async (c) => {
  const taskId = c.req.param('id');
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const [ctx, settings, claudeDraft] = await Promise.all([
    loadDraftContext(hs, taskId),
    loadAppSettings(c.env),
    c.req.query('claude') === '1' ? latestAuditDetail<ClaudeDraftAudit>(c.env.DB, taskId, CLAUDE_ACTION) : null,
  ]);

  const body = ctx.task.properties.hs_task_body;
  const parsed = body ? parseTaskBody(body) : null;
  const form: DraftForm = parsed
    ? { ...parsed, overwrite: false }
    : { subject: '', body: ctx.existingDraft ?? '', overwrite: false };

  return c.html(
    draftPage(
      ctx,
      {
        form,
        error: null,
        saved: c.req.query('saved') === '1' ? 'Draft saved to the task.' : sentNotice(c),
        claudeDraft,
        claudeReady: Boolean(c.env.ANTHROPIC_API_KEY),
        ...senderState(settings),
      },
      c.env.HUBSPOT_PORTAL_ID,
      c.get('actor')
    )
  );
});

const CLAUDE_ACTION = 'draft with claude';

function senderState(settings: AppSettings) {
  return {
    sender: { name: settings.fromName, email: settings.googleEmail },
    signature: settings.signatureHtml,
    tracking: { opens: settings.trackOpens, clicks: settings.trackClicks },
  };
}

// POST /tasks/:id/preview: the final email for the live preview on the draft
// page, built by the same composeEmail the send uses. Nothing is saved.
draftRoute.post('/:id/preview', async (c) => {
  const fields = await c.req.parseBody();
  const text = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string) : '');
  const { signatureHtml } = await loadAppSettings(c.env);
  const composed = composeEmail(text('subject'), text('body'), signatureHtml);
  return c.html(previewDocument(composed.html));
});

export interface ClaudeDraftAudit {
  model: string;
  effort: string;
  research: string | null;
  usage: ClaudeDraft['usage'];
  previousDraft: string | null;
}

// POST /tasks/:id/draft/claude: Claude researches and drafts, and the result
// is written straight into the task (as the mom-test-vfwpa-email skill does).
// The previous draft is kept in the audit log, so a redraft never loses it.
draftRoute.post('/:id/draft/claude', async (c) => {
  const taskId = c.req.param('id');
  const actor = c.get('actor');
  if (!c.env.ANTHROPIC_API_KEY) {
    throw new WorkflowError('No Anthropic API key yet. Run: npx wrangler secret put ANTHROPIC_API_KEY');
  }
  const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
  const [ctx, settings] = await Promise.all([loadDraftContext(hs, taskId), loadAppSettings(c.env)]);
  if (isTemplatedFollowUp(ctx.task.properties.hs_task_subject)) {
    throw new WorkflowError('This follow-up is drafted from your template, not by Claude. Edit the draft instead.');
  }

  try {
    const draft = await draftWithClaude(
      c.env.ANTHROPIC_API_KEY,
      { model: settings.claudeModel, effort: settings.claudeEffort },
      ctx.apiContext
    );
    await saveDraft(hs, taskId, { subject: draft.subject, body: draft.body, overwrite: true });
    const detail: ClaudeDraftAudit = {
      model: draft.model,
      effort: settings.claudeEffort,
      research: draft.research,
      usage: draft.usage,
      previousDraft: ctx.existingDraft,
    };
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'draft-email',
      taskId,
      action: CLAUDE_ACTION,
      outcome: 'success',
      detail,
    });
    return c.redirect(`/tasks/${encodeURIComponent(taskId)}/draft?claude=1`, 303);
  } catch (err) {
    await insertAudit(c.env.DB, {
      actor,
      workflow: 'draft-email',
      taskId,
      action: CLAUDE_ACTION,
      outcome: 'failed',
      error: err instanceof Error ? err.message : String(err),
    });
    if (err instanceof ClaudeDraftError) throw new WorkflowError(err.message, 409);
    throw err;
  }
});

// POST /tasks/:id/draft — writes Subject + body into the task's hs_task_body.
draftRoute.post('/:id/draft', async (c) => {
  const taskId = c.req.param('id');
  const actor = c.get('actor');
  const fields = await c.req.parseBody();
  const form: DraftForm = {
    subject: typeof fields.subject === 'string' ? fields.subject : '',
    body: typeof fields.body === 'string' ? fields.body : '',
    overwrite: fields.overwrite === '1',
  };

  try {
    await saveEmailDraft(c, taskId, form);
    return c.redirect(`/tasks/${encodeURIComponent(taskId)}/draft?saved=1`, 303);
  } catch (err) {
    // Validation problems re-render the form with the rep's text intact
    // instead of throwing it away on an error page.
    if (!(err instanceof WorkflowError)) throw err;
    const hs = createHubSpot(c.env.HUBSPOT_ACCESS_TOKEN);
    const [ctx, settings] = await Promise.all([loadDraftContext(hs, taskId), loadAppSettings(c.env)]);
    return c.html(
      draftPage(
        ctx,
        {
          form,
          error: err.message,
          saved: null,
          claudeDraft: null,
          claudeReady: Boolean(c.env.ANTHROPIC_API_KEY),
          ...senderState(settings),
        },
        c.env.HUBSPOT_PORTAL_ID,
        actor
      ),
      err.status
    );
  }
});
