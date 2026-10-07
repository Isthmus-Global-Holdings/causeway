// Functions run in the Upwork tab with chrome.scripting.executeScript. Chrome
// sends each one's source to the page on its own, so they can't use imports,
// module variables or each other: everything they need is inside them.

export interface PasteResult {
  inserted: boolean;
  href: string;
  title: string;
  headings: string[];
}

// Types the pitch where the cursor is, as if the rep had: execCommand's
// insertText fires the input events Upwork's React forms listen for, works
// in textareas and rich editors alike, and leaves Ctrl+Z able to undo it.
export function pasteAtCursor(text: string): PasteResult {
  const page = {
    href: location.href,
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2, h3, h4')]
      .slice(0, 8)
      .map((h) => (h.textContent ?? '').trim())
      .filter(Boolean),
  };
  const el = document.activeElement;
  const field = el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type === 'text') ? el : null;
  if (!field && !(el instanceof HTMLElement && el.isContentEditable)) return { inserted: false, ...page };
  if (document.execCommand('insertText', false, text)) return { inserted: true, ...page };
  if (!field) return { inserted: false, ...page };
  // Where execCommand is refused: replace the selection, and tell React.
  field.setRangeText(text, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end');
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  return { inserted: true, ...page };
}

// Reads the clipboard from the page, which has focus: the fallback when the
// offscreen document can't. Chrome may ask the rep to allow it once.
export async function readClipboardInPage(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

// A note in the page's corner that goes away on its own, with an optional link.
export function showToast(message: string, kind: 'ok' | 'error', link: { href: string; label: string } | null): void {
  const id = 'causeway-pitch-toast';
  document.getElementById(id)?.remove();
  const box = document.createElement('div');
  box.id = id;
  box.setAttribute('role', 'status');
  Object.assign(box.style, {
    position: 'fixed',
    top: '16px',
    right: '16px',
    zIndex: '2147483647',
    maxWidth: '360px',
    padding: '12px 16px',
    borderRadius: '8px',
    font: '14px/1.4 system-ui, sans-serif',
    color: '#fff',
    background: kind === 'ok' ? '#14532d' : '#7f1d1d',
    boxShadow: '0 4px 16px rgba(0,0,0,.25)',
  });
  box.textContent = message;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label;
    Object.assign(a.style, { color: '#fff', marginLeft: '8px', textDecoration: 'underline' });
    box.append(a);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), kind === 'ok' ? 5000 : 10000);
}
