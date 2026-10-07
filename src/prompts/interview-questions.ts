// The rep's interview guide, shown on every interview's prep page. Mom Test
// rules (Rob Fitzpatrick): ask about their life and what they did last
// time, never about the idea or what they'd do in the future, and don't
// pitch. It's the rep's to edit: change it here as the questions change.

export interface InterviewSection {
  heading: string;
  questions: string[];
}

export const INTERVIEW_REMINDERS = [
  'Talk about their work, not the idea. Nothing to sell.',
  'Ask about the last time it happened, not what they usually do or would do.',
  'Compliments and "that sounds great" are noise. Dig for what they did and what it cost.',
  'Listen more than you talk. Silence is fine.',
];

export const INTERVIEW_SECTIONS: InterviewSection[] = [
  {
    heading: 'Their week',
    questions: [
      'Walk me through the last load you quoted, from the first call to the invoice.',
      'Who touches quoting, dispatch and invoicing? What does each of them use?',
      'What did last week look like? What ate the most time?',
    ],
  },
  {
    heading: 'Where it hurts',
    questions: [
      'Tell me about the last time a quote, a dispatch or an invoice went wrong. What happened next?',
      'What’s the most tedious part? Why is it still done that way?',
      'What have you tried to fix it? What happened with that?',
    ],
  },
  {
    heading: 'What it costs',
    questions: [
      'How much time does that take each week, and whose time?',
      'Have you paid for anything to help with it (software, a person, a service)?',
      'If it went away tomorrow, what would change?',
    ],
  },
  {
    heading: 'Wrap up',
    questions: [
      'Is there anything I should have asked but didn’t?',
      'Who else should I talk to about this?',
      'Can I follow up with you as I learn more?',
    ],
  },
];
