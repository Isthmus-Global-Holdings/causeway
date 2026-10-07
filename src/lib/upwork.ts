// Upwork pitches: the rep's proposal, pasted by the Chrome extension
// (extension/), with the Loom video recorded for the job, and logged as a
// HubSpot deal. Pure, and bundled into the extension as well, so both sides
// read a job and a Loom link the same way.

// Upwork names a job by its cipher, "~0" then digits or hex, in every URL
// that shows it: /jobs/~02…, /jobs/Some-title_~02…, /nx/proposals/job/~02…/apply/,
// and the job details panel on the find-work pages.
const JOB_ID = /~0[0-9a-f]{8,}/i;

// Loom's share link, as its Copy link button gives it (sometimes with ?sid=…).
const LOOM_SHARE = /^https:\/\/(www\.)?loom\.com\/share\/[0-9a-z]{16,}(\?\S*)?$/i;

// Page titles and headings that name the page, not the job.
const GENERIC_TITLES = /^(upwork|submit a proposal|send a proposal|apply|find work|job details|proposal)$/i;

const MAX_TITLE = 200;

export function upworkJobId(url: string): string | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (hostname !== 'upwork.com' && !hostname.endsWith('.upwork.com')) return null;
    return JOB_ID.exec(pathname)?.[0].toLowerCase() ?? null;
  } catch {
    return null;
  }
}

export function upworkJobUrl(jobId: string): string {
  return `https://www.upwork.com/jobs/${jobId}`;
}

export function isLoomShareUrl(text: string): boolean {
  return LOOM_SHARE.test(text.trim());
}

// The rep's template with the Loom link in place of every {{loom}}.
export function fillPitch(template: string, loomUrl: string): string {
  return template.replaceAll('{{loom}}', loomUrl.trim());
}

// The job's title, from the page: the tab's title without Upwork's suffix,
// else the first heading that names a job, else null.
export function jobTitleFrom(documentTitle: string, headings: string[]): string | null {
  const clean = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/\s*[-|–]\s*Upwork\s*$/i, '')
      .trim();
  const title = [documentTitle, ...headings].map(clean).find((t) => t && !GENERIC_TITLES.test(t));
  return title ? title.slice(0, MAX_TITLE) : null;
}

export interface Pitch {
  jobId: string;
  jobTitle: string | null;
  loomUrl: string;
}

// The extension's POST /pitches body, checked. A string is what's wrong with it.
export function parsePitch(body: unknown): Pitch | string {
  if (typeof body !== 'object' || body === null) return 'Send the pitch as a JSON object.';
  const { jobId, jobTitle, loomUrl } = body as Record<string, unknown>;
  if (typeof jobId !== 'string' || !new RegExp(`^${JOB_ID.source}$`, 'i').test(jobId)) {
    return 'That isn’t an Upwork job id (it starts with ~0).';
  }
  if (typeof loomUrl !== 'string' || !isLoomShareUrl(loomUrl)) return 'That isn’t a Loom share link.';
  if (jobTitle !== undefined && jobTitle !== null && typeof jobTitle !== 'string') return 'The job title must be text.';
  const title = typeof jobTitle === 'string' ? jobTitle.trim().slice(0, MAX_TITLE) : '';
  return { jobId: jobId.toLowerCase(), jobTitle: title || null, loomUrl: loomUrl.trim() };
}

// The deal's name and description in HubSpot.
export function pitchDealName(pitch: Pitch): string {
  return `Upwork: ${pitch.jobTitle ?? pitch.jobId}`;
}

export function pitchDescription(pitch: Pitch, pitchedOn: string): string {
  return [`Pitched on Upwork ${pitchedOn}.`, `Job: ${upworkJobUrl(pitch.jobId)}`, `Loom: ${pitch.loomUrl}`].join('\n');
}
