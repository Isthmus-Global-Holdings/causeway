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
  firstNameOf,
  parseSources,
  parseUnsure,
  phoneTree,
  ruleInsight,
  RULES_VERSION,
  transcriptStats,
  type CallFacts,
} from '../src/lib/call-insight.ts';
import { bestHour, callBrief, coachingReport, describeCall, hourLabel, prepNotes } from '../src/lib/coaching.ts';
import {
  allCallInsights,
  callInsightsFor,
  callInsightsNear,
  d1CallInsightStore,
  d1CallLogStore,
  d1DialStore,
  type CallInsight,
  type CallLog,
  type NewCallLog,
  type NewDial,
} from '../src/lib/db.ts';
import type { HubSpot } from '../src/lib/hubspot.ts';
import type { Turn } from '../src/lib/transcript.ts';
import { afterCallSummary, beforeCallSummary } from '../src/mcp/format.ts';
import { coachingCard, coachingPage } from '../src/views/coaching.ts';
import {
  excludeCall,
  readCall,
  readDialCall,
  readUnreadCalls,
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
    prospect_talk_share: null,
    rep_questions: null,
    you_focus: null,
    source: 'notes',
    rules_version: RULES_VERSION,
    unsure: '[]',
    sources: '{}',
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
  assert.equal(bestHour(report.byHour)?.hour, 14);
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
  assert.match(
    text,
    /It’s 10 AM for them \(Mountain\)\. Calls at this hour have reached the person 2 of 5 times\. Your best hour so far is 2 PM \(3 of 3\)\./
  );
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
    bestHour: '2 PM, 3 of 3',
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

test('the Coaching page and the call page’s card', async () => {
  const report = coachingReport(sample(), TZ);
  const page = String(
    await coachingPage({ settings: { timeZone: TZ } as never, report, unread: 2 }, 'rep@example.com')
  );
  assert.match(page, /<h1>Coaching<\/h1>/);
  assert.match(page, /being read in the background/);
  assert.match(page, /A front desk answered 2 calls and put you through on\s+1 \(50%\)/);
  assert.match(page, /2 of 5 connects ended under\s+1:30/);
  assert.match(page, /Lyle Moss/);
  assert.match(page, /aria-current="page">Coaching/);

  const empty = String(await coachingCard({ before: [], brief: null, after: null }));
  assert.equal(empty, '');
  const read = { ...heard(onHold), duration_sec: 261, label: 'Hank Marlow' };
  const coaching: CallCoaching = {
    before: [{ kind: 'tip', text: 'It’s 10 AM for them.' }],
    brief: null,
    after: { label: 'Hank Marlow', read, unsure: ['objection'], sources: {}, notes: adjustNotes(read) },
  };
  const card = String(await coachingCard(coaching));
  assert.match(card, /After the call with Hank Marlow/);
  assert.match(card, /Front desk \(Hugo\): put you on hold, and they never came on · Phone menu 0:43/);
  assert.match(card, /Not sure of the objection/);
  assert.match(card, /<li class="flag">Hugo at the front desk/);
  assert.ok(card.indexOf('After the call') < card.indexOf('Before this call'));
});

test('after the call, the connector gets the tags, who decided them, and the follow-up’s time', () => {
  const read = { ...heard(phoneMenuCallBack), duration_sec: 92, label: 'Grant Ives' };
  const summary = afterCallSummary(
    { label: 'Grant Ives', read, unsure: [], sources: { stage: { by: 'rules', p: null } }, notes: adjustNotes(read) },
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
      talkedAboutTheirWorld: null,
      openedUp: null,
    }
  );
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
    insights: d1CallInsightStore(db),
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
  assert.deepEqual(await store.needing(10, RULES_VERSION), ['t1']);
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

  await dials.setRecording('d1', { sid: 'RE1', durationSec: 543, channels: 2 });
  await dials.beginTranscript('d1', T0, 300);
  await dials.saveTranscript('d1', JSON.stringify(putThrough.turns), '- Lyle says the software is great');
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), ['t1']);
  const second = await readDialCall(deps(calls), 'd1', Date.now());
  assert.equal(second?.source, 'transcript');
  assert.equal(second?.gatekeeper_name, 'Rex');
  assert.equal(second?.phone_tree_sec, 14);
  assert.equal(second?.talk_sec, 488);
  assert.ok(second!.prospect_talk_share! > 0, 'from Lyle’s part of the call');
  assert.equal(calls.place, 1, 'their time zone is kept from the first read');
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
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), ['real']);
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
  assert.deepEqual(await d1CallInsightStore(db).needing(10, RULES_VERSION), ['old']);
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
