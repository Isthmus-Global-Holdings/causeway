// Open and click tracking for emails sent through Gmail. HubSpot's own
// tracking only covers emails HubSpot sends itself, and its open count is
// read-only through the API, so the app does its own:
// - an invisible 1x1 image served by /t/o/<token>
// - every http(s) link rewritten to /t/c/<token>, which redirects
//
// Opens are a weak signal: Gmail and Apple Mail fetch images through proxies,
// sometimes before anyone reads the email. Clicks are reliable.

export interface TrackedLink {
  token: string;
  url: string;
}

export interface Instrumented {
  html: string;
  links: TrackedLink[];
}

// Tokens are random and unguessable: they're the only thing protecting the
// public tracking routes from someone faking opens or clicks.
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Both kinds of tracking can be switched off on /settings: a pixel and
// redirected links are classic spam-filter signals for cold email.
export function instrumentHtml(
  html: string,
  opts: { baseUrl: string; openToken: string; newToken?: () => string; opens?: boolean; clicks?: boolean }
): Instrumented {
  const newToken = opts.newToken ?? randomToken;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const links: TrackedLink[] = [];
  const trackOpens = opts.opens ?? false;
  const trackClicks = opts.clicks ?? true;

  // Only href values on <a> tags, and only http(s). mailto:, tel: and
  // anchors are left alone.
  const rewritten = !trackClicks
    ? html
    : html.replace(
        /(<a\b[^>]*?\bhref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
        (_match, prefix: string, quote: string, rawUrl: string) => {
          const url = rawUrl.replace(/&amp;/g, '&');
          const token = newToken();
          links.push({ token, url });
          return `${prefix}${quote}${base}/t/c/${token}${quote}`;
        }
      );

  const pixel = trackOpens
    ? `<img src="${base}/t/o/${opts.openToken}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">`
    : '';
  return { html: rewritten + pixel, links };
}

// A transparent 1x1 GIF.
export const PIXEL_GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) =>
  c.charCodeAt(0)
);
