# hn-proxied-rss

A Cloudflare Worker that proxies [hnrss.org](https://hnrss.org) feeds and points every
Hacker News comment link at [HackerWeb](https://hackerweb.app), which has a dark theme.
Everything else in the feed — titles, dates, authors, article URLs — is passed through
untouched.

Point your feed reader at the Worker instead of hnrss.org and the "Comments" links open
in a dark-mode-friendly frontend.

```
https://news.ycombinator.com/item?id=49241679  →  https://hackerweb.app/#/item/49241679
```

## Usage

The path and query string are forwarded to hnrss.org, so every hnrss feed and filter works:

| Worker URL                  | Upstream                              |
| --------------------------- | ------------------------------------- |
| `/`                         | `https://hnrss.org/frontpage`         |
| `/frontpage`                | `https://hnrss.org/frontpage`         |
| `/frontpage?points=100`     | `https://hnrss.org/frontpage?points=100` |
| `/newest`                   | `https://hnrss.org/newest`            |
| `/best`, `/newcomments`, …  | the matching hnrss endpoint           |

See the [hnrss docs](https://hnrss.org/) for the full list of endpoints and query
parameters.

## Behaviour

- **What gets rewritten** — any `https://news.ycombinator.com/item?id=<ID>` URL, wherever
  it appears: `<link>`, `<comments>`, `<guid>`, and inside `<description>` CDATA (both the
  `href` and the visible anchor text of the "Comments URL" link).
- **What doesn't** — article URLs pointing at external sites, the channel-level
  `https://news.ycombinator.com/` link, and every other element. Reversing the rewrite
  reproduces the upstream document byte for byte.
- **`isPermaLink`** — hnrss emits `<guid isPermaLink="false">`, which stays correct after
  rewriting. A guid marked `isPermaLink="true"` is downgraded to `false`, since the
  rewritten URL is no longer a permalink to the item itself.
- **Caching** — successful responses are cached at the edge for 5 minutes via the Cache
  API, keyed on the upstream URL, to stay polite to hnrss.org. Responses are served with
  `Content-Type: application/rss+xml; charset=utf-8` and `Cache-Control: public, max-age=300`.
- **Failures** — if upstream errors or is unreachable, a stale cached copy is served when
  one exists; otherwise the Worker returns a plain-text `502`. Non-feed paths return `404`
  and non-`GET`/`HEAD` methods return `405`.

The feed is XML, so the rewrite is a plain string replace rather than `HTMLRewriter`
(which is an HTML parser and would mangle CDATA). The transform only ever swaps URLs, so
preserving the upstream bytes exactly is both safer and cheaper than reserializing.

## Development

```bash
npm install
npm run dev        # local Worker at http://localhost:8787
npm test           # vitest, runs in the workerd runtime
npm run typecheck  # tsc --noEmit
```

`npm run typecheck && npm test` should pass before deploying.

## Deploy

One-time setup:

```bash
npm install
npx wrangler login
npm run deploy
```

The Worker has no bindings, secrets, or environment variables — `wrangler.toml` is the
whole configuration.

### Continuous deployment

[.github/workflows/deploy.yml](.github/workflows/deploy.yml) typechecks, tests, and deploys
on every push to `main` using
[`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action).

Add one repository secret under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with the **Edit Cloudflare Workers**
  template (create one at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)).

## Tests

- [test/rewrite.test.ts](test/rewrite.test.ts) — the rewrite and URL-mapping functions,
  against a fixture excerpted from a real hnrss response
  ([test/fixtures/hnrss-frontpage.xml](test/fixtures/hnrss-frontpage.xml)). Includes a
  round-trip check that nothing but the comment URLs changed.
- [test/worker.test.ts](test/worker.test.ts) — the handler: headers, query passthrough,
  edge caching, stale-on-failure, and the error responses.
