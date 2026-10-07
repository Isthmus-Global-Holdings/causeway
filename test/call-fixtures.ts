// Calls from the rep's own pipeline, transcribed by Nova-3 (lowercase, no
// punctuation, two channels), with every name, company and number changed.
// Each is a case the coaching rules once misread.

import type { Turn } from '../src/lib/transcript.ts';

export interface CallFixture {
  label: string;
  outcome: string;
  durationSec: number;
  notes: string;
  turns: Turn[];
}

const t = (...lines: [Turn['speaker'], number, string][]): Turn[] =>
  lines.map(([speaker, start, text]) => ({ speaker, start, text }));

export const onHold: CallFixture = {
  label: 'Hank Marlow at Marlow Trucking',
  outcome: 'connected',
  durationSec: 261,
  notes: 'They transferred me to him but he never picked up',
  turns: t(
    [
      'prospect',
      0.2,
      'monday through friday 7am to 5pm our menu options have recently changed please listen closely and select from one of the following options for customer service or load tracking please press 1 for dispatch please press 2 for safety or marlow express please press 3 for the shop please press 4 for hr recruiting or accounts payable please press 5 for accounts receivable or billing please press 6 for all other inquiries or to',
    ],
    ['prospect', 43.3, 'marlow trucking this is hugo'],
    ['rep', 45.1, 'hi hugo is hank available'],
    ['prospect', 48.4, "he is he's on the other line though can you hang on for a second"],
    ['rep', 51.8, 'yeah for sure'],
    ['prospect', 53.2, 'alright one minute']
  ),
};

export const notAvailable: CallFixture = {
  label: 'Hank Marlow at Marlow Trucking',
  outcome: 'connected',
  durationSec: 60,
  notes: "Talked with Nina, Hank is not available right now. I said I'd call back later",
  turns: t(
    [
      'prospect',
      0.2,
      'monday through friday 7am to 5pm our menu options have recently changed please listen closely and select from one of the following options for customer service or load tracking please press 1 for dispatch please press 2 for safety or marlow express please press 3 for the shop please press 4 for hr recruiting or accounts payable please press 5 for accounts',
    ],
    ['prospect', 35.8, 'marlow'],
    ['rep', 36.0, 'yes'],
    ['prospect', 36.3, 'trucking'],
    ['rep', 36.8, 'nina'],
    ['prospect', 36.8, 'this is nina'],
    ['rep', 37.6, 'hi nina this is anel is hank available'],
    ['prospect', 41.8, 'he'],
    ['rep', 42.0, 'well'],
    [
      'prospect',
      42.3,
      'just barely left for a minute do want me to have him take a message and have him call back when he gets back in',
    ],
    ['rep', 48.5, 'no you can let him know on no call but i just i just called him at a different time'],
    ['prospect', 52.6, 'okay perfect sounds'],
    ['rep', 53.5, 'mhmm'],
    ['prospect', 53.7, 'good thank you'],
    ['rep', 54.2, 'no problem bye']
  ),
};

export const holdToVoicemail: CallFixture = {
  label: 'Victor Lane at Bluff Logistics',
  outcome: 'busy',
  durationSec: 253,
  notes: 'His secretary. Tried connecting me but I got sent to voicemail.',
  turns: t(
    [
      'prospect',
      0.1,
      'please listen carefully as our menu options have recently changed if you know the extension of the person you are trying to reach you may dial it at any time for questions regarding a move general questions press 1 for sales and moving quotes press 2 for operations and dispatching press 3 for bluff corporate offices including accounting hr safety it or marketing press 4 to reach the operator press 0',
    ],
    ['prospect', 42.2, 'thank you for calling bluff logistics this is faye'],
    ['rep', 45.2, 'hi faye this is anel is victor available'],
    ['prospect', 49.2, 'victor do have a last name'],
    ['rep', 52.7, 'victor lane'],
    ['prospect', 54.3, "oh okay can i ask why you're calling"],
    [
      'rep',
      57.1,
      "yes so i sent him an email a couple days ago on friday he checked it it's about a software solution yeah",
    ],
    ['prospect', 72.7, "i'm sorry can you repeat that"],
    ['rep', 75.8, 'yes so i messaged him a couple fridays ago about a software solution'],
    ['prospect', 81.2, 'mhmm'],
    ['rep', 82.2, 'yeah'],
    ['prospect', 84.9, 'about what solution'],
    ['rep', 86.7, 'software'],
    ['prospect', 88.0, 'software so are you trying like is it for our our moves or like'],
    [
      'rep',
      95.1,
      "i'm just trying to understand some of the needs of similar softwares i mean similar industries and i'm trying to understand where he's at so yeah that's a quick summary so i'm just wondering if he has some time",
    ],
    ['prospect', 116.3, "let me check i'm put you on a brief hold okay"],
    ['rep', 118.9, 'yeah thank you'],
    [
      'prospect',
      209.2,
      "your call has been forwarded to voicemail the person you're trying to reach is not available at the tone please record your message when you have finished recording you may hang up",
    ],
    [
      'rep',
      219.4,
      "hey victor this is anel canto i sent an email about how you can handle quoting and dispatch at bluff logistics not selling anything and just a orem founder trying to understand how operations like yours actually run day to day before i build anything if you got ten to fifteen minutes sometime i'd love to to talk or just send over a couple questions by email whatever is easier thanks",
    ]
  ),
};

export const wrongNameToVoicemail: CallFixture = {
  label: 'Owen Pike at Lakeside Freight',
  outcome: 'busy',
  durationSec: 68,
  notes: '',
  turns: t(
    ['prospect', 9.2, 'good afternoon lakeside freight this is ivy'],
    ['rep', 11.7, 'hi ivy this is anel is victor available'],
    ['prospect', 16.6, "we don't have a victor that works here"],
    ['rep', 19.4, "oh owen my bad i'm so"],
    ['prospect', 21.2, 'yeah'],
    ['rep', 21.2, 'sorry'],
    ['prospect', 21.6, 'just one moment please'],
    ['rep', 23.2, 'thank you'],
    [
      'prospect',
      57.0,
      'we are sorry there is no one available to take your call please record your message after the tone press',
    ]
  ),
};

export const phoneMenuCallBack: CallFixture = {
  label: 'Grant Ives at Sagebrush Logistics',
  outcome: 'connected',
  durationSec: 92,
  notes: 'I said to call him in 30 minutes.',
  turns: t(
    ['prospect', 0.3, 'press 1 for lena press 2 for tess press 3 for omar press 4 for grant press 5'],
    ['prospect', 22.4, 'hello'],
    ['rep', 23.7, 'hey grant this is anel how are you'],
    ['prospect', 27.1, "hey this is grant who's this"],
    [
      'rep',
      29.4,
      "oh hi grant this is anel i sent you an email the other day i'm a founder in utah and the reason i called you because one you're one of the few maritime companies in utah like",
    ],
    ['prospect', 43.3, 'uh-huh'],
    ['rep', 43.5, 'dust freight forwarding and'],
    ['prospect', 46.0, 'yeah'],
    ['rep', 46.4, 'do you have a couple of minutes is or is there'],
    ['prospect', 49.1, 'yeah yeah let me can i will you do me a favor can i can we talk in about maybe a half hour'],
    ['rep', 57.0, 'yeah yeah i can call you back'],
    ['prospect', 58.8, 'that'],
    ['rep', 59.0, 'in'],
    ['prospect', 59.1, 'work'],
    ['rep', 59.3, 'half'],
    ['prospect', 59.5, 'yeah'],
    ['rep', 59.6, 'an hour'],
    [
      'prospect',
      59.8,
      'yeah give me a ring give me a ring back and can i actually give you a different number let me just',
    ],
    ['rep', 64.3, 'yeah'],
    ['prospect', 64.4, 'give you our my cell phone that one will be easier okay'],
    ['rep', 68.2, 'sure'],
    ['prospect', 70.0, "it's 555 and then it's 0100"],
    ['rep', 76.4, 'k'],
    ['prospect', 77.0, '019'],
    ['rep', 79.7, "0199 got it i'll call"],
    ['prospect', 81.7, 'yep'],
    ['rep', 81.8, 'you in'],
    ['prospect', 82.2, 'yep'],
    ['rep', 82.4, 'half an hour'],
    ['prospect', 83.7, 'k sounds great'],
    ['rep', 85.3, 'bye'],
    ['prospect', 86.4, 'bye']
  ),
};

export const emailOnly: CallFixture = {
  label: 'Neil Varga at Basalt Logistics',
  outcome: 'busy',
  durationSec: 97,
  notes: 'She says contact him over email only.',
  turns: t(
    [
      'prospect',
      0.4,
      'for full truckload press 2 for bulk truckload press 3 for international ops press 4 for accounting press 5 for sales press 6 for basalt custom thank you for calling basalt logistics international operations team please hold for the next available agent',
    ],
    ['prospect', 31.4, 'basalt logistics this is joy'],
    ['rep', 34.2, 'hey joy this is anel is neil available'],
    ['prospect', 40.9, "this is the operations line we don't we're not able to transfer to him"],
    ['rep', 46.1, 'oh is there a number to call them directly'],
    ['prospect', 49.4, "i don't have that what is this regarding"],
    [
      'rep',
      54.8,
      "so i'm a founder i sent him a a message recently i'm pretty sure he read it so i'm just following up on some solution i'm local so what is what is the best way to contact him",
    ],
    ['prospect', 73.1, 'probably the email'],
    ['rep', 76.7, 'yeah but what would be the line to contact him'],
    ['prospect', 80.9, 'sorry you would have to follow-up with the email'],
    ['rep', 86.6, 'oh okay'],
    ['prospect', 91.8, 'k have a good day']
  ),
};

export const inAndOut: CallFixture = {
  label: 'Ross Keene at Keene Express',
  outcome: 'busy',
  durationSec: 34,
  notes: 'Not available',
  turns: t(
    ['prospect', 3.2, 'hello'],
    ['rep', 4.5, 'hi this is anel is ross available'],
    ['prospect', 7.9, "he's not is there something i can help you with"],
    ['rep', 11.8, "no i think i'll call him a different time is there a better time to when he might be available"],
    ['prospect', 17.5, "he's in and out all day it's kinda hard"],
    ['rep', 19.3, 'okay'],
    ['prospect', 19.5, "to pinpoint when he'll be here"],
    ['rep', 21.8, "yeah no that's fine"],
    ['prospect', 23.6, 'alright'],
    ['rep', 23.9, 'let him know i sent him an email and i might call him later'],
    ['prospect', 26.8, 'okay thank you'],
    ['rep', 28.1, 'mhmm bye'],
    ['prospect', 28.9, 'bye bye']
  ),
};

export const lunchThenBooked: CallFixture = {
  label: 'Grant Ives at Sagebrush Logistics',
  outcome: 'connected',
  durationSec: 81,
  notes: 'He was having lunch with his wife. He said they use some software.',
  turns: t(
    ['prospect', 1.2, 'hello'],
    ['rep', 2.5, 'hey grant this is anel how are you'],
    ['prospect', 7.0, "hey i'm good who is this again"],
    [
      'rep',
      9.0,
      "anel i called you last week i don't know if you remember i called you to your company number and you gave me your personal number because it wasn't a good time you were busy for some reason yeah but that was like last week do you remember",
    ],
    ['prospect', 23.8, "i i don't i get a lot of these calls but what was it about"],
    [
      'rep',
      27.5,
      "oh well yeah i'm just a founder in utah i build software for a startup and i'm not selling anything i'm just curious i would like to learn if you have a couple of minutes to let me know what are some of the biggest challenges that you experience mainly with software did you have some time",
    ],
    [
      'prospect',
      48.2,
      "no no i am home eating lunch with my wife so i'm probably not right now but yeah we we're a logistics based industry we use a little bit of software but not a lot but yeah maybe another time",
    ],
    ['rep', 61.7, 'yeah sure is there a good time where i could call you'],
    ['prospect', 66.5, 'you know maybe later this afternoon maybe about 04:00 so about three hours from now'],
    ['rep', 71.3, 'yeah i can i can call you for it'],
    ['prospect', 73.8, 'okay'],
    ['rep', 74.8, 'yeah take care'],
    ['prospect', 76.0, 'yep bye']
  ),
};

export const putThrough: CallFixture = {
  label: 'Lyle Moss at Cedar Point Transportation',
  outcome: 'connected',
  durationSec: 543,
  notes: "He said the issue is not software, it's that people don't have skills and don't stick around.",
  turns: t(
    ['prospect', 0.6, 'thank you for calling cedar point transportation our office hours are'],
    ['prospect', 14.2, 'cedar point this is rex'],
    ['rep', 15.4, 'hi rex can you transfer me again the call dropped for some reason'],
    ['prospect', 19.1, 'yeah yeah one second'],
    ['prospect', 38.5, "we'll try this again"],
    ['rep', 40.0, 'yes can you hear me now'],
    ['prospect', 41.8, 'done you sound great'],
    [
      'rep',
      43.5,
      "okay awesome hey thanks for talking with me i don't know if you remember we had an appointment last monday this is anel",
    ],
    ['prospect', 54.2, 'okay'],
    [
      'rep',
      55.5,
      "yeah so basically lyle i just called you because i know that you guys have a lot of experience and i'm a founder a software engineer i don't have any product anything to sell i'm just here local to orem but i would love to just speak with you for fifteen minutes to understand challenges that you have especially with billing and quoting because i would love to see if there's like a solution that i can help with the freight industry so do you have like fifty minutes right now just to pick your brain on this",
    ],
    ['prospect', 89.5, 'probably not but'],
    ['rep', 91.0, 'k'],
    ['prospect', 91.2, "but go ahead i'm not sure how much i'm willing to share with a stranger"],
    [
      'rep',
      95.8,
      "well that's cool i could also meet one day in person if you were open my main thing is that i see i we're talking with other people that do maritime i know it's a lot different than trucking",
    ],
    ['prospect', 149.4, 'i would say our problems do not involve software we'],
    ['prospect', 158.1, 'have some of the best software that that meets our needs'],
    ['prospect', 518.9, 'all'],
    ['rep', 519.1, 'a'],
    ['prospect', 519.1, 'the best'],
    [
      'rep',
      519.9,
      'yeah is there a way i could contact you in the future do you have like a direct phone number or this is the',
    ],
    ['prospect', 524.3, 'sure'],
    ['rep', 524.4, 'best way to reach you'],
    ['prospect', 525.4, '555'],
    ['rep', 526.9, 'k'],
    ['prospect', 527.3, '010-0123'],
    ['rep', 531.6, 'okay'],
    ['prospect', 531.6, 'you'],
    ['rep', 532.2, 'and this is anel and thanks for your time have a great day'],
    ['prospect', 536.1, 'too my man thanks'],
    ['rep', 536.9, 'you'],
    ['prospect', 537.1, 'bye'],
    ['rep', 537.2, 'too take care bye']
  ),
};
