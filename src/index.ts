/**
 * Proxies hnrss.org feeds and points every Hacker News comment link at
 * HackerWeb, which has a dark theme. Everything else in the feed is passed
 * through byte-for-byte.
 */

const UPSTREAM_ORIGIN = 'https://hnrss.org';
const CACHE_TTL_SECONDS = 300;
const USER_AGENT = 'hn-proxied-rss (+https://github.com/tarikd/hn-proxied-rss)';
const FEED_CONTENT_TYPE = 'application/rss+xml; charset=utf-8';

/**
 * Matches HN item permalinks wherever they appear: element text, href
 * attributes, and inside description CDATA.
 *
 * The `&amp;` alternative matters because a URL that already carries a query
 * string arrives XML-escaped inside the document. Trailing punctuation is left
 * alone by requiring the id to be digits.
 */
const HN_ITEM_URL = /https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/g;

/** Turns an HN item id into its HackerWeb equivalent. */
export function hackerWebUrl(id: string): string {
  return `https://hackerweb.app/#/item/${id}`;
}

/**
 * Rewrites every HN comment link in a feed document.
 *
 * Deliberately a plain string replace rather than an XML parse: the transform
 * is a pure URL swap that never changes the document structure, so preserving
 * the upstream bytes exactly is both safer and cheaper than a reserialize.
 *
 * `<guid isPermaLink="false">` stays consistent for free — hnrss already emits
 * `false`, and the value remains false once the URL points at HackerWeb, so
 * there is no attribute to fix up. A `isPermaLink="true"` guid would need to
 * flip to `false`, which `normalizeGuidPermaLinks` handles.
 */
export function rewriteFeed(xml: string): string {
  return normalizeGuidPermaLinks(xml.replace(HN_ITEM_URL, (_match, id: string) => hackerWebUrl(id)));
}

/**
 * A guid is only a permalink if the URL resolves to the item itself. Once a
 * rewritten HackerWeb URL is in there the claim no longer holds for feed
 * readers that try to fetch it, so any `isPermaLink="true"` guid carrying a
 * rewritten URL is downgraded to `false`.
 *
 * hnrss emits `false` today; this keeps the output correct if that changes.
 */
function normalizeGuidPermaLinks(xml: string): string {
  return xml.replace(
    /<guid\s+isPermaLink="true"(\s*)>(\s*https:\/\/hackerweb\.app\/)/g,
    '<guid isPermaLink="false"$1>$2',
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

    const upstreamUrl = upstreamUrlFor(request.url);
    if (!upstreamUrl) {
      return errorResponse(404, 'Not found: expected an hnrss feed path, e.g. /frontpage or /newest');
    }

    const cache = caches.default;
    // Key the cache on the upstream URL so /frontpage and /?  and differing
    // query strings each get their own entry, independent of the worker host.
    const cacheKey = new Request(upstreamUrl.toString(), { method: 'GET' });

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

    const rewritten = rewriteFeed(await upstreamResponse.text());
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
