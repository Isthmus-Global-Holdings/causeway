// The offscreen document: a hidden page the service worker opens to read the
// clipboard, which a service worker can't do itself. Pasting into a textarea
// here works without a prompt, given the clipboardRead permission.

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (text: string) => void) => {
  if ((message as { type?: string } | null)?.type !== 'read-clipboard') return false;
  const area = document.querySelector('textarea');
  if (!area) {
    sendResponse('');
    return false;
  }
  area.value = '';
  area.focus();
  document.execCommand('paste');
  sendResponse(area.value);
  return false;
});
