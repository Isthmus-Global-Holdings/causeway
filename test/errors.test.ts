import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeError } from '../src/lib/errors.ts';
import { GoogleApiError } from '../src/lib/google.ts';

test('a calendar 403 for a disabled API says to enable it, with Google’s link', () => {
  const url =
    'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=252643501861';
  const body = JSON.stringify({
    error: {
      code: 403,
      message: `Google Calendar API has not been used in project 252643501861 before or it is disabled. Enable it by visiting ${url} then retry.`,
      errors: [{ reason: 'accessNotConfigured' }],
      status: 'PERMISSION_DENIED',
      details: [{ reason: 'SERVICE_DISABLED' }],
    },
  });
  const { message } = describeError(new GoogleApiError(403, body, 'calendar'));
  assert.match(message, /Calendar API is turned off/);
  assert.ok(message.includes(url));
  assert.doesNotMatch(message, /Reconnect/);
});

test('any other calendar 403 still says to reconnect', () => {
  const body = JSON.stringify({
    error: { code: 403, message: 'Insufficient Permission', status: 'PERMISSION_DENIED' },
  });
  assert.match(describeError(new GoogleApiError(403, body, 'calendar')).message, /Reconnect Gmail/);
});
