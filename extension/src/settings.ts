// What the rep sets on the options page, kept in chrome.storage.sync so it
// follows them to any Chrome they sign in to.

export interface Settings {
  // The pitch, with {{loom}} where the Loom link goes.
  template: string;
  // Causeway: the deployed Worker, or http://localhost:8787 under `npm run dev`
  // (the test CRM).
  workerUrl: string;
}

export const DEPLOYED_WORKER = 'https://hubspot-automations.frosty-darkness-3dd3.workers.dev';
export const LOCAL_WORKER = 'http://localhost:8787';

const DEFAULTS: Settings = { template: '', workerUrl: DEPLOYED_WORKER };

export async function loadSettings(): Promise<Settings> {
  const stored = (await chrome.storage.sync.get(DEFAULTS)) as Partial<Settings>;
  return {
    template: typeof stored.template === 'string' ? stored.template : DEFAULTS.template,
    workerUrl: stored.workerUrl === LOCAL_WORKER ? LOCAL_WORKER : DEPLOYED_WORKER,
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set(settings);
}
