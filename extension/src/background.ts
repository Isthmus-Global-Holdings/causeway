// The shortcut: paste the pitch with the copied Loom link where the cursor
// is, then log the job's deal in HubSpot through Causeway (POST /pitches).
// Nothing is pasted without a Loom link on the clipboard, and nothing is
// logged unless the paste landed. Logging is safe to repeat: a job has one
// deal however often the shortcut is pressed. A pitch pasted but not logged
// is kept (pending.ts), so the next press logs it without pasting it again.

import { fillPitch, isLoomShareUrl, jobTitleFrom, upworkJobId, type Pitch } from '../../src/lib/upwork';
import { postPitch } from './causeway';
import { pasteAtCursor, readClipboardInPage, showToast, type PasteResult } from './page';
import { clearPending, pendingPitch, pendingPitches, setPending, type PendingResult } from './pending';
import { loadSettings } from './settings';

type Toast = { href: string; label: string } | null;

// First install: open the options page, where the pitch is written. Until
// it's saved, the icon wears a "!".
chrome.runtime.onInstalled.addListener(({ reason }) => {
  void showSetupBadge();
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) void chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => void showSetupBadge());
chrome.storage.onChanged.addListener(() => void showSetupBadge());

async function showSetupBadge(): Promise<void> {
  const { template } = await loadSettings();
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
  await chrome.action.setBadgeText({ text: template.trim() ? '' : '!' });
  await chrome.action.setTitle({ title: template.trim() ? 'Upwork pitch' : 'Upwork pitch: write your pitch first' });
}

// tab.url is there without the "tabs" permission: the host permission covers
// Upwork, and pressing the shortcut grants activeTab on any other site.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'paste-pitch' && tab?.id !== undefined) void onShortcut(tab.id, tab.url ?? '');
});

async function onShortcut(tabId: number, tabUrl: string): Promise<void> {
  try {
    await pastePitch(tabId, tabUrl);
  } catch (err) {
    const message = `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
    try {
      await toast(tabId, message, 'error');
    } catch {
      console.error(message); // not a page the extension can show it on
    }
  }
}

async function toast(tabId: number, message: string, kind: 'ok' | 'error', link: Toast = null): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, func: showToast, args: [message, kind, link] });
}

async function pastePitch(tabId: number, tabUrl: string): Promise<void> {
  if (!/^https:\/\/([a-z0-9-]+\.)*upwork\.com\//i.test(tabUrl)) {
    await toast(tabId, 'The pitch shortcut works on Upwork: open the job’s proposal page.', 'error');
    return;
  }
  const settings = await loadSettings();

  // This job's pitch is already in the box, but logging it failed: log it
  // now, without pasting it a second time.
  const tabJob = upworkJobId(tabUrl);
  const pending = tabJob ? await pendingPitch(tabJob) : null;
  if (pending) {
    await logAndTell(tabId, settings.workerUrl, pending, true);
    return;
  }

  if (!settings.template.trim()) {
    await toast(tabId, 'Write your pitch on the extension’s options page first.', 'error');
    await chrome.runtime.openOptionsPage();
    return;
  }

  const clipboard = (await readClipboard(tabId)).trim();
  if (!isLoomShareUrl(clipboard)) {
    await toast(tabId, 'Copy the job’s Loom link first: the clipboard doesn’t hold one. Nothing was pasted.', 'error');
    return;
  }

  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: pasteAtCursor,
    args: [fillPitch(settings.template, clipboard)],
  });
  const page = injection?.result as PasteResult | undefined;
  if (!page?.inserted) {
    await toast(tabId, 'Click into the proposal box first, then press the shortcut again.', 'error');
    return;
  }

  const jobId = upworkJobId(page.href);
  if (!jobId) {
    await toast(tabId, 'Pasted. Not logged in HubSpot: this page doesn’t show an Upwork job.', 'error');
    return;
  }
  const pitch = { jobId, jobTitle: jobTitleFrom(page.title, page.headings), loomUrl: clipboard };
  await setPending(pitch); // until it's logged
  await logAndTell(tabId, settings.workerUrl, pitch, false);
}

// The offscreen document reads it without a prompt. If that comes back
// empty, the page tries, which Chrome may ask the rep to allow once.
async function readClipboard(tabId: number): Promise<string> {
  let text = '';
  try {
    text = await readClipboardOffscreen();
  } catch {
    // Fall through to the page.
  }
  if (text) return text;
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: readClipboardInPage });
  return typeof injection?.result === 'string' ? injection.result : '';
}

async function readClipboardOffscreen(): Promise<string> {
  if (!(await chrome.offscreen.hasDocument())) {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Read the Loom link the rep copied, to paste it into their pitch.',
      });
    } catch (err) {
      // Two presses at once: the other one opened it (Chrome allows one).
      if (!String(err).includes('single offscreen')) throw err;
    }
  }
  const text: unknown = await chrome.runtime.sendMessage({ type: 'read-clipboard' });
  return typeof text === 'string' ? text : '';
}

// Logs the pitch and says how it went. `retry`: pasted on an earlier press.
async function logAndTell(tabId: number, workerUrl: string, pitch: Pitch, retry: boolean): Promise<void> {
  const outcome = await postPitch(workerUrl, pitch);
  if (outcome.kind === 'logged') {
    await clearPending(pitch.jobId);
    const message = retry
      ? 'Logged in HubSpot. Not pasted again: your pitch is already in the box.'
      : outcome.created
        ? 'Pasted and logged in HubSpot.'
        : 'Pasted. This job was already logged.';
    await toast(tabId, message, 'ok', { href: outcome.dealUrl, label: 'Open the deal' });
    return;
  }
  const lead = retry ? 'Still not logged in HubSpot' : 'Pasted, but not logged in HubSpot';
  const again = 'Press the shortcut again on this job to log it. It won’t paste twice.';
  if (outcome.kind === 'signed-out') {
    await toast(tabId, `${lead}: your Causeway sign-in expired. Sign in, then: ${again}`, 'error', {
      href: workerUrl,
      label: 'Sign in to Causeway',
    });
  } else if (outcome.kind === 'offline') {
    await toast(tabId, `${lead}: couldn’t reach Causeway. ${again}`, 'error');
  } else {
    await toast(tabId, `${lead}: ${outcome.why} ${again}`, 'error');
  }
}

// The panel's "Log them now": every pitch pasted but not logged.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (r: PendingResult) => void) => {
  if ((message as { type?: string } | null)?.type !== 'log-pending') return false;
  void (async () => sendResponse(await logAllPending()))();
  return true; // answers after the requests
});

async function logAllPending(): Promise<PendingResult> {
  const { workerUrl } = await loadSettings();
  let logged = 0;
  let why: string | null = null;
  for (const pitch of await pendingPitches()) {
    const outcome = await postPitch(workerUrl, pitch);
    if (outcome.kind === 'logged') {
      await clearPending(pitch.jobId);
      logged += 1;
    } else {
      why ??=
        outcome.kind === 'signed-out'
          ? 'Your Causeway sign-in expired.'
          : outcome.kind === 'offline'
            ? 'Couldn’t reach Causeway.'
            : outcome.why;
    }
  }
  return { logged, left: (await pendingPitches()).length, why };
}
