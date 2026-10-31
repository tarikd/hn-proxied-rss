import { describe, expect, it } from 'vitest';
import { type AlgoliaItem, type FirebaseItem, timeAgo, toHnapiItem, toHnapiStory } from '../src/hnapi';
import algoliaJson from './fixtures/algolia-item-50317363.json?raw';
import firebaseJson from './fixtures/firebase-item-50317363.json?raw';

const algolia = JSON.parse(algoliaJson) as AlgoliaItem;
const firebase = JSON.parse(firebaseJson) as FirebaseItem;
// One hour after the story was posted.
const NOW = (algolia.created_at_i + 3600) * 1000;

describe('toHnapiItem', () => {
  const item = toHnapiItem(algolia, firebase.kids ?? null, null, NOW);

  it('maps the story fields the way node-hnapi does', () => {
    expect(item).toMatchObject({
      id: 50317363,
      title: 'Casio Watches of the 1980s',
      points: algolia.points,
      user: 'karagenit',
      time: 1793462448,
      time_ago: 'an hour ago',
      type: 'link',
      url: 'https://www.casio.com/us/watches/50th/Heritage/1980s/',
      domain: 'casio.com',
    });
    expect(item.content).toBeUndefined();
    expect(item.poll).toBeUndefined();
  });

  it('keeps every comment in the tree', () => {
    // 30 comments across three levels in the fixture.
    expect(item.comments_count).toBe(30);
    const nested = item.comments.find((c) => c.id === 50317749);
    expect(nested?.comments.map((c) => c.id)).toEqual([50317864, 50317925, 50317944, 50318004, 50318021]);
    expect(nested?.comments[1].comments[0]).toMatchObject({ id: 50318168, level: 2, user: 'al_borland' });
  });

  it('orders top-level comments by HN rank, skipping ids Algolia does not have', () => {
    // Firebase ranks 50318317 first, but it is not in the Algolia tree yet.
    expect(item.comments.map((c) => c.id)).toEqual(firebase.kids?.filter((id) => id !== 50318317));
  });

  it('falls back to Algolia order without a ranking', () => {
    const unranked = toHnapiItem(algolia, null, null, NOW);
    expect(unranked.comments.map((c) => c.id)).toEqual(algolia.children.map((c) => c.id));
  });

  it('puts comments Firebase does not rank after the ranked ones', () => {
    const partial = toHnapiItem(algolia, [50318059, 50317540], null, NOW);
    expect(partial.comments.slice(0, 3).map((c) => c.id)).toEqual([50318059, 50317540, 50317607]);
    expect(partial.comments).toHaveLength(algolia.children.length);
  });

  it('cleans comment HTML like node-hnapi', () => {
    const first = item.comments.find((c) => c.id === 50317540);
    expect(first).toMatchObject({ level: 0, user: 'mikece', time_ago: expect.stringMatching(/ago$/) });
    expect(first?.content).toMatch(/^<p>They worked then, they still work\.<p>/);
    expect(first?.content).not.toContain('</p>');
  });

  it('renders a bare comment as deleted', () => {
    const bare: AlgoliaItem = { ...algolia.children[0], author: null, text: null, children: [] };
    const result = toHnapiItem({ ...algolia, children: [bare] }, null, null, NOW);
    expect(result.comments[0]).toMatchObject({ deleted: true, content: '[deleted]', user: null });
  });

  it('links text posts to HN and maps polls', () => {
    const poll: AlgoliaItem = {
      ...algolia,
      type: 'poll',
      url: null,
      text: 'Which one?',
      options: [1, 2],
      children: [],
    };
    const options: FirebaseItem[] = [
      { id: 1, text: 'This', score: 3 },
      { id: 2, text: 'That', score: 5 },
    ];
    const result = toHnapiItem(poll, null, options, NOW);
    expect(result).toMatchObject({ url: 'item?id=50317363', type: 'poll', content: '<p>Which one?' });
    expect(result.domain).toBeUndefined();
    expect(result.poll).toEqual([
      { item: 'This', points: 3 },
      { item: 'That', points: 5 },
    ]);
    expect(result.comments).toEqual([]);
    expect(result.comments_count).toBe(0);
  });
});

describe('toHnapiStory', () => {
  it('maps a Firebase story into a news entry', () => {
    expect(toHnapiStory(firebase, NOW)).toEqual({
      id: 50317363,
      title: 'Casio Watches of the 1980s',
      points: firebase.score,
      user: 'karagenit',
      time: 1793462448,
      time_ago: 'an hour ago',
      comments_count: 34,
      type: 'link',
      url: 'https://www.casio.com/us/watches/50th/Heritage/1980s/',
      domain: 'casio.com',
    });
  });

  it('flags Ask HN posts and hides job authors', () => {
    expect(toHnapiStory({ id: 1, type: 'story', title: 'Ask HN: Why?', time: 0 }, NOW)).toMatchObject({
      type: 'ask',
      url: 'item?id=1',
    });
    expect(toHnapiStory({ id: 2, type: 'job', title: 'Hiring', by: 'yc', score: 1, time: 0 }, NOW)).toMatchObject({
      type: 'job',
      user: null,
      points: null,
    });
  });
});

describe('timeAgo', () => {
  const at = (secondsAgo: number) => timeAgo(1_000_000 - secondsAgo, 1_000_000 * 1000);

  it("uses moment's fromNow wording and thresholds", () => {
    expect(at(10)).toBe('a few seconds ago');
    expect(at(60)).toBe('a minute ago');
    expect(at(5 * 60)).toBe('5 minutes ago');
    expect(at(50 * 60)).toBe('an hour ago');
    expect(at(3 * 3600)).toBe('3 hours ago');
    expect(at(23 * 3600)).toBe('a day ago');
    expect(at(4 * 86400)).toBe('4 days ago');
    expect(at(30 * 86400)).toBe('a month ago');
    expect(at(90 * 86400)).toBe('3 months ago');
    expect(at(365 * 86400)).toBe('a year ago');
    expect(at(20 * 365 * 86400)).toBe('20 years ago');
  });

  it('treats a timestamp slightly in the future as just now', () => {
    expect(at(-30)).toBe('a few seconds ago');
  });
});
