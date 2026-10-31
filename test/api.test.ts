import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import algoliaJson from './fixtures/algolia-item-50317363.json?raw';
import firebaseJson from './fixtures/firebase-item-50317363.json?raw';

const ALGOLIA = 'https://hn.algolia.com/api/v1/items/';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0/';

/** Routes stubbed upstream fetches by URL; anything unrouted is a 500. */
function stubUpstream(routes: Record<string, () => Response | Promise<Response>>) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      const route = routes[url];
      return route ? route() : new Response('unrouted', { status: 500 });
    }),
  );
  return seen;
}

const json = (body: unknown) => () => new Response(JSON.stringify(body));

// Every test uses its own item id or page so no edge-cache entry leaks
// between tests.
async function call(path: string): Promise<Response> {
  const c = createExecutionContext();
  const response = await worker.fetch(new Request(`https://worker.dev${path}`), {}, c);
  await waitOnExecutionContext(c);
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/hw/api/item/<id>', () => {
  it('serves the full Algolia thread in node-hnapi shape, ranked by Firebase', async () => {
    stubUpstream({
      [`${ALGOLIA}50317363`]: () => new Response(algoliaJson),
      [`${FIREBASE}item/50317363.json`]: () => new Response(firebaseJson),
    });

    const response = await call('/hw/api/item/50317363');
    const body = await response.json<{ id: number; comments_count: number; comments: { id: number }[] }>();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(body.id).toBe(50317363);
    expect(body.comments_count).toBe(30);
    expect(body.comments[0].id).toBe(50317918);
  });

  it('still serves the thread when the Firebase ranking fails', async () => {
    const algolia = JSON.parse(algoliaJson);
    stubUpstream({ [`${ALGOLIA}101`]: json({ ...algolia, id: 101 }) });

    const response = await call('/hw/api/item/101');
    const body = await response.json<{ comments_count: number; comments: { id: number }[] }>();

    expect(response.status).toBe(200);
    expect(body.comments_count).toBe(30);
    expect(body.comments[0].id).toBe(algolia.children[0].id);
  });

  it('loads poll options from Firebase', async () => {
    stubUpstream({
      [`${ALGOLIA}102`]: json({
        id: 102,
        created_at_i: 0,
        type: 'poll',
        author: 'pg',
        title: 'Poll',
        url: null,
        text: null,
        points: 1,
        options: [103],
        children: [],
      }),
      [`${FIREBASE}item/103.json`]: json({ id: 103, type: 'pollopt', text: 'Yes', score: 9 }),
    });

    const body = await (await call('/hw/api/item/102')).json<{ poll: unknown }>();

    expect(body.poll).toEqual([{ item: 'Yes', points: 9 }]);
  });

  it('returns a 502 error, not an empty thread, when Algolia fails', async () => {
    stubUpstream({ [`${FIREBASE}item/104.json`]: () => new Response(firebaseJson) });

    const response = await call('/hw/api/item/104');

    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Upstream failed') });
  });

  it('does not cache a failure', async () => {
    stubUpstream({});
    expect((await call('/hw/api/item/105')).status).toBe(502);

    stubUpstream({ [`${ALGOLIA}105`]: json({ ...JSON.parse(algoliaJson), id: 105 }) });
    const retry = await call('/hw/api/item/105');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ id: 105, comments_count: 30 });
  });

  it('returns a 404 error for an unknown item', async () => {
    stubUpstream({ [`${ALGOLIA}106`]: () => new Response('{"error":"Not Found"}', { status: 404 }) });

    const response = await call('/hw/api/item/106');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Item not found' });
  });

  it('serves a cached thread without hitting upstream again', async () => {
    stubUpstream({ [`${ALGOLIA}107`]: json({ ...JSON.parse(algoliaJson), id: 107 }) });
    expect((await call('/hw/api/item/107')).status).toBe(200);

    const seen = stubUpstream({});
    const response = await call('/hw/api/item/107');

    expect(response.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it('serves a stale cached thread when upstream fails', async () => {
    // As in the feed test: the fresh lookup must miss for the fallback to be
    // reachable, which is what an expired-but-retained entry looks like.
    const cache = caches.default;
    const stale = new Response(JSON.stringify({ id: 108, comments: [] }));
    let firstLookup = true;
    vi.spyOn(cache, 'match').mockImplementation(async () => {
      if (firstLookup) {
        firstLookup = false;
        return undefined;
      }
      return stale.clone();
    });
    stubUpstream({});

    const response = await call('/hw/api/item/108');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 108, comments: [] });
  });
});

describe('/hw/api/news and /hw/api/news2', () => {
  const ids = Array.from({ length: 70 }, (_, i) => 1000 + i);
  const storyRoutes = Object.fromEntries(
    ids.map((id) => [`${FIREBASE}item/${id}.json`, json({ id, type: 'story', title: `Story ${id}`, time: 0 })]),
  );

  // Runs first on purpose: a failure is not cached, so the next test still
  // reaches upstream for the same /hw/api/news key.
  it('fails the whole page rather than serving a short list', async () => {
    const { [`${FIREBASE}item/1005.json`]: _missing, ...allButOne } = storyRoutes;
    stubUpstream({ [`${FIREBASE}topstories.json`]: json(ids), ...allButOne });

    const response = await call('/hw/api/news');

    expect(response.status).toBe(502);
  });

  it('serves the first 30 top stories, in rank order', async () => {
    stubUpstream({ [`${FIREBASE}topstories.json`]: json(ids), ...storyRoutes });

    const response = await call('/hw/api/news');
    const body = await response.json<{ id: number; title: string }[]>();

    expect(response.status).toBe(200);
    expect(body.map((s) => s.id)).toEqual(ids.slice(0, 30));
    expect(body[0].title).toBe('Story 1000');
  });

  it('serves the second page as news2', async () => {
    stubUpstream({ [`${FIREBASE}topstories.json`]: json(ids), ...storyRoutes });

    const body = await (await call('/hw/api/news2')).json<{ id: number }[]>();

    expect(body.map((s) => s.id)).toEqual(ids.slice(30, 60));
  });
});

describe('/hw/api routing', () => {
  it('returns a JSON 404 for endpoints HackerWeb never calls', async () => {
    const seen = stubUpstream({});

    const response = await call('/hw/api/user/pg');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(seen).toEqual([]);
  });
});
