/**
 * Proxies hnrss.org feeds and points every Hacker News comment link at a
 * self-hosted copy of HackerWeb (dark theme) under /hw/. Everything else in the
 * feed is passed through byte-for-byte.
 */

import { API_PREFIX, handleApi } from './hnapi';

const UPSTREAM_ORIGIN = 'https://hnrss.org';
const CACHE_TTL_SECONDS = 300;
const USER_AGENT = 'hn-proxied-rss (+https://github.com/tarikd/hn-proxied-rss)';
const FEED_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';
/** Where the vendored HackerWeb frontend is served from (public/hw/). */
const HACKERWEB_PATH = '/hw/';

/**
 * Matches HN item permalinks wherever they appear: element text, href
 * attributes, and inside description CDATA.
 *
 * The `&amp;` alternative matters because a URL that already carries a query
 * string arrives XML-escaped inside the document. Trailing punctuation is left
 * alone by requiring the id to be digits.
 */
const HN_ITEM_URL = /https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/;

/**
 * A whole `<guid>` element. Tried before HN_ITEM_URL at each position so a
 * guid is consumed, and kept, as one unit.
 */
const GUID_ELEMENT = /<guid\b[^>]*>[\s\S]*?<\/guid>/;

const FEED_REWRITE = new RegExp(`(${GUID_ELEMENT.source})|${HN_ITEM_URL.source}`, 'g');

/** Turns an HN item id into its URL on the HackerWeb copy served at `origin`. */
export function hackerWebUrl(origin: string, id: string): string {
  return `${origin}${HACKERWEB_PATH}#/item/${id}`;
}

/**
 * Rewrites every HN comment link in a feed document to the HackerWeb copy
 * served at `origin`.
 *
 * Deliberately a plain string replace rather than an XML parse: the transform
 * is a pure URL swap that never changes the document structure, so preserving
 * the upstream bytes exactly is both safer and cheaper than a reserialize.
 *
 * `<guid>` is left as hnrss sent it. It is an identifier, not a link: feed
 * readers use it to tell items apart, so it must not change when the
 * frontend's host does, or every item shows up again as new.
 */
export function rewriteFeed(xml: string, origin: string): string {
  return xml.replace(FEED_REWRITE, (match, guid: string | undefined, id: string) =>
    guid === undefined ? hackerWebUrl(origin, id) : match,
  );
}

/**
 * Maps an inbound request onto its hnrss URL, preserving the path and query
 * string. Returns null when the path is not a plausible feed path.
 */
export function upstreamUrlFor(requestUrl: string): URL | null {
  const url = new URL(requestUrl);
  const path = url.pathname === '/' ? '/frontpage' : url.pathname;

  // Single path segment only: hnrss has no nested feed routes, and this keeps
  // the worker from being used as an open proxy for arbitrary hnrss paths.
  if (!/^\/[A-Za-z0-9_-]+$/.test(path)) return null;

  const upstream = new URL(path, UPSTREAM_ORIGIN);
  upstream.search = url.search;
  return upstream;
}

/** Response headers for a successfully proxied feed. */
function feedHeaders(): Headers {
  return new Headers({
    'content-type': FEED_CONTENT_TYPE,
    'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Method not allowed');
    }

    const url = new URL(request.url);
    if (url.pathname.startsWith(API_PREFIX)) return withRequestMethod(await handleApi(request, ctx), request);

    const upstreamUrl = upstreamUrlFor(request.url);
    if (!upstreamUrl) {
      return errorResponse(404, 'Not found: expected an hnrss feed path, e.g. /frontpage or /newest');
    }

    const cache = caches.default;
    // Key the cache on the upstream path and query, so / and /frontpage share
    // an entry and each query string gets its own, under the worker's origin
    // because the rewritten links point there.
    const cacheKey = new Request(`${url.origin}${upstreamUrl.pathname}${upstreamUrl.search}`, { method: 'GET' });

    const cached = await cache.match(cacheKey);
    if (cached) return withRequestMethod(cached, request);

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(upstreamUrl.toString(), {
        headers: { accept: 'application/rss+xml, application/xml;q=0.9', 'user-agent': USER_AGENT },
      });
    } catch {
      return staleOr(await cache.match(cacheKey, { ignoreMethod: true }), request, 'Upstream fetch failed');
    }

    if (!upstreamResponse.ok) {
      return staleOr(
        await cache.match(cacheKey, { ignoreMethod: true }),
        request,
        `Upstream returned ${upstreamResponse.status}`,
      );
    }

    const rewritten = rewriteFeed(await upstreamResponse.text(), url.origin);
    const response = new Response(rewritten, { headers: feedHeaders() });

    // Populate the edge cache without delaying the response.
    ctx.waitUntil(cache.put(cacheKey, response.clone()));

    return withRequestMethod(response, request);
  },
} satisfies ExportedHandler;

/**
 * Serves a stale cached copy when upstream is unavailable, falling back to a
 * plain-text 502.
 */
function staleOr(stale: Response | undefined, request: Request, reason: string): Response {
  if (stale) return withRequestMethod(stale, request);
  return errorResponse(502, `Bad gateway: ${reason}`);
}

/** HEAD requests get the headers without a body. */
function withRequestMethod(response: Response, request: Request): Response {
  if (request.method === 'HEAD') {
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}
