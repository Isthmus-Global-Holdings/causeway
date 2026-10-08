# Causeway

Rep-triggered HubSpot task workflows, run by our own code instead of HubSpot's
Workflows tool, which needs Sales Hub Pro+. HubSpot stays the CRM of record.
This is a Cloudflare Worker (Hono + D1, free tier) that reads and writes
HubSpot through the CRM API, with a small web page behind Cloudflare Access
that reps click through. The Worker, D1 and HubSpot project keep the name
`hubspot-automations`, so the URL stays the same; Causeway is the name the
pages, the Claude connector and the GitHub repo
(`Isthmus-Global-Holdings/causeway`) show.

## Workflows

**1. Draft the outreach email** (`/tasks/:id/draft`)

- **Draft with Claude** researches the company on the web (FMCSA, company
  site) and writes the email in Anel's voice, then saves it to the task. The
  rules are the `mom-test-vfwpa-email` and `my-writing-style` skills, copied
  into `src/prompts/draft-system.ts`. Model and effort are set on /settings.
  The previous draft is kept in the audit log.
- Or by hand, as below:


- Opens a Contact's `EMAIL` task and shows the research for it:
  - the Company `description` (aggregated research and fit assessment)
  - the Contact and its Notes
  - any draft already in `hs_task_body`
- **Copy context for Claude** puts that research, plus the house rules for cold
  email, on the clipboard. The house rules are Vision → Framing → Weakness →
  Pedestal → Ask; never call their company "small"; state research as a plain
  observation.
- The rep pastes the finished Subject + body back. The app writes them into
  `hs_task_body` as `Subject: …<br><br>body`.
- The app never writes copy itself.
- Line breaks become `<br>`, because HubSpot renders `hs_task_body` as rich
  text and would collapse plain newlines.
- If the task already has a draft, replacing it needs an explicit checkbox.

**Send** (`/tasks/:id/send`)

- **Preview:** shows the exact email, including the signature from /settings,
  sent from the Gmail account HubSpot uses (isthmusglobalholdings@gmail.com).
- **Send:** it goes out through the Gmail API, and you land on the next
  email (see step 2). Logging it on the contact's HubSpot timeline (when
  that's on) and step 2 below run after the page has answered.
- **Tracking:** the app does its own, and each kind has a switch on
  /settings. Each link goes through `/t/c/<token>` (click tracking, on by
  default). An invisible pixel loads from `/t/o/<token>` (open tracking, **off**
  by default, since it costs cold-email deliverability). Counts show on the queue
  page, and the first open and each link's first click become a note on the
  contact.
  - The queue's "Sent from this app" is also a call list: each email names the
    contact and company (linked to their pages) and has a **Call** button to
    the follow-up call task the send created. Anyone who clicked or opened
    and hasn't been called since is on top, tagged Clicked or Opened. Once a
    call is logged, the row shows its outcome, and **Call again** when it set
    up another call.
  - HubSpot's own open count is read-only through the API, so the native
    "Opened" badges only appear for emails HubSpot sent itself.
  - Opens are approximate, since some mail apps (Apple Mail) and company
    filters load images on their own. Opens in the first minute are ignored,
    because those are usually your own Sent view. The time of the last open
    shows on the queue, the calls list, and the call page.
- **Never sends twice:**
  - A double-click or retry doesn't resend.
  - A Gmail 4xx means it wasn't sent, so it can be retried.
  - Anything ambiguous (network error, 5xx) makes the app ask you to check
    Gmail's Sent folder instead of guessing.

Verified end to end on 2026-09-25 with a real send to test@anelcanto.com.
It landed in the inbox, not spam. HubSpot's inbox sync logged it on the
contact within about 30 seconds (so the app's own logging is off by default),
and the reply was synced onto the contact too.

**2. Email sent → follow-up** (automatic after **Send**, or the **Mark sent**
button for emails you sent yourself from HubSpot)

HubSpot exposes no send event for one-to-one email, so a rep confirms it by hand.
1. The `EMAIL` task is set to `hs_task_status = COMPLETED`.
2. A `CALL` task is created, linked to the same Contact and Company:
   - due the next calendar day, at the same local time of day as the email
     task (09:00 in your time zone if it has none: picked on /settings, else
     the `TZ` var)
   - subject `Call: {Company} ({Name}) — follow up on email`
3. You land straight on the next email in the queue's order: its draft
   page, or its send page once it's drafted (one still to draft comes
   first). The queue page saves that order each time it shows, and with no
   order saved today, or once it's all done, you land back on the queue.
   The queue re-ranks the remaining `NOT_STARTED` `EMAIL` tasks and offers
   the top one as **Next up — approve & draft**. Once every task worth
   sending is drafted, it offers the best one as **Next to send** instead.
   - Ranking uses the `Fit:` line in each Company's description: STRONG >
     GOOD > weaker (moderate, borderline, or unrated) > unlabelled > drop.
   - Drop means "Fit: POOR", "NOT A FIT", "out of business", or a
     recommended drop ("Recommend: drop", "Likely drop", "Probably drop").
   - Ties go to the oldest task.

**Drop** (on each queue row, after a confirm) is for an email you won't send.
The `EMAIL` task is set to `DEFERRED`, which takes it off the queue, and no
`CALL` task is created. The row goes without the page reloading (the queue
isn't read from HubSpot again), unless it was Next up or a table's last
row, which reload the queue. It's refused once the app has sent, or may have sent,
an email for the task, or it was marked sent: that task finishes through the
send page instead. Send and Mark sent refuse a dropped task, even from a page
left open. When the two overlap, each side writes first (the D1 row, or
`DEFERRED` in HubSpot) and then checks for the other's write, so at least one
of them sees the other. A send or Mark sent that got there first wins: Drop
puts the task back to the status that flow left (Completed if it finished,
else open). Mark sent run again on a finished task re-completes it if HubSpot
shows it open.

Steps 1 and 2 are recorded in D1 (`sent_confirmations`) as they land.
- They run after the page has answered, so you move on while HubSpot is
  written to. See [Saving to HubSpot after the page answers](#saving-to-hubspot-after-the-page-answers).
- A double-click or a retry after an error resumes rather than repeats.
- A CALL task that HubSpot created but D1 never heard about is found by subject
  and reused.
- A per-task lock stops two concurrent runs.

**3. Calls** (`/calls`)

Works through the `CALL` tasks, most of them created by step 2. HubSpot's own
calling needs a paid seat, so the app dials through Twilio and writes the
result back through the CRM API. The call still lands on the contact's
timeline like one made in HubSpot.

- **Queue → Calls to make** (the Queue's second tab, beside **Emails to
  send**) lists every `NOT_STARTED` `CALL` task with the contact's dialable
  number and the company's fit label. The ones due today or overdue are ranked
  like the email queue, and the top one is offered as **Next call**:
  - anyone who clicked a link in an email the app sent them comes first
    (they're warm now)
  - then anyone who opened one, with the time of their last open (below
    clicks, since opens are approximate)
  - then by the `Fit:` line in the company's description: STRONG > GOOD >
    weaker > unlabelled
  - then the most overdue
  - calls with no dialable number, then drop-flagged companies, go last and
    are never offered as Next call.
  - **Upcoming** calls stay soonest due first.
- **Call** (on each call with a dialable number, and on Next call) opens the
  call page and starts calling its first number straight away, the same as
  clicking Call there: your phone rings to press 1, or the browser call
  starts. **Open** only opens the page. The page drops `?call=1` from its
  address before dialling, so a reload never calls again.
- **At a set time**: when someone asks to be called at a particular time, give
  the follow-up (or **Move**) that time. Every call task has a due time anyway
  (09:00, or the email's), so the app marks these with a HubSpot reminder,
  5 minutes before: HubSpot notifies you (the bell, and a push on its mobile
  app). Today's set-time calls sit in their own list above **Due today**, each
  marked "in 40 min", "now" or "15 min late". One is never Next call before its
  time, and from 5 minutes before it, late or not, it's Next call ahead of the
  ranked ones. Calls to make reloads itself then, and logging a call goes to it
  next. One from an earlier day that nobody made is just overdue. A reminder
  set by hand in HubSpot counts too.
- **Move** (on each call that's due) pushes it to another day without logging
  a call. Tomorrow is filled in. The task keeps its time of day (09:00 if it
  has none). Give it a time and it's a set-time call, which can be later
  today; a set-time call moved without one keeps its time. The form sends the
  date itself, not "+1 day", so a double submit lands on the same day.
- **Drop** (on each call in the list, and under the call page's log form,
  after a confirm) is for a call you won't make. The `CALL` task is set to
  `DEFERRED`, which takes it off the queue: no call is logged and no
  follow-up is created. It's refused while any call for the task is live, and
  once the call was logged from the app (that task completes with its log).
  When a log or a dial and a Drop overlap, the call wins, as with Send and
  Drop: Drop puts the task back (Completed for a log, the status the log
  writes itself, so the two never fight over it; open for a dial).
  A dropped task is never dialled or logged: a dial reads the task again
  once it's recorded, before anything rings, and a log once its row is in
  D1, before its first HubSpot write. The call page of a dropped task says so,
  without the log form.
- **The call page** puts what you need on the call in one place:
  - **Where they are**, under the name: the city in large type, the street,
    and a small map, from the company's address (the contact's when the
    company has none), linked to Google Maps. The interview page shows it
    too. The map is Google's keyless embed, so it needs no API key and
    costs nothing.
  - **Call script** comes next: one script shared by every call, for the
    notes you prepare once and reuse. Edit it under **Edit script** on any
    call page. `{first_name}`, `{last_name}`, `{name}`, `{title}`,
    `{company}` and `{my_name}` fill in with the contact's details, and
    `{fit_reason}` with why you picked them: the reason after the rating in
    the company description's Fit line ("Fit: STRONG - runs …"), with no
    final period, and nothing for a drop-flagged company. One with nothing
    to fill in stays as written so the gap shows. Editing is
    hidden while a call is live.
  - **About them**: the contact's title, email, lead status, lifecycle stage
    and location, the company's website, industry, size and description,
    and the CALL task's own description. Prep notes for one prospect go on
    the task or as a note on the contact in HubSpot, and show up here.
  - **HubSpot history**: the contact's notes, logged calls (with the
    transcript summaries this app writes) and emails, newest first, ten of
    each. It's read-only. If one kind can't be read, the page says so and
    shows the rest. Emails need the `sales-email-read` scope (see
    [HubSpot app](#hubspot-app)). Without it, the page shows notes and calls
    and says emails are missing that scope.
- **Call** goes through your own phone or this browser (**Call with** in
  /settings). Either way the contact sees the Twilio number picked there
  (+1 385-255-7051), and the number dialled is read from HubSpot.
- **Edit their numbers** (under the numbers, on call and interview pages)
  saves the contact's Phone (office) and Mobile (personal) in HubSpot, each
  with an extension, as `+1 801-555-0143 x204`. It saves in the background,
  so a call in the browser keeps going and the notes you're typing stay; the
  page reloads to put the new number by **Call** only when neither would be
  lost. An emptied box removes that number. The company's main line is
  changed in HubSpot: the app's HubSpot app can only write contacts.
- **Extensions dial themselves.** An extension after a number in HubSpot
  (`385-555-0100 x204`, `ext. 204`, `#204`) shows next to it, and Twilio keys
  it in two seconds after the line answers (`sendDigits`). If the phone menu
  wants something else first, key it in yourself. A call to an extension is
  never recorded, even with recording on: the notice would play to the
  phone menu, so whoever picks up at the extension wouldn't hear it.
- Through your phone:
  1. Twilio rings your phone, picked on /settings.
  2. You answer and hear who's next. Pressing 1 dials the contact. Nothing
     else dials them, so if your voicemail picks up, no call goes out.
  3. Your phone's keypad works on the call as usual: its tones go through
     to the contact's line, for a phone menu or an extension.
  4. While the call is live the page checks its status every 2 seconds
     (without reloading), then reloads once to show how it ended (their
     answer, busy, no answer, call length) and the log form.
- From the browser, you talk through the call page (Twilio's Voice SDK):
  1. Clicking **Call** dials the contact straight away. The browser asks for
     the microphone the first time; a headset keeps them from hearing
     themselves.
  2. The page shows **Mute**, **Hang up** and a dial pad, with who you're
     calling and how long it's been, and stays put for the whole call, since
     leaving it ends the call. They're docked in the corner (a sheet along
     the bottom on a phone), so the script and history stay readable while
     you talk. When the call ends it reloads to show how it went.
  3. The dial pad (or the keyboard's digits, `*` and `#`) sends touch-tones
     down the call, for a company's phone menu ("press 2 for sales") or an
     extension.
  4. It works in Chrome and Safari on a phone too, but only while the page
     stays open. The screen is kept on during the call, since a locked
     screen or a switch to another app drops the audio. On a phone, calling
     through your phone is the steadier choice.
  5. Each click connects at most one call. A call that doesn't start (the
     microphone was refused, the SDK failed) frees the task to be dialled
     again straight away.
- **Log the call** picks one of HubSpot's standard call outcomes (Connected,
  Left voicemail, No answer, …), takes notes, and a follow-up:
  1. The call is logged on the contact and company, with outcome, notes, length
     and both numbers.
  2. The `CALL` task is set to `COMPLETED`.
  3. A follow-up `CALL` or `EMAIL` task is created on the chosen day, at
     the call task's time of day (09:00 if it has none), or none. A follow-up
     call can have a set time instead (above), even later today.
  4. The contact's Lead Status (free in HubSpot) moves forward: Connected, or
     Attempted to Contact for voicemail, no answer or busy. It never moves
     back, and a status you set by hand (In Progress, Open Deal, Unqualified,
     Bad Timing) is left alone.
- Logging answers straight away and takes you to the next call in today's
  order (Calls to make saves it each time it shows); the steps above run
  after the page has answered. Every call page links to the next call too.
  A call that books an interview is the exception: its steps run first, so
  the page can link to the interview. With no order saved today, or once
  it's all done, you land back on Calls.
- A call made another way (your own phone) can be logged the same way.
- Each step is recorded in D1 (`call_logs`) as it lands, like step 2 above:
  a retry resumes, an orphaned follow-up task is reused, and the call log is
  never written twice (if HubSpot's answer is lost, the app says so instead
  of logging again).
- The number is on the Twilio account's approved Trust Hub profile and
  SHAKEN/STIR product, so calls are signed with "A" attestation (fewer "Spam
  Likely" labels).
- **Recording and transcripts** (off until **Record and transcribe calls** is
  switched on in /settings):
  - When the prospect answers, they hear "This call may be recorded." before
    you're connected. You don't hear it. Several US states require everyone
    on a call to agree to recording, and this notice is how they're told.
  - Recording starts only after the notice has played, just before you're
    connected: Twilio then records each side on its own channel. When the recording is in,
    Deepgram Nova-3 on Workers AI transcribes both channels, so every line is
    labelled You or Prospect, and a small Llama model writes a 3–4 line
    summary.
  - The call page shows "Transcribing…" and swaps in the summary, an audio
    player and the transcript when they're ready, without reloading the page
    (notes you're typing stay put). A failure shows why, with **Transcribe
    again**.
  - The transcript, summary and a link to the recording go into the logged
    call's notes in HubSpot, whether you log the call before or after the
    transcript is ready.
  - The audio stays on Twilio (free up to 10,000 stored minutes) and plays
    through the app, behind Access. It's never public.
  - Cost: $0.0025/min for Twilio recording. Transcripts and summaries use the
    free Workers AI allowance (10,000 neurons a day, about 20 minutes of
    audio). Past it, transcription fails until the next day; **Transcribe
    again** then works.
- The call is logged with the task's owner as the caller, and the follow-up
  goes to the same owner. HubSpot's docs say logged calls update the
  contact's Last contacted and Last activity dates; confirm it on the first
  live call, since they don't say whether that includes calls logged by API.
- Cost: Twilio's per-minute rate for both legs, plus the number. From the
  browser, your leg is a Voice SDK leg, which costs less per minute than
  ringing your phone. No HubSpot plan change: calls are covered by the
  contacts scopes the app already has.

HubSpot's search index trails a write by a few seconds, and a send's or
logged call's HubSpot steps finish after the page has answered. So the queue
and Calls leave out tasks sent, marked sent, dropped or logged through the app
in the last two days (from D1), and after a Drop or Move the redirect says which task
changed and the page applies it, so the task doesn't reappear.

### Saving to HubSpot after the page answers

Sending an email, marking one sent and logging a call answer as soon as the
part you wait for is done (Gmail took the email; the call's outcome and notes
are recorded), and write the rest to HubSpot afterwards (Cloudflare's
`waitUntil`, up to 30 seconds after the response):

- The lock is taken before the page answers, so a second click still gets
  "already being logged".
- Each HubSpot step is recorded as it lands, as before, so a failed or
  interrupted run is finished by running it again, never repeated.
- A notice at the top of every page (fetched after the page shows) says
  what's still saving, and what didn't finish and why, with a way to finish
  it: **Open the call** (its form keeps what you entered) or **Finish it**
  for an email. It covers the last week.

### Calls to the Twilio number

Anyone calling the Twilio number is forwarded to your phone (the one picked in
/settings), with the same recording and transcripts as calls you make:

1. The app looks the caller up in HubSpot by number: a contact whose Phone or
   Mobile is that number, however it was typed. When recording is on, the
   caller hears "This call may be recorded." first.
2. Your phone rings showing the caller's number. When you pick up you hear
   "Call from Jesse Ferris at Ferris Freight" (or the number read out), and
   pressing 1 connects you. Recording starts then, one channel per side.
3. If you don't answer or don't press 1 (so your own voicemail can't take
   the call), the caller hears a greeting and can leave a message of up to
   three minutes, recorded by Twilio. Voicemails are always recorded and
   transcribed: leaving one is the caller's choice.
4. When the caller hangs up, a call from a HubSpot contact is logged on the
   contact (and their company) as an inbound call: "Call from", "Voicemail
   from" or "Missed call from", with its length and a link back to the app.
   The transcript and summary are added when they're ready. Like
   `call_logs`, the log is written once: a lost answer from HubSpot is never
   retried into a duplicate.
5. **Calls** in the app lists these calls with the rest (see Calls: every
   past call, below; **Inbound** there shows only them), and the ones you
   haven't returned wait in the Queue (Waiting on a call back): who called (the HubSpot
   contact, else the caller ID name, else the number) and where the number is
   registered ("Salt Lake City, UT", which Twilio sends free with every
   call). A missed call says how long they stayed on the line. Each call's page has the audio
   player, summary and transcript, the other calls from the same number, and
   whether it reached HubSpot. Callers who aren't in HubSpot are only listed
   there; opening one looks the number up again, so a call from a number
   added to a contact since is then logged on them.
6. **Call back** on a call's page calls them from the Twilio number, so they
   see the number they called, not yours: your phone rings and pressing 1
   dials them, or you talk through the page (Settings → Calling), recorded
   and transcribed like any other call. The number dialled is the one Twilio
   reported for the call, never one from the form. A call back to a HubSpot
   contact logs itself on them as an outbound "Call back to …" once Twilio
   reports how it went (connected, busy or no answer, and its length), with
   the transcript added when it's ready; there's no form. Like the inbound
   log, it's written once.

The caller ID name is only sent when **Caller Name Lookup** is on for the
number in Twilio (Phone Numbers → the number → Voice configuration), which
Twilio bills per incoming call; the app doesn't turn it on. The app's pages
also tell phones not to turn numbers into tap-to-call links, which would dial
from your own phone instead of the Twilio number.

### WhatsApp

Calls and messages go through your own WhatsApp, not an API. A call task's
**Numbers** card has a **WhatsApp** button next to Call for the contact's
Phone and Mobile. It doesn't appear for a number with an extension (an office
line) or the company line. The button opens the chat in the WhatsApp app
(`whatsapp://send`), or WhatsApp Web if you pick that in Settings, with an
opener written in from `src/prompts/whatsapp-messages.ts`. You send it there,
or call them from the chat; the app never sends anything itself.

The log form then asks how you reached them: **Phone call**, **WhatsApp
call** or **WhatsApp message**. Clicking the button already picks WhatsApp
message and puts the opener in Notes: edit it to what you actually sent.
- **WhatsApp message.** Its outcome is "Sent, no reply yet" or "They
  replied". It goes on the contact as a HubSpot WhatsApp message (a
  communication), not a call.
- **WhatsApp call.** It takes the call outcomes and is logged as "WhatsApp
  call with …". It has no length or recording: WhatsApp doesn't share them.

After that it's the same workflow as any call: the task is completed, the
follow-up created and Lead Status moved on. "They replied" counts as
Connected. It's all written once, like any logged call.

Calls lists WhatsApp calls and messages with the rest. The contact page's
**WhatsApp** opens their call task at the button. Interview pages have the
button too, with a note checking the time still works. Outside 8am to 8pm by
your clock the button warns you: Florida's telemarketing law (the FTSA) only
allows calls and messages to people in Florida within those hours, their
time.

Why not WhatsApp's API, through Twilio or Meta:
- Meta doesn't deliver a business's first (marketing) message to US numbers,
  and has paused it since April 2025.
- A US business number can't place WhatsApp calls.
- Each message costs money.

The links cost nothing and work for a first message. The catch is that
replies stay in WhatsApp: log them by hand.

### Interviews

A call that books an interview becomes a HubSpot **meeting**: a record on the
contact (and company) with a start and end time, a join link, notes and an
outcome (Scheduled, Completed, No show, Rescheduled, Canceled). A `CALL` task
is only a to-do. **Interviews** in the app lists them from a week back to two
weeks ahead.

1. **Book it.** On a call's page, tick **Booked an interview** when you log a
   connected call, and give the date, time, length, and whether it's a
   **phone call** (the default) or a **video call** (optionally with a Meet
   or Zoom link). Or use **Book an interview** on the same page for one set
   up another way. That leaves the call task open. Either way the meeting is
   created once: a retry first looks for the same meeting on the contact.
   - **A phone call** is on the contact's first number in HubSpot (phone,
     mobile, then the company line), picked when it's booked. The meeting's
     location says "Phone: +1 …" and it has no join link. Booking one for a
     contact with no number is refused.
   - **Send a calendar invite** (optional) invites the contact from the
     connected Google account. A phone call's invite says you'll call them at
     that number. A video call's has a Google Meet link unless you gave one,
     and the Meet link goes on the meeting. The invite's id comes from the
     booking, so it's never sent twice. Moving or canceling the interview
     from the app moves or cancels the invite too, and Google tells them.
   - A time that has already passed (earlier today, say) is refused.
2. **See it.** The call list marks a call whose contact has an interview
   coming up ("Interview Fri, Sep 26, 10:00 AM"), and so does the call page.
3. **Prep.** Each interview's page has the time, a **Join** button, the
   interview questions (`src/prompts/interview-questions.ts`, yours to edit),
   and the calls and notes already on the contact, research notes included.
   **Call them** dials the contact the same way as a call task (your phone
   first, or the browser), recorded and transcribed when recording is on.
   For a phone interview there's no Join, and **Call them** comes first.
4. **Log it.** After it: It happened, No show, Moved to another time, or
   Canceled (and who canceled: they did, or you did; kept in D1 only, since
   HubSpot's outcome is Canceled either way), your notes, and an optional
   follow-up task. Like `call_logs`,
   each write is recorded in `meeting_logs` as it lands, so a retry resumes:
   1. the meeting gets the outcome, and your notes (and the call's summary
      and transcript, if you called from its page) are added to its internal
      notes. A moved interview gets its new time instead, and can be logged
      again once that comes round. A log that stopped partway after the move
      resumes rather than starting a second one.
   2. the contact's calendar invite, if the app sent one, is moved or
      canceled to match.
   3. the follow-up task, if any, at 09:00 on the day you pick.
   4. Lead Status moves to Connected if it happened or was moved.

### When they don't show

A missed interview is usually a mix-up or a busy morning, so the follow-up
assumes that: short, no blame, and two easy ways back. The emails are
templates in your voice (`src/prompts/follow-up-emails.ts`, yours to edit),
not Claude, and the draft page leaves Claude out for them.

1. **Log it as No show.** The follow-up switches to an **Email** due today,
   created with its draft written: "sorry we missed each other", another
   time (a phone interview: "I can just give you a call"; a video one: "happy
   to just call you instead"), or 3 quick questions by email. The draft is
   stored with the log, so a retry writes the same one.
2. **Send it.** It's at the top of the queue: follow-ups due by today (after a
   call, an interview or a missed one) rank ahead of cold outreach, and a
   drafted one is the next to send. Sending creates tomorrow's `CALL` task,
   as any send does.
3. **Call.** The call page says they missed their interview. If the call
   doesn't reach them, the log form's follow-up is already on **Email: last
   try**, created with the "closing the loop" draft: you'll leave it here, and
   they can reply whenever. After that, let it rest.

### When they cancel

A cancel is a reply: they told you ahead instead of leaving you waiting, so
the line is open. Log it as **Canceled**, with **They did** under who
canceled (the default). The follow-up switches to an **Email** due today,
drafted from the same templates: "thanks for letting me know", another time
(a phone interview: "tell me a time and I'll give you a call"), or 3 quick
questions by email. Before your next call to them, the call page's coaching
says they canceled and the line is open. Coaching counts their cancels apart
from no-shows, and leaves the ones you canceled out of the held rate.

Times are in your time zone, picked on /settings (the `TZ` var until then).

### Contacts and companies

**Contacts** and **Companies** in the nav list HubSpot's records, most recently
updated first. Search by name, email, phone, company or domain (HubSpot's own
search). Each shows 50 at most: search to narrow it down.

- **A contact's page** has their details, their full address (with a Google
  Maps link), their company (Fit label, description, main line, address),
  their tasks (open, and the latest completed), interviews, the last email
  sent from the app, and their HubSpot history: notes, calls and emails.
- **A company's page** has the same details, its contacts and its tasks.
- **Call** opens the contact's open call task, or creates one due now, and
  goes to its call page: the script, calling, the log form and the follow-up
  work as for any call task.
- **Email** opens the contact's open email task, or creates one, and goes to
  its draft page: draft by hand or with Claude, then send as usual (which
  creates the next day's call).
- Details are read-only. Every page links to the record in HubSpot for
  edits.
- The call, interview and inbound pages link to the contact and company pages.

### Calls: every past call

The **Queue** is the work: **Emails to send** and **Calls to make**. The
Queue link opens the tab you were last on, so while you work through calls it
takes you straight back to Calls to make. **Calls** is the record: every call newest first, the ones you made from a call task,
an interview or a call back, the calls to the Twilio number (answered,
voicemail or missed), and the calls you logged from a task without dialling
from the app.

- Each call shows who and when, how it went (what Twilio saw, and the outcome
  you logged), the transcript's summary and your notes. **Transcript &
  recording** opens the full transcript and the audio player in place.
- **All calls · Inbound · Outbound** filter by direction. The search box looks
  through names, numbers (by their digits, so "(801) 555" works), summaries,
  your notes and what was said in the transcripts. Each result shows where
  the words turned up, marked: the summary line, your notes, or who said it
  and when ("Prospect at 0:04").
- **Open** goes to the call's own page: the call task (which keeps the
  recording, transcript and the contact's HubSpot history once the task is
  completed), the interview, or the inbound call. A failed transcription is
  retried from there.
- It reads only D1, so it never waits on HubSpot. `/inbound` redirects here.

**Waiting on a call back** sits at the top of Calls to make: missed calls and
voicemails from the last two weeks you haven't returned, one per number, with
the first line of the voicemail's summary. A caller leaves the list once
their number is dialled from the app (Call back, or a call from a task or an
interview, once you press 1 or the browser call starts: a call you never
confirmed leaves them waiting), they call again and you answer, or you
**Dismiss** them (a wrong number, a robocall). **Call back** opens the call's page at its Call back
button. The Calls to make tab shows how many are waiting, from either tab.

### Coaching

Every call you log from a call task is read in the background, after you've
moved on, for:

- the **phone menu**: how long it took before a person answered, and the
  digit it gave for them ("press 4 for Grant");
- **who answered**: them, the front desk (by name, from "this is Nina"), or
  voicemail;
- what the **front desk** did: put you through, sent you to voicemail, said
  they're not available, put you on hold and they never came on, took a
  message, or turned you away ("email only");
- whether you **reached** them, and the **talk time** from when they came on;
- **how far it got**: the front desk, the opening, a real conversation, a next
  step agreed (a time to talk, their number, a booked interview);
- the **objection**, in their words: a sales call, busy, send an email, our
  problems aren't software, wary of a stranger, already have something, not
  the right person, not now, not interested.

Rules read it, turn by turn, from the transcript when the call was recorded
(the rep on one channel, everyone on their end on the other, so the menu,
the front desk, voicemail and them are told apart by what's said: the rep
asking "is Hank available?" is talking to the front desk, a voicemail
greeting after a hold is being sent to voicemail). A call that wasn't
recorded is read from your notes ("Talked with Nina…" is the front desk,
"not available" wasn't them), then from the outcome: "busy" reads as not
available and "connected" only as someone picked up, both marked unsure. The
outcome settles no answer, voicemail and a wrong number. The auto-summary is
never used: it often gets who said what wrong. Each reading lists the tags
the rules only guessed at (`unsure`) and who decided each (`sources`), for
a review to settle (below). A transcript keeps Nova-3's punctuation, which
is how your questions are counted; the rules read a plain copy of it, the
same as transcripts from before it was kept.

**Reviews, from a Claude chat.** Ask Claude to review your calls: it lists
the ones worth a review with `calls_to_review` (someone picked up, nobody
reviewed it yet), reads each with `get_call_review` (the transcript with
times, your notes, the tags so far, and the rules for reviewing it, in
`src/prompts/call-review.ts`), and saves what it found with `review_call`:
corrections for the tags that were wrong or unsure, the Mom Test on the call
(did you ask about a specific last time, did you pitch, their longest story
in seconds, did you catch the fluff and bring it back to a real instance,
what they gave up at the end: their time, an intro, money), what worked, and
what to adjust. The rules take a first pass at the Mom Test from the words
(a question about the last time, a pitch, how long they talked, a time or an
intro agreed) and mark the rest unsure; whether you caught the fluff only a
review can say. A call reviewed before the review rules could answer a tag
(`REVIEW_RULES_VERSION`, bumped when `review_call` gains one) comes back to
`calls_to_review` for it. Your recorded interviews are read and reviewed the same way
(`calls_to_review` lists them as `kind: interview`; the id is the meeting's):
the call made from the interview's page, once it ended, with how you logged
the interview (its outcome, and your notes when there's no recording). They
sit apart from the cold calls in coaching's counts, and the interview's page
shows the same Coaching card for its call. On your Claude plan, so it costs nothing extra. A review is kept in
`call_reviews` (one per reviewer, replaced whole) and laid over the rules'
reading every time the call is read, so the sweep never undoes it; yours
(`reviewer: 'rep'`, when you tell Claude what happened) wins over Claude's.

Nothing interrupts a call. The notes sit in a **Coaching** card on the call
page, under the script:

- **After the call with …**: when you log a call and land on the next one,
  the call drawn to scale (a strip: the phone menu, the front desk, the hold
  and them underneath, your turns ticking above the middle and theirs below,
  a taller tick for a story of a minute or more, dots for your opening, their
  objection and the next step, and the same in words after it; from the
  transcript, or one segment as long as the call without one), the tags in a
  line (with what it wasn't sure of), then what to adjust from
  the last: a connect under 1:30 of talk that left with no next step ("leave
  with a time"), stopping at the front desk (by name, what they did, and what
  to try for that), the menu digit for next time, an objection it didn't get
  past (with what to try), a call that never got past the opening, and a long
  connect as a bright spot. A completed task's page shows its own.
- **Before this call**: what time it is for them and how that hour has gone
  (and your best hour), how the last call with them went, the front desk at
  their company by name with the line that has got you through before, the
  objection to expect with an opening that got past it, their last
  interview if it was canceled (by them: the line is open, offer another
  time), rushed connects piling up lately, and what your longest connect did.

**Coaching** in the navbar has the patterns across every call, in two halves,
with the tables that need more calls parked under them:

**Earning the conversation**: getting past the menu and the front desk to the
person, and leaving with a next step.

- How far your calls get, as bars: calls, someone picked up, reached them, a
  next step agreed, an interview booked on one of those calls (counted by
  call), an interview held. Counts, not
  rates, so they hold at any number of calls, and the step that loses the
  most (at least 40% of the one before) is named with what to try.
- The interviews your calls booked, followed to how each turned out: held,
  no-show, canceled by them (they told you ahead: a reply, unlike a no-show)
  or by you, still ahead, or past its time with nothing logged (listed, to
  log on Interviews), and how many were moved. By how far ahead it was
  booked, with a calendar invite or not, and how long you talked on the call
  that booked it, each with the share held (your own cancels left out). From the outcomes logged on
  Interviews (`meeting_logs`); one set straight in HubSpot isn't seen.
- The front desk as its own category: how often it put you through, what it
  did otherwise (as bars), by name, and what you said when it put you through.
- Objections, most common first, in their words, with the openings that got
  past them.
- Your last twenty calls drawn to scale, one above the other on one scale
  (the longest is the full width), each linking its page: where each call
  went and where it ended, at a glance.

**The conversation**: once you reach them, the Mom Test.

- The Mom Test, call by call: on every call and interview that reached them,
  newest first, whether you asked about a specific last time, whether you
  pitched, their longest story (a minute or more is a story), whether you
  caught the fluff, and what they gave up at the end (their time, an intro,
  money), with the counts above the table and the longest story named. A
  dash is nothing said yet, not a no: the rules hear some of it on a
  transcript, a review settles the rest.
- Who did the talking: on each recorded call that reached them, their share
  of the words against half (on an interview they should do most of it).
- Long connects (5 minutes or more of talk): what worked, the opening, what
  was agreed, and how you talked on recorded ones against short ones (their
  share of the talking, your questions, "you" over "we"), from their part of
  the call.
- Rushed connects: under 1:30 of talk with no next step, listed.
- What to adjust, call by call: your last calls with their tags and the
  notes on each.

**When there are enough calls** (folded away until then): reached rate by
hour of their day (in the contact's time zone, from their state or their
company's; unknown counts in yours), with groups under three calls marked as
too few; until two hours have about 30 calls each it says it's too early to
pick one, and no best hour is named, here or before a call. And follow-up
timing: by the gap since the last call, how often the next call reached
them, after a connect (a second connect) and before one.

**What you've heard**, Coaching's second tab, is the point of the calls: what
they've told you, across every call and interview that reached them, read by
rules from their part of each recording and from your notes on the call or
the interview.

- The software they use: named tools of the trade (McLeod, TMW, Truckstop,
  DAT, Samsara, Motive, QuickBooks, spreadsheets and the rest) and the ways
  of working that stand in for one (a load board, a TMS, an ELD, something
  in-house, paper, phone and text), each with how many calls named it and
  the newest quotes.
- What they said about their work, by theme: quoting and rates, dispatch and
  loads, invoicing and getting paid, drivers and people, compliance and
  safety, the software they use. Each with how many calls touched it, how
  many of those hurt (a line that names a problem, time lost, a mess), and
  the quotes, the ones that hurt first. Your notes count when they report
  what they said or do ("He said they use QuickBooks"), not your own plans.
- Call by call, newest first.

Counts of calls, never rates, and every quote links its call. The synthesis
(what keeps coming up, what to ask next, whether to narrow the segment) is
yours to do with Claude: `what_you_heard` hands it the same.

On **Calls**, each logged call shows its strip and its tags too, with **Leave
out of coaching** for a test call (and **Put back in coaching**).

It reads only D1 (`call_insights`, one row per logged call, replaced when a
better source arrives or the rules change; the bookings from `call_logs`,
`meeting_bookings` and `meeting_logs` as they are), so it never waits on HubSpot and
writes nothing to it. A **cron sweep** every 10 minutes keeps it read: it
runs again any transcription that died (stuck "transcribing" for over 5
minutes, or never started), then reads up to ten calls not read yet, read
from the notes before their transcript arrived, or read by older rules
(`RULES_VERSION` in `lib/call-insight.ts`: bump it and every call is read
again, for free). Opening Coaching also reads a few. The connector's
`call_coaching` tool returns the same report, and `get_call_task` carries
the coaching before the call (tips, the last call, the front desk and phone
menu at their company, their time now) and after it (the tags, their
sources, what's unsure, and what to adjust).

### Today's counts

The Queue, Calls and Interviews pages open with three counts for today
(midnight to midnight in your time zone), and a fourth that isn't today's:

- **Emails sent**: sent from Gmail through the app, plus those you marked sent
  after sending from HubSpot. An email sent from HubSpot and never marked sent
  isn't counted.
- **People called**: distinct contacts the app dialled (you pressed 1, or
  clicked Call in the browser, whether they answered or not), plus anyone you
  logged a call with, so a call from your own phone counts once logged.
  Inbound calls aren't counted.
- **Interviews**: today's HubSpot meetings logged as Completed, with how many
  are still scheduled. It shows "—" if HubSpot's meetings can't be read.
- **Real conversations**: every one so far, out of 100, with the last thing
  you learned under it (see below).

### Real conversations

The goal is 100 people who told you about their work: what they do, what it
costs them, what's hard. A pick-up isn't one, and neither is a friendly no.
You decide which calls count; the app only keeps the tally.

- **On the log form.** A call that connected (or a WhatsApp message they
  replied to) and an interview that happened have a box: *Real conversation:
  they talked about their work, and you learned something*, and one line,
  *What you learned*. The box comes ticked for an interview that happened and
  for a call that connected and ran 5 minutes or more; untick it if it wasn't.
  Left blank, the line is your notes' first sentence.
- **On Coaching.** The **Real conversations** card, at the top, lists each
  one: who, when, the line, and Uncount. Under it, **Reached them, not
  counted yet**: the calls coaching heard reach the person, each with its
  notes' first sentence ready to keep or change, and Count. That's how a call
  logged before the box existed gets counted.
- **The pace.** How many logged calls it has taken per conversation, and
  about how many more calls the rest will take at that rate.

People, not calls: a second conversation with someone already counted adds
nothing to the number. D1 only (`conversations`); nothing goes to HubSpot.
The connector's `log_call` and `log_meeting` take `real_conversation` and
`learned`, and `today` returns the count.

### Claude connector

The app is also a custom connector for Claude (claude.ai on the web, the
desktop app and the phone), so you can work the queue from a chat, on your
Claude plan rather than the API. It's a remote MCP server at `/mcp`: Claude
calls tools that act as you, through the same workflows, checks and audit log
as the pages.

- **Reads:** `today` (counts, the next email and call, today's interviews,
  anything unfinished), `email_queue`, `call_queue` and `meetings` in the
  app's own order, `search_contacts`, `search_companies`, `get_contact`,
  `get_company`, `get_email_task` (with the research context),
  `drafting_rules` (the same rules as Draft with Claude), `get_call_task`
  (the call script filled in, history, coaching), `call_coaching` (the
  patterns across every call), `calls_to_review` and `get_call_review` (a
  logged call to review, with its transcript and the review rules),
  `what_you_heard` (the software they use and what they said about their
  work, by theme, with every quote), `get_meeting` (prep and the interview
  questions), `recent_inbound_calls` and `unfinished`.
- **Writes:** `save_draft`, `mark_email_sent`, `drop_email_task`, `log_call`,
  `snooze_call`, `drop_call_task`, `review_call` (a call's review for coaching, in the app
  only), `book_interview` (never with a calendar invite: send one from
  the interview's page), `log_meeting`, `open_task_for_contact` and
  `save_contact_numbers` (phone and mobile, with extensions). Each is
  safe to repeat, like the pages' buttons, and each is in the audit log under
  your email.
- **Not from Claude:** sending an email and placing a call. Every result
  carries the page's link, so Claude hands you the send page or the call page.

Connecting is OAuth: Claude registers itself, sends you to `/authorize` (behind
Cloudflare Access, like every page), and **Connect** there gives it a token
for `/mcp` that acts as you. Only Claude's own callback can receive a token.
To disconnect, remove the connector in Claude's settings.

### Upwork pitches

A Chrome extension in `extension/` for pitching Upwork jobs. Copy the Loom
link for the job, click into the proposal box, and press the shortcut
(Alt+Shift+P by default; change it at `chrome://extensions/shortcuts`):

- **Paste.** Your pitch, from the extension's options page, lands at the
  cursor with the Loom link in place of `{{loom}}`, typed as if by hand, so
  Upwork's form sees it and Ctrl+Z takes it back. Nothing is pasted unless the
  clipboard holds a Loom share link.
- **Log.** Once pasted, the extension posts the job to `POST /pitches`, which
  makes one HubSpot deal per job: in the Sales Pipeline's first stage, named
  "Upwork: <job title>", marked `deal_source = Upwork`, with the job and Loom
  links in its description. Pressing it again on the same job finds that deal
  (`upwork_job_id` is a unique-value property) and never moves it back a stage.
- **The icon.** Clicking it shows what's set up: whether your pitch is saved,
  whether you're signed in to the Causeway it logs to, and whether the tab is
  an Upwork job. It wears a "!" until the pitch is saved, and installing it
  opens the options page.
- **When logging fails** (offline, signed out, Causeway down), the pitch is
  kept until the browser closes. The next press on that job logs it without
  pasting it again, and the icon's panel has **Log now** for all of them.
- **Where it answers.** A note in the page's corner: logged, with a link to
  the deal; already logged; or why not. A page without a job (Upwork
  messages, say) is pasted into but not logged.
- **Sign-in.** It uses your Cloudflare Access session, the one you get by
  signing in to Causeway with Google, so there's no token to keep in the
  extension. When that session has expired, the note says so with a link to
  sign in; then press the shortcut again.
- **Upwork's terms.** It only types what you'd paste yourself, when you press
  the key. It never submits a proposal or reads more than the page you're on,
  and the deal has no contact yet: talking to the client stays on Upwork.

## Speed

Every page reads HubSpot, so the app keeps the number of HubSpot requests made
one after another low:

- A record comes back with the ids of what it's linked to in one request, and
  the contact and company are read together, so a call page, interview page
  or draft page waits on three rounds of HubSpot requests (it was 6 to 9).
- The Worker runs near HubSpot and D1 (Smart Placement), not near you, so
  each round trip is short.
- The Google access token is reused until it's about to expire, instead of
  refreshed before every send.
- HubSpot writes after a send or a logged call run after the page answers
  (above), and you land on the next one without the list in between.
- The next call or email loads before you click (Chrome's speculation rules),
  and a list's links and the navbar load on hover. The Queue's tabs don't:
  opening one is what remembers it for the Queue link, and a prefetched page
  opens without a request of its own.
- Pages crossfade into each other (cross-document view transitions, Chrome
  and Safari) instead of flashing blank, with the header kept in place.
- During a live call only the call's status is fetched, not the whole page.
- Each HubSpot request and each page logs its time to Workers Logs, and pages
  send a `Server-Timing` header (devtools → Network → Timing).

## Layout

```
src/
  worker.ts              entry point: OAuthProvider for the Claude connector in front of the app
  index.ts               Hono app, error pages
  middleware/access.ts   Cloudflare Access JWT check + same-origin POSTs
  middleware/timing.ts   each page's time, to Workers Logs and Server-Timing
  routes/                queue (GET /), draft, send, sent, next-email, drop, calls, meetings, dialing
                         (shared by both), unfinished (the notice), twilio (webhooks), authorize
                         (approving the Claude connector), pitches (the Upwork extension), coaching
  actions/               what the pages and the connector both do: log a call, save a draft, …
  mcp/                   the Claude connector: app (POST /mcp), tools, format
  workflows/             draft-email, email-sent, email-queue, dial, call-logged, call-queue, call-context,
                         task-actions, transcribe, parties, meeting-queue, meeting-logged, book-interview,
                         pitch-logged, call-insight (reading a call for coaching)
  prompts/               draft-system (Claude's drafting rules), interview-questions (the prep page)
  lib/                   hubspot, twilio (fetch wrappers), ai (Workers AI), twiml, phone, transcript,
                         voice-token, call-script, fit, richtext, dates, prompt, work-plan, upwork, background, db,
                         call-insight (one call), coaching (the patterns), conversations (the 100)
  views/                 hono/html templates
migrations/              plain SQL for D1
test/                    node:test via tsx
hubspot/                 HubSpot developer project (scopes), deployed with the hs CLI
extension/               the Upwork pitch Chrome extension (npm run ext:build → extension/dist);
                         shares src/lib/upwork.ts with the Worker
```

## HubSpot app

This is a Developer Platform project app in `hubspot/`, with private
distribution and static-token auth. It's installed in account `247260710`.
The static token is on the app's **Distribution** tab (not Auth).
- Scopes live in `hubspot/src/app/app-hsmeta.json`:
  - `crm.objects.contacts.read`
  - `crm.objects.contacts.write`
  - `crm.objects.companies.read`
  - `crm.objects.deals.read`, `crm.objects.deals.write` (Upwork pitches)
  - `sales-email-read` (the HubSpot history's emails)
- Tasks and notes have no scopes of their own. The contacts scopes cover
  reading and writing them (confirmed against the account). Meetings are the
  same: searching them works with these scopes (confirmed 2026-09-25).
- Calls are covered the same way (the app logs and reads them today).
  Emails aren't: without an email scope, HubSpot answers 403
  `MISSING_SCOPES` and the history shows notes and calls only. HubSpot
  suggests `crm.objects.emails.read`, but it isn't available to this app (the
  deploy fails), so the app asks for `sales-email-read` instead. A new scope
  takes effect once it's approved on the install after `npm run hs:upload`.
- Any other request refused for a missing scope shows an error page naming
  the scopes HubSpot asked for.

```bash
npm run hs:upload   # deploy scope changes
npm run hs:open     # app page: install, Auth tab for the static token
```

## Setup

```bash
npm install
cp .env.example .dev.vars          # the other secrets (Gmail, Claude, Twilio)
                                   # + .dev.vars.test for the test CRM (below)
npm run db:migrate:local
npm run dev                        # http://localhost:8787 against the test CRM (Access bypassed on localhost only)
                                   # --local: Workers AI (transcripts) only runs on Cloudflare
```

In a worktree (`.claude/worktrees/<name>`), run `npm run worktree` first. It
links `.dev.vars` and `.dev.vars.test` to the main checkout's, installs
`node_modules`, copies the main checkout's local D1 and applies the branch's
migrations, skipping whatever is already there. It also rewrites the main
checkout's `.claude/launch.json` (gitignored, generated) with a `dev:<name>`
entry for every worktree. The desktop app's preview reads launch.json from the
folder the session was opened in and runs there, so a worktree is previewed
through its own entry (`cwd` into the worktree), not `dev`.

### Test CRM

Local dev works on a HubSpot developer test account, `isthmus-test`
(247548603), not the live CRM. It's a free, separate portal under the live
account (Development → Test accounts), with the app installed in it and its
own fake prospects. The deployed Worker is the only thing that uses the live
CRM. Sandboxes would copy the live account's setup, but HubSpot only offers
them on Enterprise.

- `npm run dev` loads `.dev.vars`, then `.dev.vars.test` over it, so the
  HubSpot token and portal are the test account's while Gmail, Claude and
  Twilio keep their `.dev.vars` values. `scripts/require-test-crm.mjs` stops
  it before Wrangler starts if `.dev.vars.test` is missing, lacks the token
  or portal, or names the live portal. Wrangler alone would only log the
  missing file and carry on with the live token.
- `npm run dev:live` is the old behaviour, against whatever `.dev.vars`
  points at. Use it only on purpose.
- `npm run seed:test` fills the test account with six made-up trucking
  prospects: companies with a Fit line (STRONG through a DROP), a contact
  each, four EMAIL tasks (one already drafted), two CALL tasks and an
  interview. It's safe to re-run, and it refuses to run with a token that
  isn't for a developer test account. Their emails are plus-addresses of
  isthmusglobalholdings@gmail.com, so a test send lands in your own inbox.
  Their phones are 555-01xx, which are never assigned.
- Sends, drafts and calls are still real: Gmail sends, Claude costs a few
  cents a draft, and Twilio can't reach localhost anyway.

`.dev.vars.test` (gitignored, next to `.dev.vars`; in a worktree, a symlink to
the main checkout's, like `.dev.vars`, made by `npm run worktree`):

```
HUBSPOT_ACCESS_TOKEN=pat-na2-…   # the app's test install token
HUBSPOT_PORTAL_ID=247548603
```

The token is on the app's Distribution tab (`npm run hs:open`) → **Test
installs** → isthmus-test → Show / Copy. A scope change uploaded with
`npm run hs:upload` has to be approved on the test install too (**Add test
install(s)** → isthmus-test → Install).

To recreate the account (a test account expires after 90 days with no API
calls; running the app against it counts):

```bash
cd hubspot && hs test-account create --config-path ./test-account.json
```

Then add the test install, write its token to `.dev.vars.test`, and run
`npm run seed:test`. The seed imports its companies with the HubSpot CLI,
because the app's token can read companies but not create them. The CLI
signs in to the new account when it creates it.

### Gmail sending (one-time)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and
   create a project. No billing is needed. Then go to **APIs & Services →
   Library** and enable the **Gmail API** and the **Google Calendar API**
   (interview invites).
2. Set up the **OAuth consent screen**:
   - User type **External**, app name e.g. "hubspot-automations".
   - Scopes: `openid`, `email`, `.../auth/gmail.send` and
     `.../auth/calendar.events`.
   - Add isthmusglobalholdings@gmail.com as a test user.
   - Then **Publish app** (status "In production"). In testing mode Google
     expires the sign-in every 7 days. Unverified is fine for your own
     account: you'll see a warning screen once. If a send or an invite says
     the Google connection expired or was revoked, reconnect Gmail in
     Settings; if that keeps happening a week apart, the app is still in
     testing mode.
3. Create an OAuth client under **Credentials → Create credentials → OAuth
   client ID → Web application**, with these authorised redirect URIs:
   - `https://hubspot-automations.frosty-darkness-3dd3.workers.dev/oauth/google/callback`
   - `http://localhost:8787/oauth/google/callback`
4. Put the client ID in `wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`, then set the secrets:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put TOKEN_ENCRYPTION_KEY
   ```
5. Open /settings, click **Connect Gmail**, and sign in as
   isthmusglobalholdings@gmail.com. Paste your HubSpot signature HTML there too.
   A connection made before interview invites existed can send email but not
   invites: click **Reconnect** once to allow both.

### Draft with Claude (one-time)

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

It costs a few cents per draft (tokens plus up to 5 web searches).

### Claude connector (one-time)

```bash
npx wrangler kv namespace create OAUTH_KV   # put its id on the OAUTH_KV binding in wrangler.jsonc
npm run deploy
```

Give Access its Bypass paths for the connector (see Production), then in
Claude: Customize → Connectors → + → Add custom connector, named "Causeway",
with `https://hubspot-automations.frosty-darkness-3dd3.workers.dev/mcp`. Leave
Advanced settings (OAuth Client ID and Secret) empty: Claude registers itself
at `/oauth/mcp/register`. Adding it doesn't connect it: Claude lists it as
needing sign-in until you click Connect on it. Claude then opens `/authorize`;
sign in with Access and click **Connect**. The connection then shows on
/settings, and each approval is in the audit log (`workflow = 'connector'`).
Renaming it later means removing it in Claude and adding it again.

Locally, `npm run dev` serves the same flow on `http://localhost:8787/mcp`
(Access is bypassed there), and a local app such as the MCP Inspector
(`npx @modelcontextprotocol/inspector`) may connect to it.

### Upwork pitch extension (one-time)

1. **HubSpot**, in the test account first, then the live one:
   - `npm run hs:upload`, then approve the deal scopes on the app's install.
   - Settings → Properties → Deal properties, create two:
     - **Upwork job ID** (`upwork_job_id`): single-line text, with **Require
       unique values** on. That's what keeps a job to one deal.
     - **Deal source** (`deal_source`): dropdown select, with the option
       `Upwork` (internal value `Upwork`).
2. **Build and load:** `npm run ext:build`, then at `chrome://extensions` turn
   on Developer mode, **Load unpacked**, and pick `extension/dist`. After a
   rebuild, press the extension's reload button there.
3. **Options** (right-click the extension → Options): write your pitch with
   `{{loom}}` where the link goes, and pick where to log: Causeway (the live
   CRM) or local `npm run dev` (the test CRM).

The extension's ID is pinned by the `key` in `extension/manifest.json`
(`ddbojhokkfndnhnngibgnilicbeghkof`), and `PITCH_EXTENSION_ID` in
`wrangler.jsonc` names it: that origin, and no other, may `POST /pitches`. A
new key means a new ID, so change both together. If a toast says Causeway
refused the extension, either they don't match or that Causeway runs code from
before `/pitches` (a dev server started from an older checkout, say).

### Calling through Twilio (one-time)

The account SID is already in `wrangler.jsonc`. The auth token is the one
thing to add. The Worker uses it to start calls and to check that webhooks
really come from Twilio. Copy it from Twilio Console → Account info (the
Twilio CLI's API key can't read it).

1. Local: add `TWILIO_AUTH_TOKEN=…` to `.dev.vars`.
2. Deployed Worker:
   ```bash
   npx wrangler secret put TWILIO_AUTH_TOKEN
   ```
   Or in the Cloudflare dashboard: Workers & Pages → hubspot-automations →
   Settings → Variables and Secrets → Add, type **Secret**.
3. In Cloudflare Access, add a Bypass policy for `/twilio/*` (see Production).
4. Open /settings. Under **Calling**, pick the number to call from (the
   account's voice numbers) and your phone (the account's verified caller
   IDs; verify a new one in Twilio Console → Phone Numbers → Verified Caller
   IDs). Nothing is typed, and the app accepts only numbers Twilio lists.

Twilio can't reach localhost, so calls only work against the deployed Worker.
Locally, Settings still lists the numbers.

### WhatsApp (one-time)

1. Use a **WhatsApp Business** account on a business number, not your personal
   WhatsApp. Cold messages get reported, and enough reports can get an account
   banned. The Twilio number works:
   - Install WhatsApp Business on your phone and register +1 385-255-7051.
   - Choose the text-message code. It shows in Twilio Console → Monitor →
     Messaging logs, because the number has no SMS webhook.
2. Link WhatsApp on the computer you work from (WhatsApp Desktop or WhatsApp
   Web → Linked devices) to that account.
3. In /settings, under **WhatsApp**, pick where the button opens: the app or
   WhatsApp Web.

Logging a WhatsApp message uses HubSpot's communications object through the
app's existing contact scopes, with association types 81 (contact) and 87
(company), taken from HubSpot's table. If HubSpot refuses them, check them
with `GET /crm/v4/associations/communications/contacts/labels`.

### Calling from the browser (optional, one-time)

The browser's Voice SDK signs in with a short token the Worker signs with a
Twilio API key, and Twilio asks the app's TwiML App what to do with each call.

1. Create an API key (Standard) in Twilio Console → Account → API keys &
   tokens. Keep its secret: Twilio shows it once.
2. Create a TwiML App in Twilio Console → Phone Numbers → Manage → TwiML
   apps:
   - Voice Request URL: `https://hubspot-automations.frosty-darkness-3dd3.workers.dev/twilio/voice/client`, HTTP POST
   - Voice Status Callback URL: `…/twilio/voice/client-status`
3. Add the app's SID (`AP…`) to `vars` in `wrangler.jsonc` as
   `TWILIO_TWIML_APP_SID`. The key's SID (`SK…`) goes on the Worker as the
   var `TWILIO_API_KEY_SID` (Cloudflare dashboard → the Worker → Settings →
   Variables, kept across deploys by `keep_vars`) and in `.dev.vars`, so it
   stays out of the public repo, like `TWILIO_ACCOUNT_SID`. Then the secret:
   ```bash
   npx wrangler secret put TWILIO_API_KEY_SECRET
   ```
4. `npm run deploy`, then pick **This browser**
   under **Call with** in /settings. The `/twilio/*` Bypass policy already
   covers the TwiML App's webhooks, which are signed like the rest.

Recording needs nothing more: the Workers AI binding (`ai` in
`wrangler.jsonc`) deploys with the Worker, and `npm run deploy` applies
`migrations/0006`. Then turn on **Record and transcribe calls** in /settings.

For calls to the number, deploy (`npm run deploy` applies `migrations/0008`),
then point the number at the Worker (Twilio Console → Phone Numbers →
the number → Voice configuration, or the CLI):

```bash
twilio api:core:incoming-phone-numbers:update --sid PNa84c07f9219d5b67f18b9509d1ea6e6d \
  --voice-url https://hubspot-automations.frosty-darkness-3dd3.workers.dev/twilio/voice/inbound \
  --voice-method POST \
  --status-callback https://hubspot-automations.frosty-darkness-3dd3.workers.dev/twilio/voice/inbound/status \
  --status-callback-method POST
```

The status callback is how the app learns a call has ended, so it can log it.

### Production

Already done: D1 `hubspot-automations-db` created and migrated, Worker deployed.

```bash
wrangler secret put HUBSPOT_ACCESS_TOKEN
# Cloudflare dashboard → Zero Trust → Access → Applications → add a self-hosted
# application for hubspot-automations.frosty-darkness-3dd3.workers.dev, allow the
# reps' emails, then copy the team domain and Application Audience (AUD) tag into
# wrangler.jsonc vars ACCESS_TEAM_DOMAIN / ACCESS_AUD.
# Add a second policy to that application: action "Bypass", path /t/*, for
# Everyone. Recipients' mail apps load the tracking pixel and links from there
# and can't sign in. Add a third, the same for /twilio/*: Twilio's webhooks
# can't sign in either, and the Worker checks their signatures instead. Add
# the same Bypass for /mcp, /oauth/mcp/* and /.well-known/*: Claude's servers
# call them directly, and the Worker checks the connector's OAuth token
# instead (/authorize stays behind Access: that's where you approve it).
npm run deploy   # applies any new migrations to remote D1 first
```

Workers Builds (the Worker's Settings → Builds, connected to the GitHub repo)
deploys `main` the same way: its deploy command is `npm run deploy`, and the
build command stays empty (CI runs the checks before a merge). Other branches
keep `npx wrangler versions upload`, never the migrations: there's one D1
database, and a branch's migration would change it before the code merges.
The build's API token needs D1 Edit for the migrations.

The Worker refuses every request until `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`
are set.

## Checks

```bash
npm run check      # typecheck + lint + format check + tests (CI runs the same on every PR)
npm test           # 388 tests: pure logic, Access token checks, the real SQL on SQLite, send and call idempotency, Twilio signatures
npm run format     # apply Prettier
npm run db:log     # last 20 audit rows (who changed what in HubSpot)
```

A PR merges into `main` only when two checks pass: `check` (the same
`npm run check`, plus `npm audit` on what ships) and `codex-review`, which
waits until Codex has reviewed the PR's latest commit, so "merge when ready"
waits for Codex too. It never holds a merge for long: if Codex is out of
usage, or hasn't answered in 15 minutes, it passes with a warning, and the
`skip-codex` label passes it at once. Codex's comments don't block: once it
has reviewed, what to do with them is up to you.

- **Lint** is only the type-aware promise rules (`no-floating-promises` and
  friends). On Workers, an un-awaited promise is work that silently never
  finishes. Prettier owns formatting.
- **TypeScript is pinned to 6.0** because typescript-eslint doesn't support the
  TypeScript 7 native compiler yet.
- **Database tests** (`test/db.test.ts`) run the real migrations and queries on
  Node's built-in SQLite (the engine D1 uses) through a small adapter in
  `test/sqlite-d1.ts`.

## Known gaps

- **Queue size.** The queue page reads at most 1,000 open email tasks.
- **Rules come from the Claude skills.** The drop flags, the due-time rule and
  the drafting rules in `src/lib/prompt.ts` copy the `hubspot-email-sent-followup`
  and `mom-test-vfwpa-email` skills. When a rule changes there, change it here too.
- **Contact details on send.** The follow-up skill also records the contact
  reached and the email used when they're missing. The app doesn't yet.
