// The page that approves the Claude connector: which app is asking, where
// its access goes, and who it will act as. Everything about the client comes
// from its own registration, so hono's html escapes it like any other value.

import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { html } from 'hono/html';
import { flash, layout, type Html } from './layout';

export function consentPage(details: ConsentDescription, handle: string, actor: string): Html {
  return layout(
    'Connect Claude',
    actor,
    html`<h1>Connect ${details.clientName}?</h1>
      <p>
        ${details.clientName} will work in this app as <strong>${actor}</strong>: read the queues, contacts, calls
        and interviews, save drafts, log calls and interviews, move calls, and open tasks. It can’t send email or
        place calls: those stay on these pages.
      </p>
      <p class="muted">
        ${
          details.clientDomain
            ? html`Published by <strong>${details.clientDomain}</strong>.`
            : 'The app registered itself, so its name isn’t verified.'
        }
        Access goes to <strong>${details.redirectHost}</strong>.
      </p>
      ${
        details.redirectIsLoopback
          ? flash(
              'warn',
              'This sends access to an app on this computer. Continue only if you just started connecting from it.'
            )
          : ''
      }
      <form method="post" action="/authorize" class="actions">
        <input type="hidden" name="handle" value="${handle}" />
        <button type="submit" name="decision" value="approve" class="primary">Connect</button>
        <button type="submit" name="decision" value="deny">Cancel</button>
      </form>`
  );
}
