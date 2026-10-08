// Coaching: each logged call read for the phone menu, who answered and what
// the front desk did, how far it got, the objection and the next step
// (lib/call-insight.ts, workflows/call-insight.ts), the patterns across them,
// before and after each call (lib/coaching.ts), and the cron sweep that keeps
// it all read (workflows/coaching-sweep.ts). The transcripts are the rep's own
// calls (test/call-fixtures.ts), each one the old rules misread.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { callNotes, type CallCoaching } from '../src/actions/coaching.ts';
import { stateTimeZone, zoneLabel } from '../src/lib/address.ts';
import {
  adjustNotes,
  callFacts,
  fastNoNextStep,
  feedbackBy,
  firstNameOf,
  parseSources,
  parseUnsure,
  phoneTree,
  plainText,
  ruleInsight,
  RULES_VERSION,
  theirPart,
  transcriptStats,
  withReviews,
  type CallFacts,
  type Corrections,
} from '../src/lib/call-insight.ts';
import {
  bestHour,
  bookingReport,
  bookingStatus,
  callBrief,
  callFunnel,
  coachingReport,
  describeCall,
  momTestReport,
  talkReport,
  HOUR_SAMPLE,
  hourLabel,
  lastInterviewNote,
  prepNotes,
} from '../src/lib/coaching.ts';
import { callTimeline, parseTimeline } from '../src/lib/call-timeline.ts';
import {
  allBookedInterviews,
  allCallInsights,
  callsToReview,
  callInsightsFor,
  heardSources,
  callInsightsNear,
  d1CallInsightStore,
  d1CallReviewStore,
  d1CallLogStore,
  d1DialStore,
  d1MeetingBookingStore,
  d1MeetingLogStore,
  type BookedInterview,
  type CallInsight,
  type CallLog,
  type NewCallLog,
  type MeetingLog,
  type NewDial,
} from '../src/lib/db.ts';
import type { HubSpot } from '../src/lib/hubspot.ts';
import type { Turn } from '../src/lib/transcript.ts';
import { afterCallSummary, callReviewSummary, beforeCallSummary, bookingSummary } from '../src/mcp/format.ts';
import { callTags, coachingCard, coachingPage } from '../src/views/coaching.ts';
import {
  excludeCall,
  readCall,
  readDialCall,
  readInterview,
  readUnreadCalls,
  reviewCall,
  type InsightDeps,
} from '../src/workflows/call-insight.ts';
import { runCoachingSweep } from '../src/workflows/coaching-sweep.ts';
import {
  emailOnly,
  holdToVoicemail,
  inAndOut,
  lunchThenBooked,
  notAvailable,
  onHold,
  phoneMenuCallBack,
  putThrough,
  wrongNameToVoicemail,
  type CallFixture,
} from './call-fixtures.ts';
import { sqliteD1 } from './sqlite-d1.ts';

const TZ = 'America/Denver';
const ORIGIN = 'https://app.example';
// Tuesday 2026-09-29, 10:00 in Denver.
const T0 = Date.parse('2026-09-29T16:00:00Z') / 1000;
const HOUR = 3600;
const DAY = 86_400;

function facts(over: Partial<CallFacts>): CallFacts {
  return {
    label: 'Paul Weir at Weir Freight',
    firstName: 'Sam',
    outcome: 'connected',
    channel: 'phone',
    durationSec: 60,
    notes: '',
    transcript: null,
    setTime: false,
    booked: false,
    ...over,
  };
}

// A recorded call: its transcript, the rep's notes, outcome and length.
const heard = (call: CallFixture, over: Partial<CallFacts> = {}) =>
  ruleInsight(
    facts({
      label: call.label,
      firstName: firstNameOf(call.label),
      outcome: call.outcome,
      durationSec: call.durationSec,
      notes: call.notes,
      transcript: { turns: call.turns, summary: ['A summary that gets who said what wrong.'] },
      ...over,
    })
  );

const turns = (...lines: [Turn['speaker'], string][]): Turn[] =>
  lines.map(([speaker, text], i) => ({ speaker, start: i * 5, text }));

// --- Their time zone and their name ---

test('a contact’s time zone comes from their state, by code or name, or a few countries', () => {
  assert.equal(stateTimeZone('UT'), 'America/Denver');
  assert.equal(stateTimeZone('utah', 'United States'), 'America/Denver');
  assert.equal(stateTimeZone('New York'), 'America/New_York');
  assert.equal(stateTimeZone('AZ'), 'America/Phoenix');
  assert.equal(stateTimeZone('', 'Panama'), 'America/Panama');
  assert.equal(stateTimeZone('Ontario', 'Canada'), null);
  assert.equal(stateTimeZone(null), null);
  assert.equal(zoneLabel('America/Denver'), 'Mountain');
  assert.equal(zoneLabel('America/Panama'), 'Panama');
});

test('their first name comes from the dial’s label or the logged call’s title', () => {
  assert.equal(firstNameOf('Hank Marlow at Marlow Trucking'), 'Hank');
  assert.equal(firstNameOf('Call with Neil St. Varga (Basalt Logistics)'), 'Neil');
  assert.equal(firstNameOf(''), null);
});

// --- Reading a transcript, turn by turn ---

test('the phone menu: how long it took, and the digit it gave for them', () => {
  assert.deepEqual(phoneTree(phoneMenuCallBack.turns, 'Grant'), { sec: 22, digit: '4', end: 1 });
  assert.equal(phoneTree(onHold.turns, 'Hank')?.sec, 43);
  assert.equal(phoneTree(onHold.turns, 'Hank')?.digit, null, 'the menu has no digit for him');
  assert.equal(phoneTree(wrongNameToVoicemail.turns, 'Owen'), null, 'a person answered');
  assert.equal(phoneTree(putThrough.turns, 'Lyle')?.sec, 14, '“our office hours are” is the menu');
});

test('the front desk put them on hold and they never came on (Hugo)', () => {
  const read = heard(onHold);
  assert.equal(read.gate, 'gatekeeper');
  assert.equal(read.gatekeeper_name, 'Hugo');
  assert.equal(read.gatekeeper_result, 'on_hold_no_pickup', 'not “not available”, though he was on the other line');
  assert.equal(read.reached, 0, '“connected” only says someone picked up');
  assert.equal(read.stage, 'gatekeeper');
  assert.equal(read.phone_tree_sec, 43);
  assert.equal(read.gatekeeper_line, 'hi hugo is hank available');
  assert.deepEqual(read.unsure, []);
});

test('the front desk said he’d just left (Nina), not the summary’s “Hank is available”', () => {
  const read = heard(notAvailable);
  assert.equal(read.gate, 'gatekeeper');
  assert.equal(read.gatekeeper_name, 'Nina');
  assert.equal(read.gatekeeper_result, 'not_available');
  assert.equal(read.reached, 0);
  assert.equal(read.phone_tree_sec, 36);
});

test('put on hold, then the voicemail greeting: sent to voicemail (Faye, Ivy)', () => {
  const faye = heard(holdToVoicemail);
  assert.deepEqual(
    [faye.gate, faye.gatekeeper_name, faye.gatekeeper_result, faye.reached, faye.phone_tree_sec],
    ['gatekeeper', 'Faye', 'sent_to_voicemail', 0, 42]
  );
  assert.equal(faye.opening, null, 'the message he left isn’t an opening');
  const ivy = heard(wrongNameToVoicemail);
  assert.deepEqual(
    [ivy.gate, ivy.gatekeeper_name, ivy.gatekeeper_result, ivy.reached],
    ['gatekeeper', 'Ivy', 'sent_to_voicemail', 0],
    'asking for the wrong name is still asking the front desk'
  );
});

test('“we’re not able to transfer”, “follow up with the email”: turned away (Joy)', () => {
  const read = heard(emailOnly);
  assert.deepEqual([read.gatekeeper_name, read.gatekeeper_result, read.reached], ['Joy', 'refused', 0]);
  assert.equal(read.objection_kind, null, 'the front desk’s “email” isn’t their objection');
});

test('“he’s in and out all day”: not available, from someone who never said their name', () => {
  const read = heard(inAndOut);
  assert.deepEqual([read.gate, read.gatekeeper_name, read.gatekeeper_result], ['gatekeeper', null, 'not_available']);
});

test('press 4 for Grant, who asks to talk in half an hour and gives his cell', () => {
  const read = heard(phoneMenuCallBack);
  assert.equal(read.gate, 'owner');
  assert.equal(read.reached, 1);
  assert.deepEqual([read.phone_tree_sec, read.phone_tree_digit], [22, '4']);
  assert.equal(read.talk_sec, 70, 'from when he picked up, not the menu');
  assert.equal(read.objection_kind, 'busy');
  assert.equal(read.next_step, 1);
  assert.match(read.next_step_text!, /talk in about maybe a half hour/);
  assert.equal(read.stage, 'next_step');
  assert.equal(read.got_past_objection, 1);
  assert.equal(read.opening, 'hey grant this is anel how are you');
});

test('eating lunch, “maybe about 4”: busy, and a time to call back', () => {
  const read = heard(lunchThenBooked);
  assert.equal(read.objection_kind, 'busy', '“we use a little bit of software” isn’t “already have something”');
  assert.equal(read.next_step, 1);
  assert.match(read.next_step_text!, /later this afternoon maybe about 04:00/);
  assert.equal(heard(lunchThenBooked, { booked: true }).next_step_text, 'Interview booked');
});

test('the long one: put through by Rex, “our problems do not involve software”, his direct number', () => {
  const read = heard(putThrough);
  assert.equal(read.gate, 'gatekeeper');
  assert.equal(read.gatekeeper_name, 'Rex');
  assert.equal(read.gatekeeper_result, 'put_through');
  assert.equal(read.reached, 1);
  assert.equal(read.talk_sec, 488, 'from when the rep had Lyle on the line');
  assert.equal(read.objection_kind, 'no_problem');
  assert.equal(read.objection, 'i would say our problems do not involve software we');
  assert.equal(read.next_step_text, 'Gave their direct number');
  assert.equal(read.stage, 'next_step');
  assert.match(read.opening!, /^yeah so basically lyle/);
  const notes = adjustNotes({ ...read, duration_sec: 543, label: 'Lyle Moss' });
  assert.ok(notes.some((n) => n.kind === 'bright' && /Long connect \(8:08\)/.test(n.text)));
  assert.ok(!notes.some((n) => n.kind === 'flag'));
});

test('a voicemail greeting first is voicemail, and their menu digit says “press 4 next time”', () => {
  const read = ruleInsight(
    facts({
      durationSec: 40,
      transcript: {
        summary: [],
        turns: turns(['prospect', 'you have reached sam please leave a message after the tone'], ['rep', 'hey sam']),
      },
    })
  );
  assert.deepEqual([read.gate, read.stage, read.reached], ['voicemail', 'voicemail', 0]);
  const menu = adjustNotes({ ...heard(phoneMenuCallBack), duration_sec: 92, label: 'Grant Ives' });
  assert.ok(menu.some((n) => n.text === 'The phone menu took 0:22: press 4 for Grant next time.'));
});

test('the transcript shows how much they talked, the rep’s questions, and “you” over “we”', () => {
  const stats = transcriptStats(
    turns(
      ['rep', 'How do you train your new people?'],
      ['prospect', 'Honestly it is a mess, we shadow for weeks and still lose half of them before they ever get good'],
      ['rep', 'What does that cost you? We see it a lot.']
    )
  );
  assert.equal(stats.repQuestions, 2);
  assert.ok(stats.prospectTalkShare! > 0.5);
  assert.equal(stats.youFocus, 3 / 4, 'you, your, you against we');
});

// Each line as Nova-3 writes it with `punctuate`: a capital, commas, and a
// question mark or full stop, the way newer transcripts are kept.
const written = (call: CallFixture): CallFixture => ({
  ...call,
  turns: call.turns.map((t) => {
    const text = t.text
      .replace(/\b(hey|hi|yeah|so|okay)\b/g, '$1,')
      .replace(/\b(grant|lyle|rex|sam|anel)\b/g, (n) => n[0].toUpperCase() + n.slice(1))
      .replace(/\b(\d{1,2}):00\b/, '$1:00 p.m.');
    const end = /\b(how are you|is \w+ (available|in|there))$/.test(t.text) ? '?' : '.';
    return { ...t, text: `${text[0].toUpperCase()}${text.slice(1)}${end}` };
  }),
});

test('a punctuated transcript reads the same as a bare one', () => {
  const calls = [
    onHold,
    notAvailable,
    holdToVoicemail,
    wrongNameToVoicemail,
    phoneMenuCallBack,
    emailOnly,
    inAndOut,
    lunchThenBooked,
    putThrough,
  ];
  for (const call of calls) {
    const { next_step_text: bareNext, ...bare } = heard(call);
    const { next_step_text: writtenNext, ...read } = heard(written(call));
    assert.deepEqual(read, bare, call.label);
    assert.equal(writtenNext === null, bareNext === null, `${call.label}: the next step`);
  }
  assert.equal(plainText('Hey, Grant. How are you? About 4:30 p.m.'), 'hey grant how are you about 4:30 pm');
  assert.equal(plainText('“We’re not able to transfer” — sorry!'), "we're not able to transfer sorry");
  const stats = transcriptStats(theirPart(written(phoneMenuCallBack).turns, 'Grant'));
  assert.ok(stats.repQuestions > 0, 'the questions are counted once they have their marks');
});

// --- Reading the rep's notes, when there's no transcript ---

test('notes: another first name than theirs is the front desk', () => {
  const read = ruleInsight(facts({ firstName: 'Hank', notes: notAvailable.notes }));
  assert.deepEqual(
    [read.gate, read.gatekeeper_name, read.gatekeeper_result, read.reached],
    ['gatekeeper', 'Nina', 'not_available', 0]
  );
  assert.deepEqual(read.unsure, []);
});

test('notes: a transfer nobody picked up, the secretary’s voicemail, “email only”', () => {
  const desk = (notes: string) => ruleInsight(facts({ firstName: 'Hank', outcome: 'busy', durationSec: 90, notes }));
  assert.equal(desk(onHold.notes).gatekeeper_result, 'on_hold_no_pickup');
  assert.equal(desk(holdToVoicemail.notes).gatekeeper_result, 'sent_to_voicemail');
  assert.equal(desk(emailOnly.notes).gatekeeper_result, 'refused', '“she says … him” is someone else');
  assert.equal(desk(emailOnly.notes).gate, 'gatekeeper');
});

test('notes: “not available” or “in meetings all day” wasn’t them, though nobody said who it was', () => {
  for (const notes of ['Not available', 'He said he’s been in meetings the whole day. try him a different time']) {
    const read = ruleInsight(facts({ outcome: 'busy', durationSec: 100, notes }));
    assert.deepEqual([read.gate, read.gatekeeper_result, read.reached], ['gatekeeper', 'not_available', 0], notes);
    assert.ok(read.unsure.includes('whoAnswered'));
  }
});

test('notes about them: reached, with the objection and next step from the notes', () => {
  const read = ruleInsight(facts({ durationSec: 81, notes: lunchThenBooked.notes }));
  assert.deepEqual([read.gate, read.reached, read.objection_kind], ['owner', 1, 'busy']);
  const back = ruleInsight(facts({ durationSec: 92, notes: phoneMenuCallBack.notes }));
  assert.equal(back.next_step, 1, '“call him in 30 minutes”');
});

test('no notes: “busy” is how the rep logs not available, “connected” only that someone picked up', () => {
  const busy = ruleInsight(facts({ outcome: 'busy', durationSec: 68 }));
  assert.deepEqual([busy.gate, busy.gatekeeper_result, busy.reached], ['gatekeeper', 'not_available', 0]);
  assert.deepEqual(busy.unsure, ['whoAnswered', 'reachedThem', 'stage']);
  const connected = ruleInsight(facts({ durationSec: 200 }));
  assert.deepEqual([connected.gate, connected.reached, connected.stage], ['owner', 1, 'conversation']);
  assert.ok(connected.unsure.includes('whoAnswered'));
  assert.ok(connected.unsure.includes('objection'));
});

test('no answer, voicemail and a wrong number are settled by the outcome; a busy signal is no answer', () => {
  assert.equal(ruleInsight(facts({ outcome: 'no_answer' })).stage, 'no_connect');
  const vm = ruleInsight(facts({ outcome: 'left_voicemail', durationSec: 30 }));
  assert.deepEqual([vm.gate, vm.stage], ['voicemail', 'voicemail']);
  assert.equal(ruleInsight(facts({ outcome: 'wrong_number' })).gate, 'wrong_number');
  assert.equal(ruleInsight(facts({ outcome: 'busy', durationSec: 0 })).gate, 'no_answer');
  assert.equal(ruleInsight(facts({ outcome: 'left_live_message', durationSec: 50 })).gatekeeper_result, 'took_message');
});

test('a set-time follow-up or a booked interview is a next step, whatever the notes say', () => {
  assert.equal(ruleInsight(facts({ durationSec: 200, notes: 'Talked to him.', setTime: true })).next_step, 1);
  const booked = ruleInsight(facts({ durationSec: 200, notes: 'Talked to him.', booked: true }));
  assert.equal(booked.next_step_text, 'Interview booked');
});

// --- After a call ---

test('an objection note reads as a sentence, and “busy” on a rushed call isn’t said twice', () => {
  const call = { ...ruleInsight(facts({ durationSec: 200, notes: 'He said hi.' })), duration_sec: 200, label: 'Ross' };
  const quoted = adjustNotes({ ...call, objection_kind: 'send_info', objection: 'Just send me an email' });
  assert.match(quoted[0].text, /^Objection: “Just send me an email”\. Agree, then ask one question/);
  const asked = adjustNotes({ ...call, objection_kind: 'sales_call', objection: 'Is this a sales call?' });
  assert.match(asked[0].text, /^Objection: “Is this a sales call\?” Say plainly/);
  const rushed = adjustNotes({ ...call, talk_sec: 40, objection_kind: 'busy', objection: 'I’m slammed' });
  assert.equal(rushed.filter((n) => /When’s better/.test(n.text)).length, 1);
  assert.equal(fastNoNextStep({ ...call, talk_sec: 40 }), true, 'talk time, not the whole call, counts');
});

test('the front desk’s flag says what to do about what it did', () => {
  const held = adjustNotes({ ...heard(onHold), duration_sec: 261, label: 'Hank Marlow' });
  assert.match(
    held[0].text,
    /^Hugo at the front desk: put you on hold, and they never came on\. .*direct line or cell/
  );
  const refused = adjustNotes({ ...heard(emailOnly), duration_sec: 97, label: 'Neil Varga' });
  assert.match(refused[0].text, /^Joy at the front desk: turned you away\. Ask when they’re usually in/);
});

// --- The patterns ---

function insight(over: Partial<CallInsight> & Pick<CallInsight, 'call_task_id'>): CallInsight {
  return {
    subject: 'task',
    meeting_log_id: null,
    contact_id: `c-${over.call_task_id}`,
    company_id: null,
    dial_id: null,
    label: `Contact ${over.call_task_id}`,
    at_sec: T0,
    contact_tz: 'America/Denver',
    outcome: 'connected',
    duration_sec: 60,
    gate: 'owner',
    gatekeeper_result: null,
    gatekeeper_name: null,
    phone_tree_sec: null,
    phone_tree_digit: null,
    reached: 1,
    talk_sec: null,
    stage: 'opening',
    objection: null,
    objection_kind: null,
    got_past_objection: 0,
    next_step: 0,
    next_step_text: null,
    opening: null,
    gatekeeper_line: null,
    what_worked: null,
    adjust: null,
    asked_last_time: null,
    pitched: null,
    longest_story_sec: null,
    fluff_caught: null,
    commitment: null,
    prospect_talk_share: null,
    rep_questions: null,
    you_focus: null,
    source: 'notes',
    rules_version: RULES_VERSION,
    unsure: '[]',
    sources: '{}',
    timeline_json: null,
    excluded: 0,
    extracted_at: '2026-09-29T17:00:00.000Z',
    ...over,
  };
}

const noAnswer = (id: string, atSec: number, over: Partial<CallInsight> = {}) =>
  insight({
    call_task_id: id,
    at_sec: atSec,
    outcome: 'no_answer',
    gate: 'no_answer',
    reached: 0,
    stage: 'no_connect',
    duration_sec: null,
    ...over,
  });

function sample(): CallInsight[] {
  return [
    // 10 AM Denver: one reached of four.
    insight({
      call_task_id: '1',
      at_sec: T0,
      duration_sec: 68,
      outcome: 'busy',
      objection_kind: 'busy',
      label: 'Owen Pike',
    }),
    noAnswer('2', T0 + 60),
    noAnswer('3', T0 + 120),
    insight({
      call_task_id: '4',
      at_sec: T0 + 180,
      company_id: 'marlow',
      gate: 'gatekeeper',
      gatekeeper_result: 'not_available',
      gatekeeper_name: 'Nina',
      reached: 0,
      stage: 'gatekeeper',
      duration_sec: 40,
    }),
    // 2 PM Denver: three of three reached.
    insight({
      call_task_id: '5',
      at_sec: T0 + 4 * HOUR,
      duration_sec: 543,
      talk_sec: 488,
      stage: 'next_step',
      next_step: 1,
      next_step_text: 'Gave their direct number',
      objection_kind: 'sales_call',
      objection: 'Is this a sales call?',
      got_past_objection: 1,
      opening: 'How are you finding people with the right skills?',
      what_worked: 'Asked about his people problem, not software.',
      label: 'Lyle Moss',
      source: 'transcript',
      prospect_talk_share: 0.62,
      rep_questions: 9,
      you_focus: 0.8,
    }),
    insight({
      call_task_id: '6',
      at_sec: T0 + 4 * HOUR + 60,
      gate: 'gatekeeper',
      gatekeeper_result: 'put_through',
      gatekeeper_line: 'Hi, is Mike in? It’s Anel.',
      duration_sec: 200,
      stage: 'conversation',
      source: 'transcript',
      prospect_talk_share: 0.3,
    }),
    insight({
      call_task_id: '7',
      at_sec: T0 + 4 * HOUR + 120,
      duration_sec: 34,
      objection_kind: 'sales_call',
      objection: 'What are you selling?',
      label: 'Ross Keene',
      source: 'transcript',
      prospect_talk_share: 0.25,
    }),
    // An Eastern contact, at 4 PM their time.
    noAnswer('8', T0 + 4 * HOUR, { contact_tz: 'America/New_York', contact_id: 'c-east' }),
    // Follow-ups: Owen again the next day (reached again), the no-answer
    // contact the same afternoon (still no answer).
    insight({ call_task_id: '9', contact_id: 'c-1', at_sec: T0 + DAY, duration_sec: 150, stage: 'conversation' }),
    noAnswer('10', T0 + 6 * HOUR, { contact_id: 'c-2' }),
    insight({ call_task_id: '11', outcome: 'wrong_number', gate: 'wrong_number', reached: 0, stage: 'no_connect' }),
  ].sort((a, b) => a.at_sec - b.at_sec);
}

test('reached by hour of their day and by their time zone, wrong numbers left out', () => {
  const report = coachingReport(sample(), TZ);
  assert.equal(report.calls, 10);
  assert.equal(report.reached, 5);
  assert.equal(report.answered, 6);
  const at = (hour: number) => report.byHour.find((h) => h.hour === hour);
  assert.deepEqual({ calls: at(10)?.calls, reached: at(10)?.reached }, { calls: 5, reached: 2 });
  assert.deepEqual({ calls: at(14)?.calls, reached: at(14)?.reached }, { calls: 3, reached: 3 });
  assert.equal(at(16)?.calls, 2, 'the Eastern call at 2 PM Denver is 4 PM for them');
  assert.equal(bestHour(report.byHour), null, 'three calls an hour is too few to name one');
  const busy = [10, 14].flatMap((hour) =>
    Array.from({ length: HOUR_SAMPLE }, (_, i) =>
      insight({ call_task_id: `h${hour}-${i}`, at_sec: T0 + (hour - 10) * HOUR, reached: hour === 14 || i < 5 ? 1 : 0 })
    )
  );
  assert.equal(bestHour(coachingReport(busy, TZ).byHour)?.hour, 14, 'with enough calls in each, the better hour');
  const oneHour = busy.filter((c) => c.call_task_id.startsWith('h14'));
  assert.equal(bestHour(coachingReport(oneHour, TZ).byHour), null, 'one hour with enough calls: nothing to beat');
  assert.equal(hourLabel(14), '2 PM');
  assert.deepEqual(
    report.byZone.map((z) => [z.label, z.calls]),
    [
      ['Mountain', 9],
      ['Eastern', 1],
    ]
  );
});

test('the front desk is its own category: by name, and the line that got through', () => {
  const { gatekeeper } = coachingReport(sample(), TZ);
  assert.equal(gatekeeper.calls, 2);
  assert.equal(gatekeeper.putThrough, 1);
  assert.deepEqual(
    gatekeeper.names.map((n) => [n.name, n.calls, n.putThrough]),
    [['Nina', 1, 0]]
  );
  assert.equal(gatekeeper.linesThatWorked[0].text, 'Hi, is Mike in? It’s Anel.');
});

test('objections, most common first, with the openings that got past them', () => {
  const { objections } = coachingReport(sample(), TZ);
  assert.equal(objections[0].kind, 'sales_call');
  assert.equal(objections[0].count, 2);
  assert.equal(objections[0].gotPast, 1);
  assert.deepEqual(
    objections[0].openings.map((q) => q.text),
    ['How are you finding people with the right skills?']
  );
  assert.deepEqual(
    objections[0].examples.map((q) => q.text),
    ['What are you selling?', 'Is this a sales call?']
  );
});

test('follow-up timing: whether the next call reached them, after a connect or before one', () => {
  const { followUps } = coachingReport(sample(), TZ);
  const row = (key: string) => followUps.find((f) => f.key === key);
  assert.deepEqual(row('next_day')?.afterConnect, { calls: 1, reached: 1 }, 'Owen again the next day');
  assert.deepEqual(row('same_day')?.beforeConnect, { calls: 1, reached: 0 });
});

test('rushed connects with no next step, and the long connects with how they talked', () => {
  const report = coachingReport(sample(), TZ);
  assert.deepEqual(
    report.fastNoNextStep.calls.map((c) => c.label),
    ['Ross Keene', 'Owen Pike']
  );
  assert.equal(report.longConnects[0].label, 'Lyle Moss');
  assert.equal(report.style.long.talkShare, 0.62);
  assert.equal(report.style.short.calls, 1, 'only Ross’s short connect was recorded');
  assert.equal(report.style.short.talkShare, 0.25);
  const lengths = Object.fromEntries(report.lengthByOutcome.map((l) => [l.outcome, l.avgSec]));
  assert.equal(lengths.busy, 68);
});

const mikeAtMarlow = () => [
  insight({
    call_task_id: '4',
    contact_id: 'hank',
    company_id: 'marlow',
    at_sec: T0 + 180,
    gate: 'gatekeeper',
    gatekeeper_result: 'not_available',
    gatekeeper_name: 'Nina',
    phone_tree_sec: 36,
    reached: 0,
    stage: 'gatekeeper',
  }),
  insight({
    call_task_id: '3',
    contact_id: 'hank',
    company_id: 'marlow',
    at_sec: T0 - DAY,
    gate: 'gatekeeper',
    gatekeeper_result: 'on_hold_no_pickup',
    gatekeeper_name: 'Hugo',
    phone_tree_sec: 44,
    reached: 0,
    stage: 'gatekeeper',
  }),
];

test('before a call: their hour, the last call with them, the front desk by name, the habit, the bright spot', () => {
  const report = coachingReport(sample(), TZ);
  const notes = prepNotes({
    report,
    near: mikeAtMarlow().slice(0, 1),
    contactId: 'hank',
    contactTz: 'America/Denver',
    repTimeZone: TZ,
    now: (T0 + 24 * HOUR) * 1000, // 10 AM the next day
  });
  const text = notes.map((n) => `${n.kind}: ${n.text}`).join('\n');
  assert.match(text, /It’s 10 AM for them \(Mountain\)\. Calls at this hour have reached the person 2 of 5 times\.$/m);
  assert.match(text, /Last call, .*: Nina at the front desk, “not available”\./);
  assert.match(
    text,
    /flag: Nina answers here: 1 call, put through 0\. What got you through a front desk before: “Hi, is Mike in\? It’s Anel\.”/
  );
  assert.match(text, /flag: 2 of your last \d connects ended under 1:30 with no next step/);
  assert.match(
    text,
    /bright: Best connect: Lyle Moss, 8:08\. Asked about his people problem, not software\. On long connects they did 62% of the talking, against 25% on short ones/
  );
  assert.match(
    text,
    /Most common objection: Is this a sales call\? \(2×, got past 1\)\. An opening that got past it: “How are you finding people/
  );
});

test('the facts before a call: the last one, the front desk by name, the phone menu, the hour', () => {
  const brief = callBrief({
    report: coachingReport(sample(), TZ),
    near: mikeAtMarlow(),
    contactId: 'hank',
    contactTz: 'America/Denver',
    repTimeZone: TZ,
    now: (T0 + 28 * HOUR) * 1000, // 2 PM the next day
  });
  assert.equal(brief.lastCall?.gatekeeper_name, 'Nina');
  assert.deepEqual(brief.atTheirCompany, {
    calls: 2,
    reached: 0,
    frontDesk: [
      { name: 'Nina', calls: 1, putThrough: 0 },
      { name: 'Hugo', calls: 1, putThrough: 0 },
    ],
    phoneTree: { digit: null, avgSec: 40 },
  });
  const summary = beforeCallSummary({ before: [], brief, after: null }, TZ, ORIGIN);
  assert.deepEqual(summary.timing, {
    theirTimeNow: '2 PM (Mountain)',
    thisHour: '3 of 3 reached',
    bestHour: null,
  });
  assert.deepEqual(summary.lastCall, {
    when: summary.lastCall?.when,
    whoAnswered: 'front desk',
    frontDesk: 'Nina',
    result: 'not available',
    stage: 'front desk',
    objection: null,
    nextStep: null,
    url: `${ORIGIN}/calls/4`,
  });
});

test('a call described in a few words', () => {
  assert.equal(
    describeCall(
      insight({ call_task_id: 'x', duration_sec: 200, next_step: 1, next_step_text: 'call back Thursday 8am' })
    ),
    'reached them (3:20); agreed: call back Thursday 8am'
  );
  assert.equal(describeCall(noAnswer('y', T0)), 'no answer');
});

test('the funnel counts each step to an interview held, and names the step that loses the most', () => {
  // 13 calls: 11 picked up, 5 reached (8 front desks, 2 through), 3 next steps.
  const rows = [
    noAnswer('a', T0),
    noAnswer('b', T0 + 60),
    ...['c', 'd', 'e', 'f', 'g', 'h'].map((id) =>
      insight({
        call_task_id: id,
        gate: 'gatekeeper',
        gatekeeper_result: 'not_available',
        reached: 0,
        stage: 'gatekeeper',
      })
    ),
    insight({ call_task_id: 'i', gate: 'gatekeeper', gatekeeper_result: 'put_through' }),
    insight({
      call_task_id: 'j',
      gate: 'gatekeeper',
      gatekeeper_result: 'put_through',
      stage: 'next_step',
      next_step: 1,
    }),
    insight({ call_task_id: 'k', stage: 'next_step', next_step: 1, prospect_talk_share: 0.6 }),
    insight({ call_task_id: 'l', stage: 'next_step', next_step: 1, prospect_talk_share: 0.3 }),
    insight({ call_task_id: 'm' }),
  ];
  const report = coachingReport(rows, TZ);
  const booking = (call_task_id: string): BookedInterview => ({
    meeting_id: `m-${call_task_id}`,
    call_task_id,
    contact_id: `c-${call_task_id}`,
    label: 'Contact',
    booked_sec: T0,
    first_start: '2026-10-01T16:00:00Z',
    start: '2026-10-01T16:00:00Z',
    invite: 0,
    by_phone: 1,
    outcome: null,
    canceled_by: null,
    moves: 0,
    call_sec: null,
  });
  // 'k' was booked on a call that agreed a next step, twice; 'm' reached
  // them but agreed none (booked from its task); the last without a call.
  const funnel = callFunnel(
    report,
    [booking('k'), { ...booking('k'), meeting_id: 'm-k-2' }, booking('m'), booking('booked-from-the-task')],
    Date.parse('2026-09-30T00:00:00Z')
  );
  assert.deepEqual(
    funnel.steps.map((s) => [s.key, s.count]),
    [
      ['calls', 13],
      ['answered', 11],
      ['reached', 5],
      ['next_step', 3],
      ['booked', 1],
      ['held', 0],
    ]
  );
  assert.deepEqual([funnel.leak?.from.key, funnel.leak?.to.key], ['answered', 'reached'], 'the front desk loses 6');
  assert.match(funnel.leak!.advice, /front desk/);
  assert.equal(funnel.upcoming, 1);
  assert.deepEqual(
    report.talk.map((c) => c.call_task_id),
    ['l', 'k'],
    'reached, with a transcript, newest first'
  );

  const few = callFunnel(coachingReport(rows.slice(0, 2), TZ), [], 0);
  assert.equal(few.leak, null, 'two calls, nobody picked up: too few to name a leak');
});

test('the Coaching page and the call page’s card', async () => {
  const rows = sample();
  const report = coachingReport(rows, TZ);
  const lyleFacts = facts({
    label: putThrough.label,
    firstName: 'Lyle',
    durationSec: 543,
    transcript: { turns: putThrough.turns, summary: [] },
  });
  const interview = insight({
    call_task_id: 'm1',
    subject: 'meeting',
    at_sec: T0 + 2 * DAY,
    duration_sec: 900,
    reached: 1,
    stage: 'conversation',
    label: 'Grant Ives',
    asked_last_time: 1,
    pitched: 0,
    longest_story_sec: 95,
    commitment: 'intro',
    prospect_talk_share: 0.7,
    source: 'transcript',
  });
  const page = String(
    await coachingPage(
      {
        settings: { timeZone: TZ } as never,
        report,
        bookings: bookingReport([], 0),
        funnel: callFunnel(report, [], 0),
        interviews: [interview],
        momTest: momTestReport(rows, [interview]),
        talk: talkReport([...rows, interview].sort((a, b) => b.at_sec - a.at_sec)),
        strips: [
          { call: rows.find((r) => r.call_task_id === '5')!, timeline: callTimeline(lyleFacts, heard(putThrough)) },
          { call: rows[0], timeline: null },
        ],
        unread: 2,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /<h1>Coaching<\/h1>/);
  assert.match(page, /being read in the background/);
  assert.match(page, /A front desk answered 2 calls and put you through on\s+1 \(50%\)/);
  assert.match(page, /2 of 5 connects ended under\s+1:30/);
  assert.match(page, /Lyle Moss/);
  assert.match(page, /aria-current="page">Coaching/);
  assert.match(page, /No interview booked from a call yet/);
  assert.match(page, /<h2>How far your calls get<\/h2>/);
  assert.match(page, /<dl class="bars" aria-label="What the front desk did">/);
  assert.match(page, /style="--w: \d+%"/);
  assert.match(page, /Too few calls to pick an hour by yet/);
  assert.doesNotMatch(page, /by their time zone|Average length|Where each call ended/);
  // Two halves, the tables that need more calls parked under them.
  assert.match(page, /<h2>Earning the conversation<\/h2>/);
  assert.match(page, /<h2>The conversation<\/h2>/);
  assert.ok(page.indexOf('Earning the conversation') < page.indexOf('The conversation'));
  assert.match(page, /<details class="card">\s*<summary>When there are enough calls/);
  assert.ok(page.indexOf('<details') < page.indexOf('Reached, by hour of their day'), 'the hours table is parked');
  assert.ok(page.indexOf('<details') < page.indexOf('Which follow-up timing'));
  // The last calls drawn to scale: one with a drawing, one not yet.
  assert.match(page, /<h2>Your last call, to scale<\/h2>/);
  assert.match(page, /<dl class="strips">\s*<dt><a href="\/calls\/5"/);
  assert.match(page, /<div class="strip" aria-hidden="true" style="--w: 100%">/);
  assert.match(page, /<span class="sr-only">Phone menu 0:14 · Front desk \(Rex\)/);
  // The Mom Test table: a call and an interview, a dash where nothing has said.
  assert.match(page, /<h2>The Mom Test, call by call<\/h2>/);
  assert.match(page, /\(1 of them interview\)/);
  assert.match(page, /you asked about the last time on 1, pitched on 0/);
  assert.match(page, /Longest story: <a href="\/meetings\/m1">Grant Ives<\/a>, 1:35/);
  assert.match(page, /<a href="\/meetings\/m1">Grant Ives<\/a> <span class="tag">Interview<\/span>/);
  assert.match(page, /<td data-label="They gave">an intro<\/td>/);
  assert.match(page, /<td data-label="Asked about the last time">–<\/td>/, 'a call nothing has judged');
  assert.match(page, /<h2>What to adjust, call by call<\/h2>/);
  // Who did the talking counts the interview too.
  const talked = talkReport([...rows, interview].sort((a, b) => b.at_sec - a.at_sec));
  assert.ok(talked.theyLed.of > 1 && talked.talk.some((c) => c.subject === 'meeting'), 'the interview is counted');
  assert.match(
    page,
    new RegExp(
      `They talked more than you on ${talked.theyLed.calls} of the ${talked.theyLed.of} recorded calls and interviews`
    )
  );
  assert.match(page, /<a href="\/meetings\/m1" title="[^"]*">Grant Ives<\/a> <span class="tag">Interview<\/span>/);
  // No cold call read yet, but an interview: the page still shows it.
  const onlyInterviews = String(
    await coachingPage(
      {
        settings: { timeZone: TZ } as never,
        report: coachingReport([], TZ),
        bookings: bookingReport([], 0),
        funnel: callFunnel(coachingReport([], TZ), [], 0),
        interviews: [interview],
        momTest: momTestReport([], [interview]),
        talk: talkReport([interview]),
        strips: [],
        unread: 0,
      },
      'rep@example.com'
    )
  );
  assert.match(onlyInterviews, /No calls read yet/);
  assert.match(onlyInterviews, /<h2>The Mom Test, call by call<\/h2>/);
  assert.match(onlyInterviews, /<h2>Who did the talking<\/h2>/);

  const empty = String(await coachingCard({ before: [], brief: null, after: null }));
  assert.equal(empty, '');
  const reading = heard(onHold);
  const read = { ...reading, duration_sec: 261, label: 'Hank Marlow' };
  const coaching: CallCoaching = {
    before: [{ kind: 'tip', text: 'It’s 10 AM for them.' }],
    brief: null,
    after: {
      label: 'Hank Marlow',
      outcome: 'connected',
      read,
      unsure: ['objection'],
      sources: {},
      notes: adjustNotes(read),
      feedbackBy: { whatWorked: null, adjust: null },
      timeline: callTimeline(
        facts({
          label: onHold.label,
          firstName: 'Hank',
          durationSec: 261,
          transcript: { turns: onHold.turns, summary: [] },
        }),
        reading
      ),
    },
  };
  const card = String(await coachingCard(coaching));
  assert.match(card, /After the call with Hank Marlow/);
  assert.match(card, /<div class="strip" aria-hidden="true" style="--w: 100%">/, 'the call drawn to scale');
  assert.match(card, /<span class="phase hold" style="--l: 18\.5%; --w: 81\.5%">/);
  assert.match(
    card,
    /<p class="strip-text muted">Phone menu 0:43 · Front desk \(Hugo\) 0:43–0:48 · On hold from 0:48, they never came on · 4:21 in all<\/p>/
  );
  assert.match(card, /Front desk \(Hugo\): put you on hold, and they never came on · Phone menu 0:43/);
  assert.match(card, /Not sure of the objection/);
  assert.match(card, /<li class="flag">Hugo at the front desk/);
  assert.ok(card.indexOf('class="strip"') < card.indexOf('Front desk (Hugo):'), 'the strip first, then the tags');
  assert.ok(card.indexOf('After the call') < card.indexOf('Before this call'));
  const plain = String(await coachingCard({ ...coaching, after: { ...coaching.after!, timeline: null } }));
  assert.doesNotMatch(plain, /class="strip"/, 'nothing to draw: the tags alone');
});

test('after the call, the connector gets the tags, who decided them, and the follow-up’s time', () => {
  const read = { ...heard(phoneMenuCallBack), duration_sec: 92, label: 'Grant Ives' };
  const summary = afterCallSummary(
    {
      label: 'Grant Ives',
      outcome: 'connected',
      read,
      unsure: [],
      sources: { stage: { by: 'rules', p: null } },
      notes: adjustNotes(read),
      feedbackBy: { whatWorked: null, adjust: null },
      timeline: null,
    },
    '2026-09-29T17:00:00.000Z',
    TZ
  );
  assert.deepEqual(
    { ...summary.tags, nextStep: { ...summary.tags.nextStep, what: null } },
    {
      whoAnswered: 'them',
      frontDesk: null,
      frontDeskResult: null,
      phoneTreeSec: 22,
      phoneTreeDigit: '4',
      reachedThem: true,
      stage: 'next step agreed',
      talkSec: 70,
      lengthSec: 92,
      objection: { kind: 'busy', inTheirWords: read.objection, gotPast: true },
      nextStep: { agreed: true, when: summary.tags.nextStep.when, what: null },
      momTest: summary.tags.momTest,
    }
  );
  assert.deepEqual(summary.tags.momTest, {
    askedAboutLastTime: false,
    pitched: false,
    longestStorySec: read.longest_story_sec,
    fluffCaught: null,
    commitment: 'time',
  });
  assert.match(summary.tags.nextStep.when!, /11:00/);
  assert.deepEqual(summary.sources, { stage: { by: 'rules', p: null } });
  assert.equal(summary.review, null);
  assert.ok(summary.notes.some((n) => /press 4 for Grant/.test(n)));
});

// --- Storage, the workflow and the sweep ---

let db: D1Database;

beforeEach(() => {
  db = sqliteD1();
});

async function logCall(taskId: string, over: Partial<NewCallLog> = {}, createdAt = '2026-09-29 16:05:00') {
  await d1CallLogStore(db).create({
    call_task_id: taskId,
    contact_id: 'c1',
    company_id: 'co1',
    owner_id: null,
    title: 'Call with Grant Ives',
    channel: 'phone',
    outcome: 'connected',
    notes: lunchThenBooked.notes,
    twilio_status: null,
    duration_sec: 68,
    from_number: null,
    to_number: null,
    dial_id: null,
    next_type: 'CALL',
    next_subject: null,
    next_due: null,
    next_set_time: 0,
    next_body: null,
    book_start: null,
    book_title: null,
    book_minutes: null,
    book_join_url: null,
    book_phone: null,
    book_invite: 0,
    book_invitee_email: null,
    ...over,
  });
  await db.prepare('UPDATE call_logs SET created_at = ? WHERE call_task_id = ?').bind(createdAt, taskId).run();
}

function deps(calls = { place: 0 }): InsightDeps {
  return {
    callLogs: d1CallLogStore(db),
    dials: d1DialStore(db),
    meetingLogs: d1MeetingLogStore(db),
    insights: d1CallInsightStore(db),
    reviews: d1CallReviewStore(db),
    place: async () => {
      calls.place++;
      return 'America/Denver';
    },
  };
}

const dial = (over: Partial<NewDial> = {}): NewDial => ({
  id: 'd1',
  task_id: 't1',
  subject: 'task',
  contact_id: 'c1',
  contact_label: 'Hank Marlow at Marlow Trucking',
  to_number: '+18015550100',
  to_extension: null,
  from_number: '+13852557051',
  rep_number: '+18085550199',
  mode: 'phone',
  started_sec: T0,
  record: 1,
  ...over,
});

test('a logged call is read once from its notes and saved, with the rules’ version and doubts', async () => {
  await logCall('t1');
  const calls = { place: 0 };
  const row = await readCall(deps(calls), 't1', Date.parse('2026-09-29T17:00:00Z'));
  assert.equal(row?.source, 'notes');
  assert.equal(row?.objection_kind, 'busy');
  assert.equal(row?.rules_version, RULES_VERSION);
  assert.ok(parseUnsure(row?.unsure).includes('stage'), 'without a transcript, how far it got is a guess');
  assert.deepEqual(parseSources(row?.sources).whoAnswered, { by: 'rules', p: null });
  assert.equal(
    row?.at_sec,
    Date.parse('2026-09-29T16:05:00Z') / 1000,
    'a call not dialled from the app is when it was logged'
  );
  assert.equal(row?.contact_tz, 'America/Denver');
  assert.deepEqual({ ...(await d1CallInsightStore(db).get('t1')) }, row);

  // Again: nothing new to read.
  await readCall(deps(calls), 't1', Date.now());
  assert.equal(calls.place, 1);
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), []);
});

test('newer rules read every call again, even from the same source', async () => {
  await logCall('t1');
  const store = d1CallInsightStore(db);
  await store.save(insight({ call_task_id: 't1', contact_id: 'c1', rules_version: 1, gate: 'owner', reached: 1 }));
  assert.deepEqual(await store.needing(10, RULES_VERSION), [{ id: 't1', subject: 'task' }]);
  assert.equal(await readUnreadCalls(deps(), 10, Date.now()), 1);
  const row = await store.get('t1');
  assert.equal(row?.rules_version, RULES_VERSION);
  assert.equal(row?.contact_tz, 'America/Denver', 'what the first read found is kept');
  assert.deepEqual(await store.needing(10, RULES_VERSION), []);
});

test('a WhatsApp message isn’t a call', async () => {
  await logCall('t1', { channel: 'whatsapp_message', outcome: 'sent' });
  assert.equal(await readCall(deps(), 't1', Date.now()), null);
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), []);
  assert.equal(await excludeCall(deps(), 't1', true, Date.now()), false);
});

test('a transcript that lands after the call was read gets it read again', async () => {
  const dials = d1DialStore(db);
  await dials.begin(dial({ contact_label: putThrough.label }), 120);
  await dials.setProspectResult('d1', { sid: 'CA1', status: 'completed', durationSec: 543 });
  await logCall('t1', { dial_id: 'd1', outcome: 'connected', duration_sec: null, notes: putThrough.notes });
  const calls = { place: 0 };

  const first = await readCall(deps(calls), 't1', Date.now());
  assert.equal(first?.source, 'notes');
  assert.equal(first?.at_sec, T0, 'a dialled call is when it started');
  assert.equal(first?.duration_sec, 543, 'the length is Twilio’s');
  assert.equal(first?.label, putThrough.label);
  assert.equal(first?.subject, 'task');
  assert.deepEqual(
    parseTimeline(first?.timeline_json)?.phases.map((p) => p.kind),
    ['call'],
    'no transcript yet: drawn as one segment, as long as the call'
  );

  await dials.setRecording('d1', { sid: 'RE1', durationSec: 543, channels: 2 });
  await dials.beginTranscript('d1', T0, 300);
  await dials.saveTranscript('d1', JSON.stringify(putThrough.turns), '- Lyle says the software is great');
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), [{ id: 't1', subject: 'task' }]);
  const second = await readDialCall(deps(calls), 'd1', Date.now());
  assert.equal(second?.source, 'transcript');
  assert.equal(second?.gatekeeper_name, 'Rex');
  assert.equal(second?.phone_tree_sec, 14);
  assert.equal(second?.talk_sec, 488);
  assert.ok(second!.prospect_talk_share! > 0, 'from Lyle’s part of the call');
  assert.equal(calls.place, 1, 'their time zone is kept from the first read');
  assert.deepEqual(
    parseTimeline(second?.timeline_json)?.phases.map((p) => p.kind),
    ['menu', 'desk', 'hold', 'desk', 'them'],
    'drawn from the transcript now'
  );
  assert.equal(
    (await allCallInsights(db))[0].timeline_json,
    null,
    'the report’s rows come without the drawing; the Calls page reads it by id'
  );
  assert.ok((await callInsightsFor(db, ['t1'])).get('t1')?.timeline_json);
});

test('a slower read from the notes never overwrites the transcript’s', async () => {
  const store = d1CallInsightStore(db);
  await store.save(insight({ call_task_id: 't1', source: 'transcript', opening: 'From the transcript' }));
  await store.save(insight({ call_task_id: 't1', source: 'notes', opening: 'From the notes' }));
  assert.equal((await store.get('t1'))?.opening, 'From the transcript');
  await store.save(insight({ call_task_id: 't1', source: 'transcript', opening: 'Read again' }));
  assert.equal((await store.get('t1'))?.opening, 'Read again');
});

test('a read by older rules that finishes late never overwrites the newer rules’ reading', async () => {
  const store = d1CallInsightStore(db);
  await store.save(insight({ call_task_id: 't1', source: 'notes', opening: 'New rules' }));
  await store.save(
    insight({ call_task_id: 't1', source: 'transcript', rules_version: RULES_VERSION - 1, opening: 'Old rules' })
  );
  assert.equal((await store.get('t1'))?.opening, 'New rules');
  assert.equal((await store.get('t1'))?.rules_version, RULES_VERSION);
});

test('a silent recording’s empty transcript doesn’t keep the call unread', async () => {
  const dials = d1DialStore(db);
  await dials.begin(dial(), 120);
  await dials.setRecording('d1', { sid: 'RE1', durationSec: 0, channels: 2 });
  await dials.beginTranscript('d1', T0, 300);
  await dials.saveTranscript('d1', '[]', null);
  await logCall('t1', { dial_id: 'd1' });
  await readCall(deps(), 't1', Date.now());
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), []);
});

test('a test call is left out of coaching, read again or not, and can be put back', async () => {
  await logCall('test', { notes: 'this was a test call' }, '2026-09-29 16:00:00');
  await logCall('real', {}, '2026-09-28 16:00:00');
  const calls = { place: 0 };
  assert.equal(await excludeCall(deps(calls), 'test', true, Date.now()), true, 'read first, then left out');
  assert.equal(calls.place, 0, 'from D1 alone: HubSpot isn’t asked');
  await readUnreadCalls(deps(), 10, Date.now());
  assert.deepEqual(
    (await allCallInsights(db)).map((r) => r.call_task_id),
    ['real']
  );
  assert.deepEqual(
    (await callInsightsNear(db, 'c1', 'co1')).map((r) => r.call_task_id),
    ['real']
  );

  // Older rules don't bring it back.
  await db.prepare('UPDATE call_insights SET rules_version = 1').run();
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), [{ id: 'real', subject: 'task' }]);
  await readCall(deps(), 'test', Date.now());
  assert.equal((await d1CallInsightStore(db).get('test'))?.excluded, 1, 'reading it again keeps it out');
  assert.equal((await callInsightsFor(db, ['test', 'real', 'none'])).size, 2, 'the Calls page still sees it');

  assert.equal(await excludeCall(deps(), 'test', false, Date.now()), true);
  assert.equal((await allCallInsights(db)).length, 2);
});

test('unread calls are read newest first, a few at a time', async () => {
  await logCall('old', {}, '2026-09-20 16:00:00');
  await logCall('new', {}, '2026-09-29 16:00:00');
  await logCall('mid', {}, '2026-09-25 16:00:00');
  assert.equal(await readUnreadCalls(deps(), 2, Date.now()), 2);
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), [{ id: 'old', subject: 'task' }]);
  assert.deepEqual(
    (await allCallInsights(db)).map((r) => r.call_task_id),
    ['mid', 'new'],
    'the report reads them oldest first'
  );
  assert.deepEqual(
    (await callInsightsNear(db, 'someone-else', 'co1')).map((r) => r.call_task_id),
    ['new', 'mid'],
    'others at the same company count as near'
  );
});

// Nova-3's answer for a transcript: one channel per side.
function nova(lines: Turn[]) {
  const channel = (speaker: Turn['speaker']) => ({
    alternatives: [
      {
        words: lines
          .filter((t) => t.speaker === speaker)
          .flatMap((t) =>
            t.text.split(' ').map((word, i) => ({ word, start: t.start + i * 0.2, end: t.start + i * 0.2 + 0.1 }))
          ),
      },
    ],
  });
  return { results: { channels: [channel('rep'), channel('prospect')] } };
}

test('the sweep finishes a transcription that died, reads the call, and back-fills the rest', async () => {
  const dials = d1DialStore(db);
  const now = (T0 + DAY) * 1000;
  // Stuck "transcribing" since the day before.
  await dials.begin(dial({ contact_label: notAvailable.label }), 120);
  await dials.setProspectResult('d1', { sid: 'CA1', status: 'completed', durationSec: 60 });
  await dials.setRecording('d1', { sid: 'RE1', durationSec: 60, channels: 2 });
  assert.equal(await dials.beginTranscript('d1', T0 + 70, 300), true);
  await logCall('t1', { dial_id: 'd1', outcome: 'busy', notes: 'He said he’s been in meetings all day.' });
  await logCall('t2', { outcome: 'no_answer', notes: '' }, '2026-09-29 15:00:00');
  await logCall('t3', { channel: 'whatsapp_message', outcome: 'sent' });

  const transcribed: string[] = [];
  const sweepDeps = {
    insight: deps(),
    transcribe: {
      dials,
      callLogs: d1CallLogStore(db),
      hs: {} as HubSpot, // the call was never written to HubSpot, so nothing to update
      ai: {
        transcribe: async () => nova(notAvailable.turns),
        summarize: async () => '- Hank is available',
      },
      recording: async (sid: string) => {
        transcribed.push(sid);
        return new Response('mp3');
      },
    },
    baseUrl: ORIGIN,
  };
  assert.deepEqual(await runCoachingSweep(sweepDeps, now), { transcribed: 1, read: 1 });
  assert.deepEqual(transcribed, ['RE1']);
  const read = await d1CallInsightStore(db).get('t1');
  assert.equal(read?.source, 'transcript');
  assert.equal(read?.gatekeeper_name, 'Nina', 'from what was said, not the notes');
  assert.equal((await d1CallInsightStore(db).get('t2'))?.gate, 'no_answer');

  // Nothing left: the next run does nothing.
  assert.deepEqual(await runCoachingSweep(sweepDeps, now + 600_000), { transcribed: 0, read: 0 });
  assert.deepEqual(transcribed, ['RE1']);
  // Without Workers AI or Twilio, it still reads.
  await logCall('t4', {}, '2026-09-30 15:00:00');
  assert.deepEqual(await runCoachingSweep({ ...sweepDeps, transcribe: null }, now), { transcribed: 0, read: 1 });
});

test('after logging, the call page’s notes are read by the rules until the call has been read', async () => {
  await logCall('t1', { title: 'Call with Hank Marlow', outcome: 'busy', notes: onHold.notes, duration_sec: 261 });
  const before = await callNotes(db, 't1');
  assert.equal(before?.label, 'Call with Hank Marlow');
  assert.equal(before?.read.gatekeeper_result, 'on_hold_no_pickup');
  assert.match(before!.notes[0].text, /^The front desk: put you on hold/);

  await readCall(deps(), 't1', Date.now());
  await db.prepare(`UPDATE call_insights SET adjust = 'Ask for his cell first.'`).run();
  const after = await callNotes(db, 't1');
  assert.ok(after!.notes.some((n) => n.text === 'Ask for his cell first.'));
  assert.deepEqual(after?.unsure, []);
  assert.equal(await callNotes(db, 'nothing-logged'), null);
});

test('callFacts takes the length from the log, else from Twilio, and their first name from the label', () => {
  const log = {
    title: 'Call with Ana Díaz',
    outcome: 'connected',
    channel: 'phone',
    notes: ' hi ',
    duration_sec: null,
    next_set_time: 1,
    book_start: null,
  } as unknown as CallLog;
  const f = callFacts(
    log,
    { prospect_status: 'completed', prospect_duration_sec: 90, contact_label: 'Ana Díaz at Díaz Freight' } as never,
    null
  );
  assert.deepEqual(
    { label: f.label, firstName: f.firstName, durationSec: f.durationSec, notes: f.notes, setTime: f.setTime },
    { label: 'Ana Díaz at Díaz Freight', firstName: 'Ana', durationSec: 90, notes: 'hi', setTime: true }
  );
  assert.equal(callFacts(log, null, null).firstName, 'Ana');
});

// --- Interviews booked on calls, followed to how they turned out ---

async function logMeeting(
  meetingId: string,
  outcome: MeetingLog['outcome'],
  createdAt: string,
  newStart: string | null = null,
  canceledBy: MeetingLog['canceled_by'] = null
) {
  const logId = `${meetingId}@${createdAt}`;
  await d1MeetingLogStore(db).create({
    log_id: logId,
    meeting_id: meetingId,
    contact_id: 'c1',
    company_id: null,
    owner_id: null,
    outcome,
    canceled_by: canceledBy,
    notes: '',
    internal_notes_html: '',
    new_start: newStart,
    new_end: null,
    next_type: null,
    next_subject: null,
    next_due: null,
    next_body: null,
    calendar_event_id: null,
  });
  await db.prepare('UPDATE meeting_logs SET created_at = ? WHERE log_id = ?').bind(createdAt, logId).run();
}

async function bookFromCall(taskId: string, meetingId: string, start: string, createdAt: string, invite = 0) {
  await logCall(
    taskId,
    { book_start: start, book_title: 'Interview', book_minutes: 30, book_invite: invite },
    createdAt
  );
  await d1CallLogStore(db).setBookedMeeting(taskId, meetingId);
}

// Six interviews booked from calls, as of Wednesday 2026-10-07.
const BOOKINGS_NOW = Date.parse('2026-10-07T18:00:00Z');

async function sixBookings() {
  // Held: booked two days ahead with an invite, on a 6:40 connect.
  await bookFromCall('t1', 'm1', '2026-10-01T16:00:00.000Z', '2026-09-29 16:05:00', 1);
  await db.prepare("UPDATE call_logs SET book_phone = '+18015550100' WHERE call_task_id = 't1'").run();
  await d1CallInsightStore(db).save(insight({ call_task_id: 't1', talk_sec: 400 }));
  await logMeeting('m1', 'COMPLETED', '2026-10-01 17:00:00');
  // Booked on its own from the call page, then again by a retry of the call's
  // log: one interview. Moved, then canceled.
  const booking = d1MeetingBookingStore(db);
  await booking.create({
    booking_id: 't2@1',
    task_id: 't2',
    contact_id: 'c2',
    company_id: null,
    owner_id: null,
    title: 'Interview with Ana',
    start_at: '2026-10-10T16:00:00.000Z',
    end_at: '2026-10-10T16:30:00.000Z',
    join_url: null,
    phone: null,
    invite: 0,
    invitee_email: null,
  });
  await booking.setMeeting('t2@1', 'm2');
  await db.prepare("UPDATE meeting_bookings SET created_at = '2026-09-29 17:00:00'").run();
  await bookFromCall('t2', 'm2', '2026-10-10T16:00:00.000Z', '2026-09-29 17:10:00');
  await logMeeting('m2', 'RESCHEDULED', '2026-10-09 15:00:00', '2026-10-12T16:00:00.000Z');
  await logMeeting('m2', 'CANCELED', '2026-10-11 15:00:00', null, 'them');
  // Its time passed with nothing logged.
  await bookFromCall('t3', 'm3', '2026-10-02T16:00:00.000Z', '2026-09-29 18:00:00');
  // No-show.
  await bookFromCall('t6', 'm6', '2026-10-01T16:00:00.000Z', '2026-09-30 10:00:00');
  await logMeeting('m6', 'NO_SHOW', '2026-10-01 17:00:00');
  // Still ahead.
  await bookFromCall('t4', 'm4', '2026-10-20T16:00:00.000Z', '2026-10-05 10:00:00');
  // A test call, left out of coaching.
  await bookFromCall('t5', 'm5', '2026-10-03T16:00:00.000Z', '2026-09-30 11:00:00');
  await d1CallInsightStore(db).save(insight({ call_task_id: 't5' }));
  await d1CallInsightStore(db).setExcluded('t5', true);
}

test('each booked interview is read with the outcome last logged for it, once, test calls left out', async () => {
  await sixBookings();
  const rows = await allBookedInterviews(db);
  assert.deepEqual(
    rows.map((r) => r.meeting_id),
    ['m1', 'm2', 'm3', 'm6', 'm4']
  );
  const [m1, m2, m3] = rows;
  assert.deepEqual(
    { ...m1 },
    {
      meeting_id: 'm1',
      call_task_id: 't1',
      contact_id: 'c1',
      label: 'Contact t1',
      booked_sec: Date.parse('2026-09-29T16:05:00Z') / 1000,
      first_start: '2026-10-01T16:00:00.000Z',
      start: '2026-10-01T16:00:00.000Z',
      invite: 1,
      by_phone: 1,
      outcome: 'COMPLETED',
      canceled_by: null,
      moves: 0,
      call_sec: 400,
    }
  );
  assert.equal(m2.call_task_id, 't2');
  assert.equal(m2.label, 'Interview with Ana', 'from its first booking: the call page’s, not the retry’s');
  assert.equal(m2.first_start, '2026-10-10T16:00:00.000Z');
  assert.equal(m2.start, '2026-10-12T16:00:00.000Z', 'at the time it was moved to');
  assert.deepEqual([m2.outcome, m2.canceled_by], ['CANCELED', 'them']);
  assert.equal(m2.moves, 1);
  assert.deepEqual([m3.outcome, m3.call_sec], [null, null]);
  assert.deepEqual(
    (await allBookedInterviews(db, 'c2')).map((r) => r.meeting_id),
    ['m2'],
    'one contact’s'
  );
});

test('bookings followed to how they turned out, by lead time, invite and the booking call’s length', async () => {
  await sixBookings();
  const report = bookingReport(await allBookedInterviews(db), BOOKINGS_NOW);
  assert.deepEqual(
    [report.booked, report.held, report.noShow, report.canceled, report.upcoming, report.toLog, report.moved],
    [5, 1, 1, 1, 1, 1, 1]
  );
  const brief = (splits: typeof report.byLeadTime) =>
    splits.map((s) => [s.key, s.decided, s.held, s.noShow, s.canceled]);
  assert.deepEqual(
    brief(report.byLeadTime),
    [
      ['soon', 2, 1, 1, 0],
      ['later', 1, 0, 0, 1],
    ],
    'measured from the time first booked; ones not ended yet aren’t counted'
  );
  assert.deepEqual(brief(report.byInvite), [
    ['invite', 1, 1, 0, 0],
    ['none', 2, 0, 1, 1],
  ]);
  assert.deepEqual(brief(report.byCallLength), [['long', 1, 1, 0, 0]], 'only the calls read and reached');
  assert.deepEqual(
    report.toLogRows.map((b) => b.meeting_id),
    ['m3']
  );
  assert.deepEqual(
    report.recent.map((r) => [r.booking.meeting_id, r.status]),
    [
      ['m4', 'upcoming'],
      ['m6', 'no_show'],
      ['m3', 'to_log'],
      ['m2', 'they_canceled'],
      ['m1', 'held'],
    ]
  );

  const page = String(
    await coachingPage(
      {
        settings: { timeZone: TZ } as never,
        report: coachingReport(sample(), TZ),
        bookings: report,
        funnel: callFunnel(coachingReport(sample(), TZ), [], 0),
        interviews: [],
        momTest: momTestReport([], []),
        talk: talkReport([]),
        strips: [],
        unread: 0,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /5 booked from your calls: 1 held, 1 no-show,\s+1 canceled by them, 1 still ahead, 1 to log\./);
  assert.match(page, /Of the 3 that ended, 33% were held\./);
  assert.match(page, /Their cancel is a reply/);
  assert.match(page, /<li class="flag">\s*<a href="\/meetings\/m3">/);
  assert.match(page, /moved once/);

  const summary = bookingSummary(report, TZ, ORIGIN);
  assert.deepEqual([summary.booked, summary.theyCanceled, summary.youCanceled, summary.toLog], [5, 1, 0, 1]);
  assert.deepEqual(
    summary.toLogInterviews.map((b) => [b.meetingId, b.url]),
    [['m3', `${ORIGIN}/meetings/m3`]]
  );

  // Bookings show even before any call has been read for coaching.
  const unread = String(
    await coachingPage(
      {
        settings: { timeZone: TZ } as never,
        report: coachingReport([], TZ),
        bookings: report,
        funnel: callFunnel(coachingReport([], TZ), [], 0),
        interviews: [],
        momTest: momTestReport([], []),
        talk: talkReport([]),
        strips: [],
        unread: 1,
      },
      'rep@example.com'
    )
  );
  assert.match(unread, /No calls read yet/);
  assert.match(unread, /5 booked from your calls/);
  assert.deepEqual(summary.byCalendarInvite[1], {
    group: 'No invite',
    ended: 2,
    held: 0,
    noShow: 1,
    theyCanceled: 1,
    heldRate: '0%',
  });
  assert.deepEqual(summary.recent[3], {
    meetingId: 'm2',
    with: 'Interview with Ana',
    bookedAt: summary.recent[3].bookedAt,
    at: summary.recent[3].at,
    status: 'They canceled',
    moved: 1,
    url: `${ORIGIN}/meetings/m2`,
  });
});

test('a booking moved to a time that has passed, with nothing logged since, is to log', () => {
  const now = Date.parse('2026-10-07T18:00:00Z');
  const at = (outcome: MeetingLog['outcome'] | null, start: string, canceled_by: MeetingLog['canceled_by'] = null) =>
    bookingStatus({ outcome, start, canceled_by }, now);
  assert.equal(at('RESCHEDULED', '2026-10-06T16:00:00.000Z'), 'to_log');
  assert.equal(at('RESCHEDULED', '2026-10-08T16:00:00.000Z'), 'upcoming');
  assert.equal(at(null, '2026-10-08T16:00:00.000Z'), 'upcoming');
  assert.equal(at('CANCELED', '2026-10-08T16:00:00.000Z', 'them'), 'they_canceled');
  assert.equal(at('CANCELED', '2026-10-08T16:00:00.000Z'), 'they_canceled', 'logged before the form asked');
  assert.equal(at('CANCELED', '2026-10-08T16:00:00.000Z', 'rep'), 'you_canceled');
});

test('the rep’s own cancel is counted, but left out of the held rate', async () => {
  await sixBookings();
  await db
    .prepare(`UPDATE meeting_logs SET canceled_by = 'rep' WHERE meeting_id = 'm2' AND outcome = 'CANCELED'`)
    .run();
  const report = bookingReport(await allBookedInterviews(db), BOOKINGS_NOW);
  assert.deepEqual([report.canceled, report.youCanceled], [0, 1]);
  assert.deepEqual(
    report.byLeadTime.map((s) => s.key),
    ['soon'],
    'its only group had nothing else ended'
  );
  const page = String(
    await coachingPage(
      {
        settings: { timeZone: TZ } as never,
        report: coachingReport(sample(), TZ),
        bookings: report,
        funnel: callFunnel(coachingReport(sample(), TZ), [], 0),
        interviews: [],
        momTest: momTestReport([], []),
        talk: talkReport([]),
        strips: [],
        unread: 0,
      },
      'rep@example.com'
    )
  );
  assert.match(page, /0 canceled by them, 1 by you/);
  assert.match(page, /Of the 2 that ended, 50% were held\./);
});

test('before calling someone who canceled their interview, the call page says the line is open', async () => {
  await sixBookings();
  const theirs = await allBookedInterviews(db, 'c2');
  const note = lastInterviewNote(theirs, TZ, BOOKINGS_NOW);
  assert.equal(note?.kind, 'tip');
  assert.match(note!.text, /^They canceled the interview for .*Oct 12.*the line is open: offer another time\.$/);
  await db
    .prepare(`UPDATE meeting_logs SET canceled_by = 'rep' WHERE meeting_id = 'm2' AND outcome = 'CANCELED'`)
    .run();
  assert.match(lastInterviewNote(await allBookedInterviews(db, 'c2'), TZ, BOOKINGS_NOW)!.text, /^You canceled/);
  assert.equal(
    lastInterviewNote(await allBookedInterviews(db, 'c1'), TZ, BOOKINGS_NOW),
    null,
    'their last booking is still ahead; a no-show has its own notice'
  );

  const notes = prepNotes({
    report: coachingReport([], TZ),
    near: [],
    contactId: 'c2',
    contactTz: null,
    repTimeZone: TZ,
    now: BOOKINGS_NOW,
    interviews: theirs,
  });
  assert.ok(notes.some((n) => /They canceled the interview/.test(n.text)));
});

// --- The Mom Test: the rules' first pass, for a review to settle ---

// A call that reached them, with the rep asking about the last time, pitching, and them offering an intro.
const momTestCall: Turn[] = [
  { speaker: 'prospect', start: 0, end: 1.5, text: 'hello this is grant' },
  {
    speaker: 'rep',
    start: 2,
    end: 9,
    text: 'hey grant this is anel i build software for trucking companies our software lets you quote faster',
  },
  { speaker: 'prospect', start: 10, end: 10.5, text: 'okay' },
  { speaker: 'rep', start: 12, end: 14, text: 'walk me through the last load you quoted' },
  {
    speaker: 'prospect',
    start: 15,
    end: 70,
    text: 'well last tuesday a broker called about a reefer load to denver and',
  },
  { speaker: 'rep', start: 72, end: 74, text: 'who handles the invoicing' },
  { speaker: 'prospect', start: 75, end: 80, text: 'talk to my wife she does all of that i can give you her number' },
];

test('the Mom Test: the rules hear a question about the last time, a pitch, a story and an intro; the rest stays unsure', () => {
  const read = ruleInsight(
    facts({ label: 'Grant Ives', firstName: 'Grant', durationSec: 82, transcript: { turns: momTestCall, summary: [] } })
  );
  assert.equal(read.reached, 1);
  assert.deepEqual(
    [read.asked_last_time, read.pitched, read.longest_story_sec, read.fluff_caught, read.commitment],
    [1, 1, 55, null, 'intro']
  );
  assert.deepEqual(read.marks.lastTimeAt, [3]);
  assert.deepEqual(read.marks.pitchAt, [1]);
  assert.deepEqual(
    read.unsure,
    ['commitment', 'fluffCaught'],
    'an intro the rules heard still wants a look; fluff always does'
  );

  // A set time is a commitment the rules are sure of; the framing line isn't a pitch.
  const lunch = heard(lunchThenBooked);
  assert.deepEqual([lunch.asked_last_time, lunch.pitched, lunch.commitment], [0, 0, 'time']);
  assert.ok(lunch.longest_story_sec! > 0 && lunch.longest_story_sec! < 60);
  assert.deepEqual(lunch.unsure, ['askedAboutLastTime', 'pitched', 'fluffCaught'], 'not asking isn’t proof');
  // Their number given is a next step, but what they committed is for a review to say.
  const lyle = heard(putThrough);
  assert.equal(lyle.commitment, null);
  assert.ok(lyle.unsure.includes('commitment'));
  // Never reached: nothing to judge, nothing unsure.
  const desk = heard(onHold);
  assert.deepEqual(
    [desk.asked_last_time, desk.pitched, desk.longest_story_sec, desk.fluff_caught, desk.commitment, desk.unsure],
    [null, null, null, null, null, []]
  );
  // No transcript: the rules can't hear it, and don't pretend to.
  const notes = ruleInsight(facts({ notes: 'Talked with Sam, he told me about last week’s quote' }));
  assert.deepEqual([notes.asked_last_time, notes.commitment], [null, null]);
  assert.ok(!notes.unsure.includes('fluffCaught'));
});

test('the Mom Test across calls and interviews: counts of what has been said, the longest story', () => {
  const calls = [
    insight({
      call_task_id: 'a',
      at_sec: T0,
      asked_last_time: 1,
      pitched: 1,
      longest_story_sec: 20,
      commitment: 'time',
    }),
    insight({ call_task_id: 'b', at_sec: T0 + 60, asked_last_time: 0, longest_story_sec: 75, fluff_caught: 1 }),
    insight({ call_task_id: 'c', at_sec: T0 + 120, reached: 0, gate: 'gatekeeper', stage: 'gatekeeper' }),
    insight({ call_task_id: 'w', at_sec: T0 + 180, gate: 'wrong_number', commitment: 'money' }),
  ];
  const interviews = [
    insight({ call_task_id: 'm', subject: 'meeting', at_sec: T0 + 30, longest_story_sec: 130, commitment: 'intro' }),
  ];
  const m = momTestReport(calls, interviews);
  assert.deepEqual(
    m.rows.map((r) => [r.call.call_task_id, r.kind]),
    [
      ['b', 'call'],
      ['m', 'interview'],
      ['a', 'call'],
    ],
    'reached only, newest first; a wrong number isn’t a call'
  );
  assert.deepEqual(
    [m.asked, m.pitched, m.stories, m.fluffCaught, m.commitments],
    [1, 1, 2, 1, { time: 1, intro: 1, money: 0 }]
  );
  assert.equal(m.longest?.call.call_task_id, 'm');
  assert.deepEqual(momTestReport([], []).rows, []);
});

test('a review that says the rules heard wrong takes the pitch and last-time marks off the drawing', () => {
  const drawing = {
    totalSec: 90,
    phases: [{ kind: 'them', from: 0, to: 90, label: null }],
    turns: [{ who: 'prospect', from: 5, to: 80, story: true }],
    marks: [
      { kind: 'opening', at: 2, text: null },
      { kind: 'pitch', at: 2, text: 'our software' },
      { kind: 'last_time', at: 12, text: 'walk me through' },
    ],
    longestStorySec: 75,
  };
  const row = insight({
    call_task_id: 'd1',
    pitched: 1,
    asked_last_time: 1,
    longest_story_sec: 75,
    timeline_json: JSON.stringify(drawing),
  });
  const reviewed = withReviews(row, [
    {
      reviewer: 'claude',
      corrections: { pitched: false, longestStorySec: 40 },
      what_worked: null,
      adjust: null,
      reviewed_at: '2026-10-08T17:00:00Z',
    },
  ]);
  const t = parseTimeline(reviewed.timeline_json)!;
  assert.deepEqual(
    t.marks.map((m) => m.kind),
    ['opening', 'last_time'],
    'the pitch the rules heard wrong is gone; the question stays'
  );
  assert.equal(t.longestStorySec, 40, 'the review’s figure');
  assert.equal(t.turns[0].story, undefined, 'under a minute now: no story tick');
  // Raised to a story the rules hadn't measured: their longest turn gets the tick.
  const short = {
    ...drawing,
    turns: [
      { who: 'prospect', from: 5, to: 40 },
      { who: 'prospect', from: 50, to: 58 },
    ],
    longestStorySec: 35,
  };
  const raised = withReviews(
    insight({ call_task_id: 'd2', longest_story_sec: 35, timeline_json: JSON.stringify(short) }),
    [{ reviewer: 'claude', corrections: { longestStorySec: 70 }, what_worked: null, adjust: null, reviewed_at: '' }]
  );
  assert.deepEqual(
    parseTimeline(raised.timeline_json)!.turns.map((k) => k.story ?? false),
    [true, false]
  );
  // An explicit null clears the story; taking back that they were reached clears the lot.
  const noStory = withReviews(row, [
    { reviewer: 'claude', corrections: { longestStorySec: null }, what_worked: null, adjust: null, reviewed_at: '' },
  ]);
  assert.equal(noStory.longest_story_sec, null);
  assert.equal(parseTimeline(noStory.timeline_json)?.longestStorySec, null, 'the drawing says none too');
  const desk = withReviews(row, [
    {
      reviewer: 'rep',
      corrections: { whoAnswered: 'gatekeeper', reachedThem: false },
      what_worked: null,
      adjust: null,
      reviewed_at: '',
    },
  ]);
  assert.deepEqual(
    [desk.asked_last_time, desk.pitched, desk.longest_story_sec, desk.fluff_caught, desk.commitment],
    [null, null, null, null, null],
    'never reached: nothing to judge'
  );
  assert.deepEqual(
    parseUnsure(desk.unsure).filter(
      (u) => u !== 'whoAnswered' && u !== 'reachedThem' && u !== 'stage' && u !== 'frontDeskResult'
    ),
    [],
    'and nothing unsure about it'
  );
  const deskDrawing = parseTimeline(desk.timeline_json)!;
  assert.deepEqual(
    deskDrawing.marks.map((m) => m.kind),
    ['opening']
  );
  assert.equal(deskDrawing.longestStorySec, null);
  assert.equal(
    withReviews(insight({ call_task_id: 'n', timeline_json: null }), [
      { reviewer: 'rep', corrections: { pitched: false }, what_worked: null, adjust: null, reviewed_at: '' },
    ]).timeline_json,
    null,
    'nothing drawn: nothing to change'
  );
});

test('the review’s transcript stamps each turn start–end, so a story’s length reads off the line', async () => {
  await logCall('t1', { outcome: 'connected', duration_sec: 543, notes: putThrough.notes });
  const log = (await d1CallLogStore(db).get('t1'))!;
  const notes = (await callNotes(db, 't1'))!;
  const call = {
    id: 't1',
    kind: 'call' as const,
    channel: log.channel,
    outcome: log.outcome,
    durationSec: log.duration_sec,
    notes: log.notes,
    nextDue: log.next_due,
  };
  const summary = callReviewSummary(
    { settings: { timeZone: TZ } as never, call, turns: putThrough.turns, summary: [], notes, reviews: [] },
    ORIGIN
  );
  assert.match(
    summary.transcript![0],
    /^\[0:01–0:07\] Prospect: thank you for calling/,
    'capped by its words, not the 14 s gap'
  );
  assert.match(summary.transcript![9], /^\[0:56–1:30\] You: yeah so basically lyle/);
  assert.match(summary.rules, /stamped \[start–end\]/);
});

test('a review settles the Mom Test over the rules', () => {
  const row = insight({
    call_task_id: 'm1',
    asked_last_time: 0,
    pitched: 0,
    longest_story_sec: 14,
    fluff_caught: null,
    commitment: 'time',
    unsure: JSON.stringify(['askedAboutLastTime', 'pitched', 'fluffCaught']),
  });
  const reviewed = withReviews(row, [
    {
      reviewer: 'claude',
      corrections: { askedAboutLastTime: true, longestStorySec: 95, fluffCaught: false, commitment: 'intro' },
      what_worked: null,
      adjust: 'When he says “we usually”, ask when it last happened.',
      reviewed_at: '2026-10-08T17:00:00Z',
    },
  ]);
  assert.deepEqual(
    [
      reviewed.asked_last_time,
      reviewed.pitched,
      reviewed.longest_story_sec,
      reviewed.fluff_caught,
      reviewed.commitment,
    ],
    [1, 0, 95, 0, 'intro']
  );
  assert.deepEqual(parseUnsure(reviewed.unsure), ['pitched'], 'the review said nothing about pitching');
  const by = parseSources(reviewed.sources);
  assert.deepEqual(
    [by.askedAboutLastTime?.by, by.longestStorySec?.by, by.fluffCaught?.by, by.commitment?.by, by.pitched],
    ['claude', 'claude', 'claude', 'claude', undefined]
  );
  const tags = String(callTags(reviewed, parseUnsure(reviewed.unsure)));
  assert.match(tags, /Asked about the last time · Story 1:35 · They gave an intro/);
  assert.doesNotMatch(tags, /Pitched|Caught the fluff/);
  assert.match(tags, /Not sure of whether you pitched/);
});

// --- Interviews: the call made from an interview's page, read like a cold call ---

test('an interview’s call is read once it ended, keyed by the meeting, with how the rep logged it', async () => {
  const dials = d1DialStore(db);
  await dials.begin(
    dial({ id: 'dm', task_id: 'm1', subject: 'meeting', contact_label: putThrough.label, started_sec: T0 + 3 * DAY }),
    120
  );
  await dials.setProspectResult('dm', { sid: 'CA9', status: 'completed', durationSec: 543 });
  await dials.setRecording('dm', { sid: 'RE9', durationSec: 543, channels: 2 });
  await dials.beginTranscript('dm', T0, 300);
  await dials.saveTranscript('dm', JSON.stringify(putThrough.turns), null);
  const calls = { place: 0 };

  assert.deepEqual(
    await d1CallInsightStore(db).needing(10, RULES_VERSION),
    [{ id: 'm1', subject: 'meeting' }],
    'the ended call wants reading'
  );
  assert.equal(await readUnreadCalls(deps(calls), 10, Date.now()), 1);
  const row = await d1CallInsightStore(db).get('m1');
  assert.equal(row?.subject, 'meeting');
  assert.equal(row?.source, 'transcript');
  assert.equal(row?.outcome, 'connected', 'not logged yet: the call itself answered');
  assert.equal(row?.at_sec, T0 + 3 * DAY);
  assert.equal(row?.reached, 1);
  assert.equal(row?.label, putThrough.label);
  assert.ok(row?.timeline_json, 'drawn like any call');
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), []);
  assert.deepEqual(await allCallInsights(db), [], 'not a cold call: the report doesn’t count it');
  assert.equal((await allCallInsights(db, 'meeting')).length, 1);
  assert.deepEqual(
    (await callsToReview(db, 10)).map((c) => [c.call_task_id, c.subject]),
    [['m1', 'meeting']],
    'reviewed from the connector like a call'
  );

  // Logged as a no-show afterwards: the outcome is the log's.
  await logMeeting('m1', 'NO_SHOW', '2026-10-02 17:00:00');
  const logged = await readInterview(deps(calls), 'm1', Date.now(), { reread: true });
  assert.equal(logged?.outcome, 'no_answer');
  assert.equal(logged?.reached, 0);
  assert.equal(calls.place, 1, 'their time zone kept from the first read');

  // Its transcript landing reads it; a test interview can be left out; a review lands on it.
  assert.equal((await readDialCall(deps(), 'dm', Date.now()))?.call_task_id, 'm1');
  const reviewed = await reviewCall(
    deps(),
    'm1',
    {
      reviewer: 'rep',
      corrections: { reachedThem: true },
      what_worked: null,
      adjust: null,
      reviewed_at: '2026-10-03T00:00:00Z',
    },
    Date.now()
  );
  assert.equal(reviewed?.reached, 1);
  assert.equal(await excludeCall(deps(), 'm1', true, Date.now()), true);
  assert.deepEqual(await callsToReview(db, 10), []);
  assert.equal(await readInterview(deps(), 'none', Date.now()), null);
  const nothing = { reviewer: 'rep' as const, corrections: {}, what_worked: null, adjust: null, reviewed_at: '' };
  assert.equal(await reviewCall(deps(), 'none', nothing, Date.now()), null, 'nothing to review');
});

test('an interview read once is read again after a redial, a later log, or when its dial timed out', async () => {
  const dials = d1DialStore(db);
  const store = d1CallInsightStore(db);
  await dials.begin(dial({ id: 'first', task_id: 'm1', subject: 'meeting', started_sec: T0 }), 120);
  await dials.setProspectResult('first', { sid: 'CA1', status: 'no-answer', durationSec: null });
  assert.equal((await readInterview(deps(), 'm1', Date.now()))?.dial_id, 'first');
  assert.deepEqual(await store.needing(10, RULES_VERSION), [], 'read');

  // A redial from the page: the row is of the earlier call, so it's read again.
  await dials.begin(dial({ id: 'second', task_id: 'm1', subject: 'meeting', started_sec: T0 + 1800 }), 120);
  await dials.setProspectResult('second', { sid: 'CA2', status: 'completed', durationSec: 600 });
  assert.deepEqual(await store.needing(10, RULES_VERSION), [{ id: 'm1', subject: 'meeting' }], 'a newer dial');
  const again = await readInterview(deps(), 'm1', Date.now());
  assert.deepEqual([again?.dial_id, again?.outcome], ['second', 'connected']);
  assert.deepEqual(await store.needing(10, RULES_VERSION), []);

  // Logged as a no-show after the read, in the same second as the read even:
  // a log the reading wasn't made with, so it's read again.
  const readAt = (await store.get('m1'))!.extracted_at;
  await logMeeting('m1', 'NO_SHOW', readAt.slice(0, 19).replace('T', ' '));
  assert.deepEqual(await store.needing(10, RULES_VERSION), [{ id: 'm1', subject: 'meeting' }], 'logged since');
  const logged = await readInterview(deps(), 'm1', Date.now());
  assert.deepEqual(
    [logged?.outcome, logged?.meeting_log_id],
    ['no_answer', `m1@${readAt.slice(0, 19).replace('T', ' ')}`]
  );
  assert.deepEqual(await store.needing(10, RULES_VERSION), [], 'read with the log');

  // A dial whose final statuses never came: ended once it's older than the timeout, for the sweep too.
  await dials.begin(dial({ id: 'lost', task_id: 'm2', subject: 'meeting', started_sec: T0 }), 120);
  assert.deepEqual(await store.needing(10, RULES_VERSION), [], 'no status, no cutoff given: not yet');
  assert.deepEqual(
    await store.needing(10, RULES_VERSION, T0 + 1),
    [{ id: 'm2', subject: 'meeting' }],
    'past the cutoff'
  );
  assert.equal(await readUnreadCalls(deps(), 10, Date.now()), 1, 'the sweep reads it');
});

test('an interview dialled again is a new call: its reading replaces the first’s, and the first’s review isn’t its', async () => {
  const dials = d1DialStore(db);
  const store = d1CallInsightStore(db);
  // First attempt, recorded and reviewed.
  await dials.begin(
    dial({ id: 'first', task_id: 'm1', subject: 'meeting', contact_label: putThrough.label, started_sec: T0 }),
    120
  );
  await dials.setProspectResult('first', { sid: 'CA1', status: 'completed', durationSec: 543 });
  await dials.setRecording('first', { sid: 'RE1', durationSec: 543, channels: 2 });
  await dials.beginTranscript('first', T0, 300);
  await dials.saveTranscript('first', JSON.stringify(putThrough.turns), null);
  const first = await reviewCall(
    deps(),
    'm1',
    {
      reviewer: 'claude',
      corrections: { stage: 'next_step' },
      what_worked: 'Asked about dispatch.',
      adjust: null,
      reviewed_at: '2026-10-01T00:00:00Z',
    },
    Date.now()
  );
  assert.deepEqual([first?.dial_id, first?.source, first?.stage], ['first', 'transcript', 'next_step']);
  assert.equal((await d1CallReviewStore(db).list('m1'))[0].dial_id, 'first', 'the review is of that call');
  assert.deepEqual(await callsToReview(db, 10), [], 'reviewed');

  // Dialled again a week later, not recorded: a new call, read on its own.
  await dials.begin(
    dial({
      id: 'second',
      task_id: 'm1',
      subject: 'meeting',
      contact_label: putThrough.label,
      started_sec: T0 + 7 * DAY,
    }),
    120
  );
  await dials.setProspectResult('second', { sid: 'CA2', status: 'completed', durationSec: 300 });
  assert.deepEqual(await store.needing(10, RULES_VERSION), [{ id: 'm1', subject: 'meeting' }]);
  const second = await readInterview(deps(), 'm1', Date.now());
  assert.deepEqual([second?.dial_id, second?.source], ['second', 'outcome'], 'replaced, though read from less');
  assert.deepEqual(
    [second?.stage, second?.what_worked],
    ['conversation', null],
    'five minutes by length; the first call’s review isn’t laid over it'
  );
  assert.deepEqual(await store.needing(10, RULES_VERSION), [], 'and it stays read');
  assert.deepEqual(
    (await callsToReview(db, 10)).map((c) => c.call_task_id),
    ['m1'],
    'the new call wants its own review'
  );
  assert.deepEqual(await d1CallReviewStore(db).list('m1', 'second'), [], 'none of it yet');
  assert.equal((await d1CallReviewStore(db).list('m1', 'first')).length, 1, 'the first call’s still stands for it');
});

test('an interview’s call still going isn’t read; one not recorded reads the rep’s notes on it', async () => {
  const dials = d1DialStore(db);
  const nowSec = Math.floor(Date.now() / 1000);
  await dials.begin(dial({ id: 'live', task_id: 'm2', subject: 'meeting', started_sec: nowSec - 30 }), 120);
  await dials.setRepCallSid('live', 'CA2');
  assert.equal(await readInterview(deps(), 'm2', Date.now()), null, 'still ringing');
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), []);

  await dials.begin(dial({ id: 'plain', task_id: 'm3', subject: 'meeting', started_sec: T0 }), 120);
  await dials.setProspectResult('plain', { sid: 'CA3', status: 'completed', durationSec: 900 });
  await logMeeting('m3', 'COMPLETED', '2026-09-29 17:00:00');
  await db
    .prepare(`UPDATE meeting_logs SET notes = ? WHERE meeting_id = 'm3'`)
    .bind('Talked with Hank. He said their problem is drivers, not software. Call back next month.')
    .run();
  const row = await readInterview(deps(), 'm3', Date.now());
  assert.equal(row?.source, 'notes');
  assert.equal(row?.outcome, 'connected');
  assert.equal(row?.duration_sec, 900);
  assert.ok(row?.objection_kind, 'the objection, from the notes');
});

// --- What they've told the rep: the sources ---

test('what you’ve heard reads every reached call and interview with its transcript and the rep’s notes', async () => {
  const dials = d1DialStore(db);
  await dials.begin(dial({ contact_label: putThrough.label }), 120);
  await dials.setProspectResult('d1', { sid: 'CA1', status: 'completed', durationSec: 543 });
  await dials.setRecording('d1', { sid: 'RE1', durationSec: 543, channels: 2 });
  await dials.beginTranscript('d1', T0, 300);
  await dials.saveTranscript('d1', JSON.stringify(putThrough.turns), null);
  await logCall('t1', { dial_id: 'd1', outcome: 'connected', duration_sec: null, notes: putThrough.notes });
  await logCall('t2', { outcome: 'busy', notes: 'Front desk, not available' }, '2026-09-28 16:00:00');
  await dials.begin(
    dial({ id: 'dm', task_id: 'm1', subject: 'meeting', contact_label: 'Grant Ives', started_sec: T0 + DAY }),
    120
  );
  await dials.setProspectResult('dm', { sid: 'CA9', status: 'completed', durationSec: 900 });
  await logMeeting('m1', 'COMPLETED', '2026-09-30 17:00:00');
  await db
    .prepare(`UPDATE meeting_logs SET notes = 'He said they run everything on spreadsheets.' WHERE meeting_id = 'm1'`)
    .run();
  await readUnreadCalls(deps(), 10, Date.now());

  const rows = await heardSources(db);
  assert.deepEqual(
    rows.map((r) => [r.call_task_id, r.subject, r.transcript_json !== null, r.notes]),
    [
      ['m1', 'meeting', false, 'He said they run everything on spreadsheets.'],
      ['t1', 'task', true, putThrough.notes],
    ],
    'newest first; the front desk call never reached them'
  );
});

// --- Reviews: Claude's or the rep's, laid over the rules' reading ---

test('a review answers tags over the rules, the rep’s over Claude’s, and they’re no longer unsure', () => {
  const row = insight({
    call_task_id: 'r1',
    gate: 'gatekeeper',
    gatekeeper_result: null,
    reached: 0,
    stage: 'gatekeeper',
    unsure: JSON.stringify(['whoAnswered', 'frontDeskResult', 'reachedThem']),
    sources: JSON.stringify({ whoAnswered: { by: 'rules', p: null } }),
  });
  const reviewed = withReviews(row, [
    {
      reviewer: 'rep',
      corrections: { stage: 'next_step' },
      what_worked: null,
      adjust: 'Ask for his cell before the hold.',
      reviewed_at: '2026-10-07T18:00:00Z',
    },
    {
      reviewer: 'claude',
      corrections: {
        frontDeskResult: 'put_through',
        reachedThem: true,
        stage: 'conversation',
        objection: { kind: 'busy', said: 'call me back in an hour' },
        nextStep: { agreed: true, what: 'Call back at 3' },
      },
      what_worked: 'Asked for him by first name.',
      adjust: 'Leave with a time.',
      reviewed_at: '2026-10-07T17:00:00Z',
    },
  ]);
  assert.equal(reviewed.gatekeeper_result, 'put_through');
  assert.equal(reviewed.reached, 1);
  assert.equal(reviewed.stage, 'next_step', 'the rep’s wins');
  assert.deepEqual(
    [reviewed.objection_kind, reviewed.objection, reviewed.got_past_objection],
    ['busy', 'call me back in an hour', 1]
  );
  assert.deepEqual([reviewed.next_step, reviewed.next_step_text], [1, 'Call back at 3']);
  assert.equal(reviewed.what_worked, 'Asked for him by first name.', 'the rep said nothing about it');
  assert.equal(reviewed.adjust, 'Ask for his cell before the hold.');
  assert.deepEqual(parseUnsure(reviewed.unsure), ['whoAnswered'], 'nobody answered who picked up');
  const sources = parseSources(reviewed.sources);
  assert.deepEqual([sources.stage?.by, sources.reachedThem?.by, sources.whoAnswered?.by], ['rep', 'claude', 'rules']);
  assert.equal(withReviews(row, []), row, 'no review: the rules’ reading as it was');
});

test('what worked and what to adjust are credited to the review that said them', () => {
  const claude = {
    reviewer: 'claude' as const,
    corrections: { stage: 'conversation' as const },
    what_worked: 'Asked about dispatch.',
    adjust: null,
    reviewed_at: '2026-10-07T17:00:00Z',
  };
  const rep = {
    reviewer: 'rep' as const,
    corrections: {},
    what_worked: null,
    adjust: 'Ask for his cell.',
    reviewed_at: '2026-10-07T18:00:00Z',
  };
  assert.deepEqual(
    feedbackBy([claude, rep]),
    { whatWorked: 'claude', adjust: 'rep' },
    'the rep’s text, though Claude set a tag'
  );
  assert.deepEqual(
    feedbackBy([
      { ...claude, what_worked: 'Kept it short.' },
      { ...rep, what_worked: 'Named the load.' },
    ]).whatWorked,
    'rep'
  );
  assert.deepEqual(feedbackBy([]), { whatWorked: null, adjust: null });
});

test('a review is saved, survives the rules reading the call again, and a new one replaces it whole', async () => {
  await logCall('t1');
  const first = await reviewCall(
    deps(),
    't1',
    {
      reviewer: 'claude',
      corrections: { stage: 'conversation', objection: { kind: 'not_now' } },
      what_worked: 'Let them talk about dispatch.',
      adjust: null,
      reviewed_at: '2026-10-07T17:00:00Z',
    },
    Date.now()
  );
  assert.equal(first?.stage, 'conversation');
  assert.equal(first?.objection_kind, 'not_now');
  assert.equal(first?.what_worked, 'Let them talk about dispatch.');

  // The sweep reads it again (newer rules, say): the review stays.
  const again = await readCall(deps(), 't1', Date.now(), { reread: true });
  assert.equal(again?.stage, 'conversation');
  assert.equal((await d1CallInsightStore(db).get('t1'))?.what_worked, 'Let them talk about dispatch.');
  assert.deepEqual(await callsToReview(db, 10), [], 'reviewed: off the list');
  // A review from before the review rules could answer the new tags brings
  // the call back to the list; reviewing again takes it off.
  await db.prepare(`UPDATE call_reviews SET rules_version = 0 WHERE call_task_id = 't1'`).run();
  assert.deepEqual(
    (await callsToReview(db, 10)).map((c) => c.call_task_id),
    ['t1'],
    'reviewed under older rules: back on the list'
  );
  // Asked again only for what's new, the review answers only that: its
  // corrections go over the earlier ones rather than replacing them.
  const refreshed = await reviewCall(
    deps(),
    't1',
    {
      reviewer: 'claude',
      corrections: { commitment: 'time' },
      what_worked: null,
      adjust: null,
      reviewed_at: '2026-10-08T19:00:00Z',
    },
    Date.now()
  );
  assert.deepEqual(
    [refreshed?.stage, refreshed?.commitment],
    ['conversation', 'time'],
    'the old stage kept, the new tag added'
  );
  assert.deepEqual((await d1CallReviewStore(db).list('t1'))[0].corrections, {
    stage: 'conversation',
    objection: { kind: 'not_now' },
    commitment: 'time',
  });
  assert.deepEqual(await callsToReview(db, 10), [], 'reviewed under the current rules again');

  // Claude's second review drops the stage: the rules' stage is back.
  const replaced = await reviewCall(
    deps(),
    't1',
    {
      reviewer: 'claude',
      corrections: {},
      what_worked: null,
      adjust: 'Leave with a time.',
      reviewed_at: '2026-10-07T18:00:00Z',
    },
    Date.now()
  );
  assert.equal(
    replaced?.stage,
    (
      await readCall({ ...deps(), reviews: { list: async () => [], save: async () => {} } }, 't1', Date.now(), {
        reread: true,
      })
    )?.stage
  );
  assert.equal(replaced?.objection_kind, 'busy', 'from the notes, as the rules read them');
  assert.equal(
    await reviewCall(
      deps(),
      'none',
      { reviewer: 'rep', corrections: {}, what_worked: null, adjust: null, reviewed_at: '' },
      Date.now()
    ),
    null
  );
});

test('a review’s next step moves how far it got, unless it says how far', () => {
  const agreedAt = insight({ call_task_id: 'n1', stage: 'next_step', next_step: 1, next_step_text: 'Call back at 3' });
  const review = (corrections: Corrections) => [
    { reviewer: 'claude' as const, corrections, what_worked: null, adjust: null, reviewed_at: '2026-10-07T17:00:00Z' },
  ];
  assert.equal(withReviews(agreedAt, review({ nextStep: { agreed: false } })).stage, 'conversation');
  assert.equal(withReviews(agreedAt, review({ nextStep: { agreed: false }, stage: 'opening' })).stage, 'opening');
  const opening = insight({
    call_task_id: 'n2',
    stage: 'opening',
    unsure: JSON.stringify(['stage', 'nextStep']),
    sources: JSON.stringify({ stage: { by: 'rules', p: null } }),
  });
  const moved = withReviews(opening, review({ nextStep: { agreed: true, what: 'Gave his cell' } }));
  assert.equal(moved.stage, 'next_step');
  assert.deepEqual(parseUnsure(moved.unsure), [], 'the stage it moved is settled too');
  assert.equal(parseSources(moved.sources).stage?.by, 'claude');
  const kept = withReviews(agreedAt, review({ nextStep: { agreed: true } }));
  assert.equal(parseSources(kept.sources).stage, undefined, 'a stage it didn’t move stays the rules’');
  const desk = insight({ call_task_id: 'n3', gate: 'gatekeeper', reached: 0, stage: 'gatekeeper' });
  assert.equal(withReviews(desk, review({ nextStep: { agreed: true } })).stage, 'gatekeeper', 'never reached: stays');
});

test('a review over a call whose stored reading is from a better source is saved over that one', async () => {
  await logCall('t1'); // notes only, no dial
  const transcript = insight({
    call_task_id: 't1',
    contact_id: 'c1',
    source: 'transcript',
    stage: 'opening',
    opening: 'hey grant this is anel',
  });
  await d1CallInsightStore(db).save(transcript);
  const reviewed = await reviewCall(
    deps(),
    't1',
    {
      reviewer: 'claude',
      corrections: { stage: 'conversation' },
      what_worked: null,
      adjust: null,
      reviewed_at: '2026-10-07T17:00:00Z',
    },
    Date.now()
  );
  const stored = await d1CallInsightStore(db).get('t1');
  assert.deepEqual(
    [stored?.source, stored?.stage, stored?.opening],
    ['transcript', 'conversation', 'hey grant this is anel']
  );
  assert.deepEqual({ ...stored }, reviewed, 'what was saved is what came back');
});

test('the hours note stays until two hours have enough calls to compare', async () => {
  const at = (hour: number, n: number) =>
    Array.from({ length: n }, (_, i) => insight({ call_task_id: `p${hour}-${i}`, at_sec: T0 + (hour - 10) * HOUR }));
  const page = async (rows: CallInsight[]) => {
    const report = coachingReport(rows, TZ);
    const overview = {
      settings: { timeZone: TZ } as never,
      report,
      bookings: bookingReport([], 0),
      funnel: callFunnel(report, [], 0),
      interviews: [],
      momTest: momTestReport([], []),
      talk: talkReport([]),
      strips: [],
      unread: 0,
    };
    return String(await coachingPage(overview, 'rep@example.com'));
  };
  assert.match(
    await page([...at(10, HOUR_SAMPLE), ...at(14, 5)]),
    /Too few calls to pick an hour by yet/,
    'one busy hour'
  );
  assert.doesNotMatch(await page([...at(10, HOUR_SAMPLE), ...at(14, HOUR_SAMPLE)]), /Too few calls to pick an hour/);
});

test('a review saved before the call was read still shows, read from the rules on the spot', async () => {
  await logCall('t1');
  await d1CallReviewStore(db).save('t1', {
    reviewer: 'rep',
    corrections: { stage: 'conversation' },
    what_worked: null,
    adjust: 'Leave with a time.',
    reviewed_at: '2026-10-07T17:00:00Z',
  });
  assert.equal(await d1CallInsightStore(db).get('t1'), null, 'not read yet');
  const notes = await callNotes(db, 't1');
  assert.equal(notes?.read.stage, 'conversation');
  assert.equal(notes?.sources.stage?.by, 'rep');
  assert.ok(!notes?.unsure.includes('stage'));
  assert.deepEqual(notes?.feedbackBy, { whatWorked: null, adjust: 'rep' });
  assert.ok(notes?.notes.some((n) => n.text === 'Leave with a time.'));
});

test('a review that lands while the sweep reads the call isn’t overwritten by the sweep', async () => {
  await logCall('t1');
  const review = {
    reviewer: 'rep' as const,
    corrections: { stage: 'conversation' as const },
    what_worked: null,
    adjust: null,
    reviewed_at: '2026-10-07T17:00:00Z',
  };
  const plain = deps();
  let raced = false;
  // review_call runs, and finishes, between the sweep's look at the reviews and its save.
  const sweep: InsightDeps = {
    ...plain,
    insights: {
      ...plain.insights,
      save: async (row) => {
        if (!raced) {
          raced = true;
          await reviewCall(plain, 't1', review, Date.now());
        }
        await plain.insights.save(row);
      },
    },
  };
  const read = await readCall(sweep, 't1', Date.now(), { reread: true });
  assert.ok(raced);
  assert.equal(read?.stage, 'conversation');
  assert.equal((await d1CallInsightStore(db).get('t1'))?.stage, 'conversation', 'the stored reading keeps the review');
});

test('who did the talking counts every recorded connect; the bars are the latest', () => {
  const rows = Array.from({ length: 14 }, (_, i) =>
    insight({ call_task_id: `w${i}`, at_sec: T0 + i * HOUR, prospect_talk_share: i < 4 ? 0.7 : 0.3 })
  );
  const report = coachingReport(rows, TZ);
  assert.equal(report.talk.length, 12);
  assert.deepEqual(report.theyLed, { calls: 4, of: 14 }, 'the four oldest led, though none is among the latest twelve');
});

test('a review whose read failed shows at once, and the sweep reads the call again for it', async () => {
  await logCall('t1');
  const first = await readCall(deps(), 't1', Date.parse('2026-10-07T16:00:00Z'));
  assert.notEqual(first?.stage, 'conversation');
  // review_call saved this, then its read failed.
  await d1CallReviewStore(db).save('t1', {
    reviewer: 'claude',
    corrections: { stage: 'conversation' },
    what_worked: 'Asked about their last load.',
    adjust: null,
    reviewed_at: '2026-10-07T17:00:00Z',
  });
  const notes = await callNotes(db, 't1');
  assert.equal(notes?.read.stage, 'conversation', 'shown with the review');
  assert.equal(notes?.read.what_worked, 'Asked about their last load.');

  assert.deepEqual(
    await d1CallInsightStore(db).needing(10, RULES_VERSION),
    [{ id: 't1', subject: 'task' }],
    'reviewed since its read'
  );
  assert.equal(await readUnreadCalls(deps(), 10, Date.parse('2026-10-07T17:10:00Z')), 1);
  assert.equal((await d1CallInsightStore(db).get('t1'))?.stage, 'conversation', 'stored with it');
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), [], 'and not read again after');
});

test('a replacement review whose read failed drops what the old review said', async () => {
  await logCall('t1');
  const rules = await readCall(deps(), 't1', Date.now());
  await reviewCall(
    deps(),
    't1',
    {
      reviewer: 'claude',
      corrections: { stage: 'opening' },
      what_worked: null,
      adjust: 'Old advice.',
      reviewed_at: new Date().toISOString(),
    },
    Date.now()
  );
  assert.equal((await d1CallInsightStore(db).get('t1'))?.stage, 'opening');
  // Claude's new review says nothing of the stage; its read failed.
  await d1CallReviewStore(db).save('t1', {
    reviewer: 'claude',
    corrections: {},
    what_worked: null,
    adjust: null,
    reviewed_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const notes = await callNotes(db, 't1');
  assert.equal(notes?.read.stage, rules?.stage, 'the rules’ stage, not the old review’s');
  assert.equal(notes?.read.adjust, null);
  assert.deepEqual(notes?.feedbackBy, { whatWorked: null, adjust: null });
});
