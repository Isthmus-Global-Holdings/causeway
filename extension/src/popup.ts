// The toolbar panel: what's set up, what isn't, and how to pitch. Clicking
// the icon grants activeTab, so the current tab's URL is readable here.

import { upworkJobId } from '../../src/lib/upwork';
import { causewayStatus } from './causeway';
import { pendingPitches, type PendingResult } from './pending';
import { LOCAL_WORKER, loadSettings } from './settings';

type State = 'ok' | 'todo' | 'idle';
type Action = { label: string; run: () => Promise<unknown> } | null;

function show(id: string, state: State, detail: string, action: Action = null): void {
  const row = document.getElementById(id)!;
  row.dataset.state = state;
  const text = row.querySelector<HTMLElement>('.detail')!;
  text.textContent = detail;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link';
    button.textContent = action.label;
    button.addEventListener('click', () => void runAndClose(action.run));
    text.append(' ', button);
  }
}

const openOptions = () => chrome.runtime.openOptionsPage();

// The panel stays open over a tab it opened unless it's closed.
async function runAndClose(run: () => Promise<unknown>): Promise<void> {
  await run();
  window.close();
}

async function render(): Promise<void> {
  const [settings, [command], [tab]] = await Promise.all([
    loadSettings(),
    chrome.commands.getAll(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  document.getElementById('shortcut')!.textContent = command?.shortcut || 'not set';

  if (settings.template.trim()) show('pitch', 'ok', 'Saved.', { label: 'Edit', run: openOptions });
  else show('pitch', 'todo', 'Not written yet.', { label: 'Write it', run: openOptions });

  const url = tab?.url ?? '';
  if (upworkJobId(url)) show('page', 'ok', 'An Upwork job: ready to pitch.');
  else if (/^https:\/\/([a-z0-9-]+\.)*upwork\.com\//i.test(url)) {
    show('page', 'idle', 'Upwork, but not a job. Open the job’s proposal page to pitch it.');
  } else show('page', 'idle', 'Not Upwork. The shortcut only works there.');

  await showPending();

  const local = settings.workerUrl === LOCAL_WORKER;
  const where = local ? 'Local npm run dev (test CRM)' : 'Causeway (live CRM)';
  const status = await causewayStatus(settings.workerUrl);
  if (status === 'signed-in') show('causeway', 'ok', `${where}: signed in.`, { label: 'Change', run: openOptions });
  else if (status === 'signed-out') {
    show('causeway', 'todo', `${where}: signed out, so pitches won’t be logged.`, {
      label: 'Sign in',
      run: () => chrome.tabs.create({ url: settings.workerUrl }),
    });
  } else if (local) {
    show('causeway', 'todo', `${where}: not running. Start it with npm run dev.`, {
      label: 'Change',
      run: openOptions,
    });
  } else show('causeway', 'todo', `${where}: can’t reach it. Check you’re online.`);
}

// Pitches pasted but not logged: log them from here, without pasting again.
async function showPending(note: string | null = null): Promise<void> {
  const pending = await pendingPitches();
  const row = document.getElementById('pending')!;
  row.hidden = pending.length === 0 && !note;
  if (row.hidden) return;
  row.dataset.state = pending.length ? 'todo' : 'ok';
  const text = row.querySelector<HTMLElement>('.detail')!;
  const jobs = pending.length === 1 ? 'One job' : `${pending.length} jobs`;
  text.textContent = note ?? `${jobs} pasted while Causeway couldn’t log it.`;
  if (!pending.length) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = 'Log now';
  button.addEventListener('click', () => void logPending(button));
  text.append(' ', button);
}

async function logPending(button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = 'Logging…';
  const result = (await chrome.runtime.sendMessage({ type: 'log-pending' })) as PendingResult;
  const done = result.logged ? `Logged ${result.logged}.` : '';
  await showPending(
    result.left ? `${done} ${result.left} still not logged: ${result.why ?? ''}`.trim() : `${done} All logged.`.trim()
  );
}

document.getElementById('open-options')!.addEventListener('click', () => void runAndClose(openOptions));
document
  .getElementById('change-shortcut')!
  .addEventListener(
    'click',
    () => void runAndClose(() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))
  );
void render();
