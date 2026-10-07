import assert from 'node:assert/strict';
import { test } from 'node:test';
import { instrumentHtml, randomToken } from '../src/lib/tracking.ts';

const seq = () => {
  let i = 0;
  return () => `tok${++i}`;
};

test('rewrites http(s) links, leaves mailto and anchors alone, appends the pixel', () => {
  const html =
    '<p><a href="https://acme.com/a?x=1&amp;y=2">site</a> <a href=\'http://b.com\'>b</a> ' +
    '<a href="mailto:me@x.com">mail</a> <a href="#top">top</a></p>';
  const out = instrumentHtml(html, {
    baseUrl: 'https://app.example/',
    openToken: 'open1',
    newToken: seq(),
    opens: true,
  });

  assert.deepEqual(out.links, [
    { token: 'tok1', url: 'https://acme.com/a?x=1&y=2' },
    { token: 'tok2', url: 'http://b.com' },
  ]);
  assert.ok(out.html.includes('href="https://app.example/t/c/tok1">site</a>'));
  assert.ok(out.html.includes("href='https://app.example/t/c/tok2'>b</a>"));
  assert.ok(out.html.includes('href="mailto:me@x.com"'));
  assert.ok(out.html.includes('href="#top"'));
  assert.ok(
    out.html.endsWith(
      '<img src="https://app.example/t/o/open1" width="1" height="1" alt="" style="border:0;width:1px;height:1px">'
    )
  );
});

test('link text and everything else in the email is unchanged', () => {
  const html = '<p>No links here, just text &amp; a signature.</p>';
  const out = instrumentHtml(html, { baseUrl: 'https://app.example', openToken: 'o', newToken: seq(), opens: true });
  assert.equal(out.html.slice(0, html.length), html);
  assert.equal(out.links.length, 0);
});

test('random tokens are 128-bit hex and unique', () => {
  const a = randomToken();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, randomToken());
});

test('the pixel is off unless asked for', () => {
  const out = instrumentHtml('<p>hi</p>', { baseUrl: 'https://app.example', openToken: 'o', newToken: seq() });
  assert.equal(out.html, '<p>hi</p>');
});

test('tracking can be switched off: no pixel, links untouched', () => {
  const html = '<a href="https://acme.com">site</a>';
  const none = instrumentHtml(html, {
    baseUrl: 'https://app.example',
    openToken: 'o',
    newToken: seq(),
    opens: false,
    clicks: false,
  });
  assert.deepEqual(none, { html, links: [] });
  const clicksOnly = instrumentHtml(html, {
    baseUrl: 'https://app.example',
    openToken: 'o',
    newToken: seq(),
    opens: false,
  });
  assert.ok(!clicksOnly.html.includes('/t/o/') && clicksOnly.html.includes('/t/c/tok1'));
  const opensOnly = instrumentHtml(html, {
    baseUrl: 'https://app.example',
    openToken: 'o',
    newToken: seq(),
    opens: true,
    clicks: false,
  });
  assert.ok(opensOnly.html.startsWith(html) && opensOnly.html.includes('/t/o/o'));
});
