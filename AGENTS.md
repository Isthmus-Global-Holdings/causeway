# Causeway

Cloudflare Worker that replaces HubSpot's paid Workflows with rep-triggered
flows (Causeway is the name the pages, the Claude connector and the GitHub
repo, `Isthmus-Global-Holdings/causeway`, show; the Worker, URL, D1 and
HubSpot project keep `hubspot-automations`):
- draft an outreach email into an EMAIL task (by hand, or with Claude)
- send it from the rep's Gmail with open and click tracking, and log it on
  the contact
- after sending, complete the task, create tomorrow's CALL task, and surface
  the next task
- work through the CALL tasks with a shared call script and the contact's
  HubSpot history on the page: click to call through Twilio (it rings the
  rep's phone, then dials the prospect, or the rep talks through the browser
  with Twilio's Voice SDK), log the outcome on the contact, complete the
  task, and create the follow-up
- optionally record calls and transcribe them (Workers AI), with the
  transcript and summary written onto the logged call
- forward calls to the Twilio number to the rep's phone (press 1 to take one,
  voicemail otherwise), recorded and transcribed the same way, and logged on
  the caller's HubSpot contact; call them back from the Twilio number, logged
  the same way
- message or call a prospect on the rep's own WhatsApp: a button opens the
  chat with an opener written in (click-to-chat links, no API: Meta doesn't
  deliver a business's first message to US numbers, and a US business number
  can't place WhatsApp calls), and the call log form logs it as a WhatsApp
  message (a HubSpot communication) or call
- coaching, in the background: each logged call read by rules (its
  transcript turn by turn, else the rep's notes) for the phone menu, who
  answered and what the front desk did, how far it got, the objection and
  the next step, kept read by a cron sweep; the patterns across calls on Coaching,
  with the interviews they booked followed to how each turned out; and on
  the call page, quietly, what to adjust after the last call and what's
  worked on calls like the next
- see every past call, inbound and outbound, on Calls (the record), with its
  summary, notes and transcript, searchable; the missed calls and voicemails
  still waiting on a call back sit in the Queue with the calls to make
- look up any contact or company: details and address, tasks, interviews and
  HubSpot history, with Call and Email opening (or creating) their task
- book interviews as HubSpot meetings (a phone call by default, or video;
  from a call, optionally with a Google Calendar invite and Meet link), prep
  for them, call from them, and log how they went
- follow up a no-show: a drafted "sorry we missed each other" email, the next
  day's call, then a drafted last-try email; and a cancel (theirs is a reply,
  kept apart from a no-show) with a drafted "thanks for letting me know"
  email offering another time
- pitch Upwork jobs from a Chrome extension (`extension/`): a shortcut pastes
  the rep's pitch at the cursor with the Loom link from the clipboard, and
  logs the job as a HubSpot deal (one per job, `deal_source = Upwork`, no
  contact: talking to the client stays on Upwork)
- work all of it from a Claude chat: a custom connector (remote MCP at `/mcp`,
  OAuth approved behind Access) whose tools read and write as the rep, on the
  rep's Claude plan rather than the API; sending and dialling stay on the pages

See README.md for the behaviour.

## Principles

- **Explicit over clever.** The stack is plain TypeScript, Hono, and D1 through
  `prepare().bind()`.
  - No ORM, no HubSpot SDK, no client-side framework.
  - The Claude connector uses protocol libraries only:
    `@modelcontextprotocol/sdk` (stateless, one server per request),
    `@cloudflare/workers-oauth-provider` and `zod` for tool inputs.
  - No decorators or metaprogramming.
- **Every HubSpot write must be safe to repeat.** `runEmailSent` records each
  step in `sent_confirmations` as it lands, `runCallLogged` does the same
  in `call_logs`, `logInboundCall` in `inbound_calls`, `logCallBack` in `dials`, `runMeetingLogged` in
  `meeting_logs` and `runBooking` in `meeting_bookings`. `logPitch` needs no
  row: `upwork_job_id` is a unique-value property, so the job's deal is read
  by it first and HubSpot refuses a second one. Coaching (`readCall`) writes
  only D1, one `call_insights` row per logged call, replaced whole (its
  `excluded` flag kept), with the call's reviews (`call_reviews`, one per
  reviewer, replaced whole by `review_call`) laid over the rules each time; the cron sweep (`runCoachingSweep`) repeats safely. `taskForContact`
  reuses the contact's open task before creating one, under a lock in
  `contact_task_locks`. A new meeting is
  looked for on the contact before one is created, and a calendar invite's id
  comes from its booking, so neither is ever made twice. Any new multi-step write should follow the same
  resume-not-repeat pattern.
- **The rep never waits on follow-up writes.** Sending, Mark sent and logging
  a call are split in two: `prepare…` (the rep waits: checks, the D1 row, the
  lock; Gmail for a send) and `finish…` (HubSpot steps only, run after the
  response with `afterResponse` in `lib/background.ts`). A failed step keeps
  its error on the row (`last_error`) for the notice every page fetches
  (`GET /unfinished`); running it again finishes it. Keep pages to as few
  rounds of HubSpot requests as possible: read a record's links with it
  (`getWithAssociations`) and run independent reads in one `Promise.all`.
- **Pages and the connector share their actions.** Where a route does more
  than parse → workflow → answer (checks, audit, `afterResponse`, the work
  plan), that middle lives in `src/actions/*` and takes the Hono context; the
  route redirects or renders, the MCP tool (`src/mcp/tools.ts`) returns JSON.
  A tool never calls a workflow with rules of its own. Failures are worded
  once, in `lib/errors.ts`, for the error page and the tool error alike.
- **Model work goes through the connector, on the rep's Claude plan.** The
  rep does the reading, writing and judging with Claude in a chat, through
  the connector, paid for by their Claude subscription rather than tokens
  the Worker spends. A tool hands Claude the inputs (and the rules, as
  `drafting_rules` does), and a write tool saves what it decided
  (`save_draft`). The Worker calls a model only when nothing else can do the
  job:
  - the Claude API (`ANTHROPIC_API_KEY`) only behind a button the rep presses
    on a page (Draft with Claude). The button may run it now, or queue a job
    the Worker drains on the cron trigger; nothing else ever starts it;
  - Workers AI only for unattended work a chat can't do, on the free daily
    allowance: speech-to-text and the transcript's summary;
  - Jev (TypeSafe, `TYPESAFE_API_KEY`) for coaching's unattended tags on each
    call: once per call, cached, a fraction of a cent.

  A new feature that needs a model gets connector tools first (one to read
  the inputs, one to save the result). Add a button or a background model
  call only when the rep asks for one. Coaching's per-call read
  (`workflows/call-insight.ts`) is rules, no model.
- **Pure logic stays pure.** `lib/fit.ts`, `lib/richtext.ts`, `lib/dates.ts`,
  `lib/prompt.ts`, `lib/phone.ts`, `lib/twiml.ts`, `lib/transcript.ts`,
  `lib/call-script.ts`, `lib/call-insight.ts`, `lib/call-timeline.ts`, `lib/coaching.ts`, `lib/heard.ts`, `lib/voice-token.ts`, `lib/whatsapp.ts`, `lib/work-plan.ts`, `lib/address.ts`, `lib/call-history.ts`, `lib/sent-rank.ts`, `lib/set-time.ts`, `lib/upwork.ts` (also bundled into the extension), `mcp/format.ts`, `prompts/follow-up-emails.ts`, `prompts/whatsapp-messages.ts` and `prompts/call-review.ts` do no I/O and are unit tested. Workflows take interfaces (`HubSpot`, `Twilio`, and the D1 stores
  in `lib/db.ts`), so tests use fakes or the real SQL on SQLite.
- **Sending never repeats.** `runSend` records a `sent_emails` row before
  calling Gmail, and never resends a row whose outcome is unknown. The rep
  checks Gmail's Sent folder instead.
- **A prospect is only dialled after the rep confirms.** On the phone, the
  bridge rings the rep first and only pressing 1 dials, so a voicemail
  answering the rep's phone presses nothing. An extension after the HubSpot
  number is keyed in by Twilio (`sendDigits`) once the line answers, and a
  call to an extension is never recorded (the notice would reach only the
  phone menu). In the browser, clicking Call is
  the go-ahead, and `/twilio/voice/client` connects each dial at most once,
  within two minutes of the click. The number dialled is always read from
  HubSpot (or, for a call back, from Twilio's record of the inbound call),
  never taken from the form. An inbound call is likewise only
  connected once the rep presses 1, so the rep's own voicemail never takes it.
- **A recorded call always plays the notice first.** Recording is off until
  the rep turns it on in /settings. When on, the prospect hears "This call may
  be recorded." before being connected (all-party-consent states), and so does
  anyone calling the Twilio number. Voicemails are always recorded. Recordings
  stay on Twilio and are only served through Access, never at a public URL.
- **The drafting rules are the rep's skills.** `src/prompts/draft-system.ts` is
  the app's copy of `mom-test-vfwpa-email` and `my-writing-style`. Change it
  when they change. `src/prompts/interview-questions.ts` is the rep's
  interview guide, `src/prompts/follow-up-emails.ts` the rep's no-show
  follow-up emails, `src/prompts/whatsapp-messages.ts` the rep's WhatsApp
  messages (templates, not Claude) and `src/prompts/call-review.ts` how Claude
  reviews a call through the connector, none a skill copy: edit them directly. Claude, Twilio's per-minute calling and recording, and
  TypeSafe (Jev, negligible) are the only paid dependencies; everything else
  stays on free tiers (call transcripts use the free daily Workers AI
  allowance, and the cron trigger is one of the free plan's five).

## Deployment

- Worker URL: `https://hubspot-automations.frosty-darkness-3dd3.workers.dev`
- D1: `hubspot-automations-db` (`99d1f538-2098-4721-88cf-6a4bbd929f25`)
- HubSpot account: `isthmus-global-holdings` (247260710), project `hubspot-automations` in `hubspot/`
- Test CRM: developer test account `isthmus-test` (247548603, config `hubspot/test-account.json`), with a test install of the app. `npm run dev` uses it (`.dev.vars.test` over `.dev.vars`), so local work never touches live prospects; `npm run seed:test` fills it. Only the deployed Worker uses the live CRM (README → Test CRM).
- Secrets: `HUBSPOT_ACCESS_TOKEN`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY_SECRET` (browser calling), `TYPESAFE_API_KEY` (Jev, coaching's tags)
- Cron: `*/10 * * * *` (`wrangler.jsonc` → `triggers`), the `scheduled` handler in `src/worker.ts`: coaching's sweep (`workflows/coaching-sweep.ts`) runs again any transcription that died and reads up to ten calls not read yet, or read by older rules (`RULES_VERSION`)
- Vars: `TZ` (the rep's time zone until one is picked on /settings), `PITCH_EXTENSION_ID` (the Upwork extension, the only other origin that may POST, to `/pitches`), `GOOGLE_CLIENT_ID`, `PUBLIC_BASE_URL` (tracking links and Twilio webhooks always point at the deployed Worker), `TWILIO_TWIML_APP_SID` (browser calling: the TwiML App whose Voice URL is `/twilio/voice/client`). `TWILIO_ACCOUNT_SID` and `TWILIO_API_KEY_SID` (the API key that signs Voice SDK tokens) are vars set on the Worker in Cloudflare and in `.dev.vars`, kept out of the public repo; `keep_vars` stops a deploy from removing them
- Twilio: the account in `TWILIO_ACCOUNT_SID`, number +1 385-255-7051. The number to call from and the rep's phone are picked on /settings from what Twilio lists for the account (voice numbers, verified caller IDs), never typed. The number is on the account's approved Trust Hub Business Profile (Dolphin Web Dynamics LLC) and SHAKEN/STIR product, so calls from it get "A" attestation. Its A2P 10DLC campaign (approved 2026-09-29) covers only people who opt in to texts through the website's form; the app still never sends SMS, and cold outreach must not go out as texts from this number. The number's voice URL is `/twilio/voice/inbound` and its status callback `/twilio/voice/inbound/status` (see README): that's what forwards calls to it.
- Access vars: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. The Worker returns 500 for every request until these are set.
- Gmail: the connected account is `isthmusglobalholdings@gmail.com`, the same inbox HubSpot sends from. HubSpot's inbox sync logs every email sent from it on the contact within about a minute, so the app's own logging (`log_to_hubspot`) is off by default.
- Claude connector: `src/worker.ts` (the `main`) wraps the app in OAuthProvider. Its clients, grants and tokens are in the KV namespace bound as `OAUTH_KV`. Access needs Bypass policies for `/mcp`, `/oauth/mcp/*` and `/.well-known/*`; `/authorize` stays behind Access. Only Claude's callback (`https://claude.ai/api/mcp/auth_callback`, or claude.com) may register or receive a token, plus loopback on localhost.
- Merging: `main` takes changes only through a PR (ruleset "Protect main"), and only collaborators can open one (the repo is public, but its PR creation is set to collaborators only, so outsiders can't set off a Codex review), with two required checks: `check` (`.github/workflows/ci.yml`, `npm run check` and `npm audit`) and `codex-review` (`.github/workflows/codex-review.yml`, `scripts/codex-review-gate.mjs`), which waits for Codex to review the PR's latest commit. Codex posts no status of its own, so the gate reads its summary comment and reviews; it passes anyway when Codex is out of usage, hasn't answered in 15 minutes, or the PR has the `skip-codex` label. Codex's findings don't block. Auto-merge is on, so "merge when ready" waits for both
- Placement: Smart Placement (`wrangler.jsonc`), so the Worker runs near HubSpot and D1.
- Migrations: `migrations/000N_*.sql` are applied with `wrangler d1 migrations apply` (`npm run db:migrate[:local]`), which records what ran in `d1_migrations`. `npm run deploy` runs `db:migrate` first, so the remote schema is never behind the code: keep migrations additive, since the old Worker serves until the new one is up. Remote D1 had 0001 applied by hand before the switch: mark it applied (`INSERT INTO d1_migrations (name) VALUES ('0001_init.sql')`) before the first remote `migrations apply`.

## Routes

| Method | Path | What |
|---|---|---|
| GET | `/` | Queue, Emails to send tab: today's counts (emails sent, people called, interviews), ranked queue of NOT_STARTED EMAIL tasks + "Next up" |
| GET | `/queue` | The navbar's Queue link: redirects to the tab the rep was last on (`queue_tab` cookie), Emails to send (`/`) or Calls to make (`/queue/calls`) |
| GET | `/tasks/:id/draft` | Research + Claude context + draft form |
| POST | `/tasks/:id/draft` | Save Subject + body into `hs_task_body` |
| POST | `/tasks/:id/draft/claude` | Research + draft with Claude, save to the task |
| GET | `/tasks/:id/send` | Exact preview of the email |
| POST | `/tasks/:id/send` | Send via Gmail; then (after the response) log on contact, complete task, create CALL task. Lands on the next email |
| POST | `/tasks/:id/send/resolve` | Rep's answer after an ambiguous send ("it's in Sent" or not) |
| POST | `/tasks/:id/sent` | Complete task + CALL task (after the response) for an email sent from HubSpot by hand. Lands on the next email |
| POST | `/tasks/:id/drop` | Mark an EMAIL task DEFERRED (won't send, no follow-up). The queue's script drops in place (`X-Fragment`: just the notice back) |
| GET | `/queue/calls` | Queue, Calls to make tab: "Waiting on a call back" (missed calls and voicemails not returned), then open CALL tasks: today's at a set time (a HubSpot reminder marks them; each is "Next call" from 5 min before its time, never earlier), today's ranked (clicked your email, then fit, then most overdue) + "Next call", then upcoming |
| GET | `/calls/:id` | Where they are (city, street, map), call script, numbers, last email, contact/company facts, HubSpot history (notes, calls, emails), live call status, coaching (after the last call, before this one), log form. `?call=1` (the queue's Call) presses Call for the first number on load |
| POST | `/calls/:id/script` | Save the call script (one, shared by every call) |
| POST | `/calls/:id/dial` | Ring the rep's phone; pressing 1 dials the contact. From the browser: record the dial, answer JSON with a Voice SDK token |
| POST | `/calls/:id/dial/:dialId/end` | The page's browser call is over: free the task if it never connected, else end the dial |
| GET | `/calls/:id/dial/:dialId/status` | The call's status, fetched by the page while the call is live (also under `/meetings`) |
| POST | `/calls/:id/log` | Log the call (a phone call, or a WhatsApp call or message: `channel`) on the contact, complete the task, create the follow-up, optionally at a set time (after the response, unless it books an interview), book the interview it set up. Lands on the next call |
| POST | `/calls/:id/numbers` (also `/meetings/:id/numbers`) | Save the contact's phone and mobile, each with an extension, in HubSpot (JSON for the page's script, so a call isn't interrupted) |
| POST | `/calls/:id/snooze` | Move a CALL task to another day, keeping its time of day, or to a set time (today or later) |
| GET | `/calls/:id/recording/:dialId` | The call's audio, streamed from Twilio |
| GET | `/calls/:id/transcript/:dialId` | The transcript card, fetched by the page while it waits |
| POST | `/calls/:id/transcribe` | Retry a failed transcription |
| GET | `/calls` | Calls, the record: every call, in and out (dials, calls to the Twilio number, calls logged by hand), newest first, summary, notes, transcript and recording inline, each logged call's coaching tags; `?dir=in\|out`, `?q=` (names, numbers, summaries, notes, transcripts; results show where it matched), `?before=` |
| GET | `/inbound` | Redirects to `/calls?dir=in` |
| GET | `/coaching` | Patterns across every logged call: the interviews they booked and how each turned out (held, no-show, canceled, to log), the front desk, rushed connects with no next step, long connects, objections and the openings that got past them, reached rate by hour of their day and time zone, follow-up timing, length by outcome. Reads a few unread calls after it answers |
| GET | `/coaching/heard` | What you've heard: the software they use and what they said about their work, in their words, by theme, across every call and interview that reached them (their part of each transcript, and the rep's notes); counts of calls and the newest quotes, each linking its call. The record for the synthesis, which is done with Claude (`what_you_heard`) |
| POST | `/coaching/calls/:id/exclude` | Leave a logged call out of coaching (a test call), or put it back (`excluded=0`); D1 only. The Calls page's button |
| POST | `/inbound/:id/dismiss` | Take the caller off "Waiting on a call back" without calling (D1 only) |
| GET | `/inbound/:id` | One inbound call: who (HubSpot contact, caller ID, where the number's from), outcome, recording, transcript, HubSpot log, other calls from the number, Call back |
| GET | `/inbound/:id/recording`, `/inbound/:id/transcript` | Its audio from Twilio; the transcript card for the page to poll |
| POST | `/inbound/:id/transcribe` | Retry a failed transcription (the call's, or a call back's with `dial_id`) |
| POST | `/inbound/:id/dial` (and `/dial/:dialId/end`, `/dial/:dialId/status`, `/recording/:dialId`, `/transcript/:dialId`) | Call them back from the Twilio number, the same as from a call task; a call back to a contact logs itself |
| GET | `/meetings` | Interviews (HubSpot meetings), a week back to two weeks ahead |
| GET | `/meetings/:id` | Prep: time, Join, questions, contact history, call, log form |
| POST | `/meetings/:id/log` | Outcome + notes on the meeting (or its new time; who canceled, D1 only), follow-up task, Lead Status |
| POST | `/meetings/:id/dial` (and `/dial/:dialId/end`, `/recording/:dialId`, `/transcript/:dialId`, `/transcribe`) | Call the interview's contact, the same as from a call task |
| POST | `/calls/:id/book` | Book an interview from a call task without logging a call (optionally a calendar invite) |
| GET | `/contacts`, `/companies` | Search HubSpot's contacts or companies (`?q=`), most recently updated first |
| GET | `/contacts/:id` | Details and address, company, tasks, interviews, last email, HubSpot history; Call and Email |
| POST | `/contacts/:id/call`, `/contacts/:id/email` | Open the contact's open task of that type, or create one due now; land on its call or draft page (`then=whatsapp`: at the call page's WhatsApp button) |
| GET | `/companies/:id` | Details and address, contacts (each with Call and Email), tasks |
| POST | `/pitches` | The Upwork pitch extension: the job's deal in HubSpot (JSON in and out; from the extension's origin) |
| GET | `/unfinished` | The notice on every page: HubSpot writes still saving after the response, or stopped short |
| GET/POST | `/authorize` | Approve the Claude connector: the OAuth consent page, behind Access; issues a token that acts as the rep |
| POST | `/mcp` | Public, OAuth bearer: the Claude connector's MCP server (tools in `src/mcp/tools.ts`) |
| POST | `/oauth/mcp/register`, `/oauth/mcp/token`; GET `/.well-known/oauth-*` | Public: OAuthProvider's client registration, tokens and discovery |
| GET/POST | `/settings` | Signature, from name, time zone, Claude model/effort, Gmail connection (also sends interview invites), calling (phone or browser, numbers, recording), where WhatsApp opens (app or Web) |
| GET | `/oauth/google/start`, `/oauth/google/callback` | Connect the Gmail account |
| GET | `/t/o/:token`, `/t/c/:token` | Public: tracking pixel and link redirect |
| POST | `/twilio/voice/*` | Public: Twilio's webhooks for a bridged or browser call, its recording notice and finished recording, and for calls to the number (`/twilio/voice/inbound*`) (signed) |

All routes go through `middleware/access.ts`, except `/t/*`, which recipients'
mail apps hit and which answers only to random tokens, `/twilio/*`, which
checks every request's `X-Twilio-Signature` instead, and the connector's
`/mcp`, `/oauth/mcp/*` and `/.well-known/*`, which OAuthProvider answers
before the app (a bearer token on `/mcp`). The middleware verifies
the Access JWT, and it only accepts non-GET requests from the app's own origin,
and on `/pitches` also from the pitch extension's (`PITCH_EXTENSION_ID`, pinned
by the `key` in `extension/manifest.json`), which sends the rep's Access cookie.

## Commands

`npm run check` (the full gate CI runs: typecheck, lint, format, tests; the extension included) · `npm test` · `npm run format` · `npm run dev` (the test CRM; `--local`: wrangler's remote-binding proxy can't pass Access, so Workers AI only runs deployed) · `npm run dev:live` (the live CRM, only on purpose) · `npm run seed:test` · `npm run worktree` (first, in a new worktree: its secrets, packages and local D1, and a `dev:<name>` entry in the main checkout's launch.json, which is what previews it) · `npm run deploy` (applies new migrations, then deploys) · `npm run db:migrate` · `npm run db:log` · `npm run hs:upload` · `npm run ext:build` (the extension, into `extension/dist`)
