import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays,
  ago,
  dayBounds,
  isDate,
  localDate,
  localDateAt,
  nextCalendarDayAt,
  parseTime,
  TIME_PATTERN,
  timeOfDay,
} from '../src/lib/dates.ts';

const NINE = { hour: 9, minute: 0 };

const iso = (ms: number) => new Date(ms).toISOString();

test('Panama (UTC-5): 8pm local is still "today", so the call is due tomorrow 9:00 local', () => {
  // 2026-09-24 20:00 in Panama is 2026-09-25 01:00 UTC.
  const now = Date.parse('2026-09-25T01:00:00Z');
  assert.equal(iso(nextCalendarDayAt(now, 'America/Panama', NINE)), '2026-09-25T14:00:00.000Z');
});

test('rolls over month and year ends', () => {
  const now = Date.parse('2026-12-31T15:00:00Z'); // 10:00 on Dec 31 in Panama
  assert.equal(iso(nextCalendarDayAt(now, 'America/Panama', NINE)), '2027-01-01T14:00:00.000Z');
});

test('uses the local date, not the UTC date, just after UTC midnight', () => {
  const now = Date.parse('2026-02-28T03:30:00Z'); // 22:30 on Feb 27 in Panama
  assert.equal(iso(nextCalendarDayAt(now, 'America/Panama', NINE)), '2026-02-28T14:00:00.000Z');
});

test('handles a DST change overnight (New York, spring forward)', () => {
  const now = Date.parse('2026-03-07T15:00:00Z'); // Sat 10:00 EST; Sunday is EDT
  assert.equal(iso(nextCalendarDayAt(now, 'America/New_York', NINE)), '2026-03-08T13:00:00.000Z');
});

test("reuses a task's local time of day, minutes included", () => {
  const emailDue = Date.parse('2026-09-24T19:30:00Z'); // 14:30 in Panama
  const at = timeOfDay(emailDue, 'America/Panama');
  assert.deepEqual(at, { hour: 14, minute: 30 });
  const now = Date.parse('2026-09-24T21:00:00Z');
  assert.equal(iso(nextCalendarDayAt(now, 'America/Panama', at)), '2026-09-25T19:30:00.000Z');
});

test('localDate and localDateAt use the zone, not UTC', () => {
  const now = Date.parse('2026-09-25T03:00:00Z'); // 22:00 on Sep 24 in Panama
  assert.equal(localDate(now, 'America/Panama'), '2026-09-24');
  assert.equal(iso(localDateAt('2026-09-28', 'America/Panama', NINE)), '2026-09-28T14:00:00.000Z');
});

test('addDays and isDate', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.ok(isDate('2026-09-25'));
  for (const bad of ['2026-02-30', '2026-9-25', '25/09/2026', '']) assert.equal(isDate(bad), false, bad);
});

test('dayBounds: local midnight to midnight, 23 hours on a spring-forward day', () => {
  // 2026-09-24 20:00 in Panama is still the 24th there.
  const panama = dayBounds(Date.parse('2026-09-25T01:00:00Z'), 'America/Panama');
  assert.equal(iso(panama.startMs), '2026-09-24T05:00:00.000Z');
  assert.equal(iso(panama.endMs), '2026-09-25T05:00:00.000Z');
  // Denver springs forward on 2026-03-08.
  const dst = dayBounds(Date.parse('2026-03-08T18:00:00Z'), 'America/Denver');
  assert.equal(iso(dst.startMs), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(dst.endMs), '2026-03-09T06:00:00.000Z');
});

test('dayBounds: a day whose midnight is skipped starts at the jump, not the hour before', () => {
  // Havana springs forward at midnight on 2026-03-08: 00:00 CST becomes 01:00 CDT.
  const havana = dayBounds(Date.parse('2026-03-08T18:00:00Z'), 'America/Havana');
  assert.equal(iso(havana.startMs), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(havana.endMs), '2026-03-09T04:00:00.000Z');
  // The day before ends where it starts.
  assert.equal(iso(dayBounds(Date.parse('2026-03-07T18:00:00Z'), 'America/Havana').endMs), '2026-03-08T05:00:00.000Z');
  // Falling back at 01:00 repeats midnight: the day starts at the first one.
  const fallBack = dayBounds(Date.parse('2026-11-01T18:00:00Z'), 'America/Havana');
  assert.equal(iso(fallBack.startMs), '2026-11-01T04:00:00.000Z');
});

test('parseTime takes a typed hour without its minutes, and 24-hour times', () => {
  const at = (hour: number, minute: number) => ({ hour, minute });
  assert.deepEqual(parseTime('4pm'), at(16, 0));
  assert.deepEqual(parseTime(' 4 PM '), at(16, 0));
  assert.deepEqual(parseTime('4p'), at(16, 0));
  assert.deepEqual(parseTime('4:30 p.m.'), at(16, 30));
  assert.deepEqual(parseTime('9:05am'), at(9, 5));
  assert.deepEqual(parseTime('12pm'), at(12, 0));
  assert.deepEqual(parseTime('12:15 am'), at(0, 15));
  assert.deepEqual(parseTime('16:30'), at(16, 30));
  assert.deepEqual(parseTime('09:00'), at(9, 0));
  for (const bad of ['', '4', '4:30', '13pm', '0am', '4:60pm', '24:00', '4:3pm', 'noon']) {
    assert.equal(parseTime(bad), null, bad);
  }
});

test("a time field's pattern lets through what parseTime reads, and asks for am or pm", () => {
  // As the browser applies it: whole value, v flag.
  const pattern = new RegExp(`^(?:${TIME_PATTERN})$`, 'v');
  for (const ok of ['4pm', ' 4 PM ', '4p', '4:30 p.m.', '9:05am', '12:15 am', '16:30', '09:00']) {
    assert.ok(pattern.test(ok), ok);
    assert.ok(parseTime(ok), ok);
  }
  for (const bad of ['4', '4:30', 'noon']) assert.ok(!pattern.test(bad), bad);
});

test("ago counts the rep's calendar days, not 24-hour spans", () => {
  const tz = 'America/Denver';
  const now = Date.parse('2026-10-08T15:00:00Z'); // 9:00 AM in Denver
  assert.equal(ago(Date.parse('2026-10-08T14:00:00Z'), now, tz), 'today');
  assert.equal(ago(Date.parse('2026-10-08T05:00:00Z'), now, tz), 'yesterday', '11 PM the night before');
  assert.equal(ago(Date.parse('2026-10-05T18:00:00Z'), now, tz), '3 days ago');
  assert.equal(ago(Date.parse('2026-09-20T18:00:00Z'), now, tz), '2 weeks ago');
  assert.equal(ago(Date.parse('2026-05-01T18:00:00Z'), now, tz), '5 months ago');
  assert.equal(ago(Date.parse('2026-10-09T18:00:00Z'), now, tz), 'today', 'a time ahead reads as today');
});
