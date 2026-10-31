/**
 * The slice of the node-hnapi JSON API that the vendored HackerWeb frontend
 * calls: `news`, `news2` and `item/<id>`, served under /hw/api/.
 *
 * The public node-hnapi fetches every comment from Firebase separately with a
 * one-second deadline each, and silently drops late comments along with their
 * replies. Here a thread comes from Algolia's items endpoint instead, which
 * returns the whole tree in one request, so it is either complete or an error.
 * Errors are never cached, and the frontend retries them against
 * api.hackerwebapp.com.
 */

const ALGOLIA_ITEM_URL = 'https://hn.algolia.com/api/v1/items/';
const FIREBASE_URL = 'https://hacker-news.firebaseio.com/v0/';
const USER_AGENT = 'hn-proxied-rss (+https://github.com/tarikd/hn-proxied-rss)';
const CACHE_TTL_SECONDS = 300;
const STORIES_PER_PAGE = 30;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** Comment ordering is a nicety; don't hold a complete thread back for it. */
const ORDERING_TIMEOUT_MS = 2_000;

export const API_PREFIX = '/hw/api/';

/** An item from `hn.algolia.com/api/v1/items/<id>`, children nested. */
export interface AlgoliaItem {
  id: number;
  created_at_i: number;
  type: string;
  author: string | null;
  title: string | null;
  url: string | null;
  text: string | null;
  points: number | null;
  options?: number[];
  children: AlgoliaItem[];
}

/** An item from the official HN Firebase API. */
export interface FirebaseItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  deleted?: boolean;
  dead?: boolean;
}

export interface HnapiComment {
  id: number;
  level: number;
  user: string | null;
  time: number;
  time_ago: string;
  content: string | undefined;
  deleted?: true;
  comments: HnapiComment[];
}

export interface HnapiPollOption {
  item: string | undefined;
  points: number | undefined;
}

export interface HnapiItem {
  id: number;
  title: string;
  points: number | null;
  user: string | null;
  time: number;
  time_ago: string;
  type: string;
  content: string | undefined;
  url: string;
  domain?: string;
  poll?: HnapiPollOption[];
  comments: HnapiComment[];
  comments_count: number;
}

export interface HnapiStory {
  id: number;
  title: string;
  points: number | null;
  user: string | null;
  time: number;
  time_ago: string;
  comments_count: number;
  type: string;
  url: string;
  domain?: string;
}

const TYPE_MAPPING: Record<string, string> = { story: 'link' };

/**
 * Relative time in the words moment.js's `fromNow()` uses, which is what
 * node-hnapi sends and HackerWeb displays verbatim.
 */
export function timeAgo(unixSeconds: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round(nowMs / 1000 - unixSeconds));
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const months = Math.round(days / 30.436875);
  const years = Math.round(days / 365.25);

  if (seconds < 45) return 'a few seconds ago';
  if (minutes < 45) return minutes <= 1 ? 'a minute ago' : `${minutes} minutes ago`;
  if (hours < 22) return hours <= 1 ? 'an hour ago' : `${hours} hours ago`;
  if (days < 26) return days <= 1 ? 'a day ago' : `${days} days ago`;
  if (months < 11) return months <= 1 ? 'a month ago' : `${months} months ago`;
  return years <= 1 ? 'a year ago' : `${years} years ago`;
}

/** node-hnapi's HTML clean-up: no closing `</p>`s, always a leading `<p>`. */
function cleanText(html: string | null | undefined): string | undefined {
  if (!html) return undefined;
  const stripped = html.replace(/<\/p>/gi, '');
  return /^<p>/i.test(stripped) ? stripped : `<p>${stripped}`;
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return undefined;
  }
}

/** Stories without a URL point at the HN thread, as "local" links. */
function linkFields(id: number, url: string | null | undefined): { url: string; domain?: string } {
  return url ? { url, domain: domainOf(url) } : { url: `item?id=${id}` };
}

function toComment(item: AlgoliaItem, level: number, nowMs: number): HnapiComment {
  // Algolia normally leaves deleted and dead comments out altogether. Should
  // one come through bare, render it the way node-hnapi renders a deleted one.
  const deleted = item.author === null && item.text === null;
  return {
    id: item.id,
    level,
    user: item.author,
    time: item.created_at_i,
    time_ago: timeAgo(item.created_at_i, nowMs),
    content: deleted ? '[deleted]' : cleanText(item.text),
    ...(deleted ? { deleted: true as const } : {}),
    comments: item.children.map((child) => toComment(child, level + 1, nowMs)),
  };
}

function countComments(comments: HnapiComment[]): number {
  return comments.reduce((n, c) => n + 1 + countComments(c.comments), 0);
}

/**
 * Sorts top-level comments into HN's ranking. Algolia returns them oldest
 * first; Firebase's `kids` carries the ranked order. Anything Firebase doesn't
 * list yet keeps its Algolia position after the ranked ones. Replies stay
 * oldest first: ranking those would cost a Firebase request per comment.
 */
function rankTopLevel(children: AlgoliaItem[], rankedIds: number[] | null): AlgoliaItem[] {
  if (!rankedIds) return children;
  const rank = new Map(rankedIds.map((id, i) => [id, i]));
  return children
    .map((child, i) => ({ child, key: rank.get(child.id) ?? rankedIds.length + i }))
    .sort((a, b) => a.key - b.key)
    .map(({ child }) => child);
}

/** Converts an Algolia item tree into node-hnapi's `item/<id>` response. */
export function toHnapiItem(
  item: AlgoliaItem,
  rankedIds: number[] | null,
  pollOptions: FirebaseItem[] | null,
  nowMs: number,
): HnapiItem {
  const comments = rankTopLevel(item.children, rankedIds).map((child) => toComment(child, 0, nowMs));
  const isJob = item.type === 'job';
  return {
    id: item.id,
    title: item.title ?? '',
    points: isJob ? null : item.points,
    user: isJob ? null : item.author,
    time: item.created_at_i,
    time_ago: timeAgo(item.created_at_i, nowMs),
    type: TYPE_MAPPING[item.type] ?? item.type,
    content: cleanText(item.text),
    ...linkFields(item.id, item.url),
    ...(pollOptions?.length
      ? { poll: pollOptions.map((option) => ({ item: option.text, points: option.score })) }
      : {}),
    comments,
    comments_count: countComments(comments),
  };
}

/** Converts a Firebase story into one entry of node-hnapi's `news` list. */
export function toHnapiStory(item: FirebaseItem, nowMs: number): HnapiStory {
  const isJob = item.type === 'job';
  const story: HnapiStory = {
    id: item.id,
    title: item.title ?? '',
    points: isJob ? null : (item.score ?? null),
    user: isJob ? null : (item.by ?? null),
    time: item.time ?? 0,
    time_ago: timeAgo(item.time ?? 0, nowMs),
    comments_count: item.descendants ?? 0,
    type: TYPE_MAPPING[item.type ?? ''] ?? item.type ?? 'link',
    ...linkFields(item.id, item.url),
  };
  if (item.type === 'story' && !item.url && /^ask/i.test(story.title)) story.type = 'ask';
  return story;
}

class UpstreamError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`${url} returned ${status}`);
  }
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new UpstreamError(response.status, url);
  return response.json<T>();
}

function firebaseItem(id: number | string, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<FirebaseItem | null> {
  return fetchJson<FirebaseItem | null>(`${FIREBASE_URL}item/${id}.json`, timeoutMs);
}

async function loadItem(id: string, nowMs: number): Promise<HnapiItem> {
  const [item, rankedIds] = await Promise.all([
    fetchJson<AlgoliaItem>(`${ALGOLIA_ITEM_URL}${id}`, UPSTREAM_TIMEOUT_MS),
    firebaseItem(id, ORDERING_TIMEOUT_MS).then(
      (fb) => fb?.kids ?? null,
      () => null,
    ),
  ]);
  const pollOptions = item.options?.length
    ? (await Promise.all(item.options.map((option) => firebaseItem(option)))).filter(
        (option): option is FirebaseItem => option !== null,
      )
    : null;
  return toHnapiItem(item, rankedIds, pollOptions, nowMs);
}

/**
 * One page of the front page. All-or-nothing: a story that fails to load fails
 * the page, because a short list would get cached and look complete.
 */
async function loadNews(page: number, nowMs: number): Promise<HnapiStory[]> {
  const ids = await fetchJson<number[]>(`${FIREBASE_URL}topstories.json`, UPSTREAM_TIMEOUT_MS);
  const pageIds = ids.slice((page - 1) * STORIES_PER_PAGE, page * STORIES_PER_PAGE);
  const items = await Promise.all(pageIds.map((id) => firebaseItem(id)));
  return items.filter((item): item is FirebaseItem => item !== null).map((item) => toHnapiStory(item, nowMs));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? `public, max-age=${CACHE_TTL_SECONDS}` : 'no-store',
    },
  });
}

/** Maps an API path to its loader, or null for paths HackerWeb never calls. */
function loaderFor(path: string): ((nowMs: number) => Promise<unknown>) | null {
  if (path === 'news') return (now) => loadNews(1, now);
  if (path === 'news2') return (now) => loadNews(2, now);
  const item = /^item\/(\d+)$/.exec(path);
  if (item) return (now) => loadItem(item[1], now);
  return null;
}

/** Serves `/hw/api/*`. Same caching contract as the feeds: 5 minutes, 2xx only. */
export async function handleApi(request: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const load = loaderFor(url.pathname.slice(API_PREFIX.length));
  if (!load) return jsonResponse({ error: 'Not found' }, 404);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let body: unknown;
  try {
    body = await load(Date.now());
  } catch (err) {
    if (err instanceof UpstreamError && err.status === 404) return jsonResponse({ error: 'Item not found' }, 404);
    const stale = await cache.match(cacheKey, { ignoreMethod: true });
    if (stale) return stale;
    return jsonResponse({ error: `Upstream failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }

  const response = jsonResponse(body);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
