import { Hono } from 'hono';
import { describeError } from './lib/errors';
import { accessAuth } from './middleware/access';
import { timing } from './middleware/timing';
import { authorizeRoute } from './routes/authorize';
import { callQueueRoute, callsRoute } from './routes/calls';
import { coachingRoute } from './routes/coaching';
import { draftRoute } from './routes/draft';
import { dropRoute } from './routes/drop';
import { historyRoute } from './routes/history';
import { inboundRoute } from './routes/inbound';
import { meetingsRoute } from './routes/meetings';
import { pitchesRoute } from './routes/pitches';
import { queueRoute } from './routes/queue';
import { recordsRoute } from './routes/records';
import { sendRoute } from './routes/send';
import { sentRoute } from './routes/sent';
import { settingsRoute } from './routes/settings';
import { trackingRoute } from './routes/tracking';
import { twilioRoute } from './routes/twilio';
import { unfinishedRoute } from './routes/unfinished';
import type { AppEnv } from './types';
import { errorPage } from './views/layout';

const app = new Hono<AppEnv>();

app.use('*', timing);
app.use('*', accessAuth);

app.route('/', trackingRoute);
app.route('/', twilioRoute);
app.route('/', queueRoute);
app.route('/', settingsRoute);
app.route('/', unfinishedRoute);
app.route('/', authorizeRoute);
app.route('/tasks', draftRoute);
app.route('/tasks', sentRoute);
app.route('/tasks', sendRoute);
app.route('/tasks', dropRoute);
app.route('/queue/calls', callQueueRoute);
app.route('/calls', historyRoute); // GET /calls only: the call task pages are /calls/:id
app.route('/calls', callsRoute);
app.route('/coaching', coachingRoute);
app.route('/meetings', meetingsRoute);
app.route('/inbound', inboundRoute);
app.route('/', recordsRoute);
app.route('/', pitchesRoute);

// Every step in the workflows is safe to repeat, so each error page tells
// the rep they can go back and try again (lib/errors.ts).
app.onError((err, c) => {
  const { title, message, status, log } = describeError(err);
  if (log) console.error(err);
  return c.html(errorPage(title, message, c.get('actor') ?? null), status);
});

export default app;
