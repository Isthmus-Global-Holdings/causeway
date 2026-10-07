// The options page: the pitch template, which Causeway to log to, and the
// shortcut (changed on Chrome's own page).

import { DEPLOYED_WORKER, LOCAL_WORKER, loadSettings, saveSettings } from './settings';

const form = document.querySelector<HTMLFormElement>('#settings')!;
const template = document.querySelector<HTMLTextAreaElement>('#template')!;
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const shortcut = document.querySelector<HTMLElement>('#shortcut')!;
const changeShortcut = document.querySelector<HTMLButtonElement>('#change-shortcut')!;

function worker(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[name="worker"]:checked')!;
}

async function show(): Promise<void> {
  const settings = await loadSettings();
  template.value = settings.template;
  const value = settings.workerUrl === LOCAL_WORKER ? LOCAL_WORKER : DEPLOYED_WORKER;
  document.querySelector<HTMLInputElement>(`input[name="worker"][value="${value}"]`)!.checked = true;
  const [command] = await chrome.commands.getAll();
  shortcut.textContent = command?.shortcut || 'not set';
}

async function save(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const text = template.value;
  if (!text.includes('{{loom}}')) {
    status.textContent = 'Put {{loom}} where the Loom link goes.';
    return;
  }
  await saveSettings({ template: text, workerUrl: worker().value });
  status.textContent = 'Saved.';
}

form.addEventListener('submit', (event) => void save(event));
changeShortcut.addEventListener('click', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
void show();
