import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { rewriteFeed } from '../src/index';
import fixture from './fixtures/hnrss-frontpage.xml?raw';

const ctx = () => createExecutionContext();

/** Stubs global fetch for one test. */
function stubUpstream(impl: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => impl(String(input))));
}

async function call(path: string): Promise<Response> {
  const c = ctx();
  const response = await worker.fetch(new Request(`https://worker.dev${path}`), {}, c);
  await waitOnExecutionContext(c);
  return response;
}

afterEach(() => vi.unstubAllGlobals());

describe('worker fetch', () => {
  it('serves a rewritten feed with the documented headers', async () => {
    stubUpstream(() => new Response(fixture, { headers: { 'content-type': 'application/xml' } }));

    const response = await call('/frontpage?points=100');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/rss+xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(body).toContain('<comments>https://worker.dev/hw/#/item/49241679</comments>');
  });

  it('forwards the path and query string to hnrss', async () => {
    const seen: string[] = [];
    stubUpstream((url) => {
      seen.push(url);
      return new Response(fixture);
    });

    await call('/newest?points=100&count=10');

    expect(seen[0]).toBe('https://hnrss.org/newest?points=100&count=10');
  });

  it('serves a fresh cached copy without hitting upstream again', async () => {
    stubUpstream(() => new Response(fixture));
    expect((await call('/frontpage')).status).toBe(200);

    const second = vi.fn(async () => new Response('should not be called'));
    vi.stubGlobal('fetch', second);
    const response = await call('/frontpage');

    expect(response.status).toBe(200);
    expect(second).not.toHaveBeenCalled();
  });

  it('falls back to the stale cached copy when upstream fails', async () => {
    // The fresh-cache lookup has to miss for the stale path to be reachable,
    // which is what an expired-but-retained edge entry looks like in
    // production. Force that shape: first match() (fresh) misses, the
    // fallback match() finds the retained copy.
    const cache = caches.default;
    const stale = new Response(rewriteFeed(fixture, 'https://worker.dev'), {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
    });
    let firstLookup = true;
    vi.spyOn(cache, 'match').mockImplementation(async () => {
      if (firstLookup) {
        firstLookup = false;
        return undefined;
      }
      return stale.clone();
    });

    stubUpstream(() => {
      throw new Error('network down');
    });
    const response = await call('/frontpage');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://worker.dev/hw/#/item/49241679');

    vi.mocked(cache.match).mockRestore();
  });

  it('returns a plain-text 502 when upstream fails with nothing cached', async () => {
    stubUpstream(() => new Response('nope', { status: 503 }));

    const response = await call('/uncached-feed-name');

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await response.text()).toContain('Bad gateway');
  });

  it('rejects non-feed paths and non-GET methods', async () => {
    stubUpstream(() => new Response(fixture));

    expect((await call('/a/b')).status).toBe(404);

    const c = ctx();
    const post = await worker.fetch(
      new Request('https://worker.dev/frontpage', { method: 'POST' }),
      {},
      c,
    );
    await waitOnExecutionContext(c);
    expect(post.status).toBe(405);
  });
});
