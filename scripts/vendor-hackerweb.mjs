#!/usr/bin/env node
/**
 * Vendors the HackerWeb frontend (https://github.com/cheeaun/hackerweb, MIT)
 * into public/hw/ and points it at this Worker's own API.
 *
 * Why: the public HackerWeb API (api.hackerwebapp.com, cheeaun/node-hnapi)
 * gives each comment one second to load from Firebase and silently drops it,
 * replies included, when it is late. Partial threads then get cached for 15
 * minutes. The Worker serves a replacement under /hw/api/ that builds threads
 * from Algolia in a single request.
 *
 * Usage: node scripts/vendor-hackerweb.mjs
 *
 * Pinned to a commit so the patches below always apply to known bytes. Every
 * patch must match exactly once, or the script fails instead of shipping an
 * unpatched copy.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/cheeaun/hackerweb.git';
const COMMIT = '84044b4b4301d4a0261c726fbf351bf27323b5e9';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, 'public', 'hw');

/** Replaces `from` with `to`, insisting on exactly one match. */
function patch(text, from, to, what) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw new Error(`${what}: expected 1 match, found ${count}`);
  return text.replace(from, () => to);
}

/** The text from `start` through the first `end` after it, inclusive. */
function spanOf(text, start, end) {
  const from = text.indexOf(start);
  const to = from === -1 ? -1 : text.indexOf(end, from);
  if (to === -1) throw new Error(`span not found: ${start}`);
  return text.slice(from, to + end.length);
}

const src = mkdtempSync(join(tmpdir(), 'hackerweb-'));
try {
  execFileSync('git', ['init', '-q', src]);
  execFileSync('git', ['-C', src, 'fetch', '-q', '--depth', '1', REPO, COMMIT]);
  execFileSync('git', ['-C', src, 'checkout', '-q', 'FETCH_HEAD']);

  rmSync(dest, { recursive: true, force: true });
  for (const path of ['assets/images', 'icons', 'manifest.json', 'js/hnapi-worker.js']) {
    cpSync(join(src, path), join(dest, path), { recursive: true });
  }
  for (const theme of ['web', 'ios', 'ios-2']) {
    cpSync(join(src, `assets/css/hw-${theme}.min.css`), join(dest, `assets/css/hw-${theme}.min.css`));

    const bundle = `js/hw-${theme}.min.js`;
    let js = readFileSync(join(src, bundle), 'utf8');
    // Our API first; the original as the fallback the client already retries
    // on error. The other hosts in the list have been dead for years.
    js = patch(
      js,
      '["https://node-hnapi-eu.herokuapp.com/","https://node-hnapi.azurewebsites.net/","https://node-hnapi-eus.azurewebsites.net/"]',
      '["https://api.hackerwebapp.com/"]',
      `${bundle} fallback hosts`,
    );
    js = patch(
      js,
      '.unshift("https://api.hackerwebapp.com/")',
      '.unshift(new URL("api/",location.href).href)',
      `${bundle} primary host`,
    );
    // The source maps describe the unpatched bundle, so they are not shipped.
    js = patch(js, `\n//# sourceMappingURL=hw-${theme}.min.js.map`, '', `${bundle} source map`);
    writeFileSync(join(dest, bundle), js);
  }

  let html = readFileSync(join(src, 'index.html'), 'utf8');
  // The analytics beacon reports to the upstream author's Cloudflare account.
  html = patch(
    html,
    spanOf(html, '<!-- Cloudflare Web Analytics -->', '<!-- End Cloudflare Web Analytics -->\n'),
    '',
    'index.html analytics beacon',
  );
  // The service worker caches every same-origin response. With the API now
  // same-origin it would race stale comment threads against fresh ones.
  html = patch(
    html,
    spanOf(html, "if ('serviceWorker' in navigator){", '});\n}\n\n'),
    '',
    'index.html service worker',
  );
  writeFileSync(join(dest, 'index.html'), html);

  writeFileSync(
    join(dest, 'LICENSE'),
    `HackerWeb, vendored from ${REPO.replace(/\.git$/, '')} at ${COMMIT}
with the patches applied by scripts/vendor-hackerweb.mjs.

The MIT License (MIT)

Copyright (c) Lim Chee Aun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`,
  );

  console.log(`Vendored HackerWeb ${COMMIT.slice(0, 7)} into ${dest}`);
} finally {
  rmSync(src, { recursive: true, force: true });
}
