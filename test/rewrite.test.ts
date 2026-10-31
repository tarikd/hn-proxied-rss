import { describe, expect, it } from 'vitest';
import { hackerWebUrl, rewriteFeed, upstreamUrlFor } from '../src/index';
import fixture from './fixtures/hnrss-frontpage.xml?raw';

const ORIGIN = 'https://worker.dev';

describe('rewriteFeed', () => {
  const rewritten = rewriteFeed(fixture, ORIGIN);
  /** The feed with every <guid> element removed. */
  const withoutGuids = (xml: string) => xml.replace(/<guid\b[^>]*>[\s\S]*?<\/guid>/g, '');

  it('rewrites every HN comment link in a real feed', () => {
    expect(fixture).toContain('https://news.ycombinator.com/item?id=49241679');
    expect(withoutGuids(rewritten)).not.toContain('news.ycombinator.com/item?id=');
    expect(rewritten).toContain('https://worker.dev/hw/#/item/49241679');
  });

  it('rewrites the Comments link inside description CDATA, href and text alike', () => {
    // hnrss renders the comments URL twice: once as the href, once as the
    // visible anchor text. Both have to move or the displayed link lies.
    const anchor =
      '<a href="https://worker.dev/hw/#/item/49241679">https://worker.dev/hw/#/item/49241679</a>';
    expect(rewritten).toContain(anchor);
    expect(rewritten).toContain('<![CDATA[');
  });

  it('rewrites <comments>', () => {
    expect(rewritten).toContain('<comments>https://worker.dev/hw/#/item/49241679</comments>');
  });

  it('leaves <guid> as hnrss sent it, so item identity survives a frontend move', () => {
    expect(rewritten).toContain(
      '<guid isPermaLink="false">https://news.ycombinator.com/item?id=49241679</guid>',
    );
    const input =
      '<guid isPermaLink="true">https://news.ycombinator.com/item?id=42</guid><comments>https://news.ycombinator.com/item?id=42</comments>';
    expect(rewriteFeed(input, ORIGIN)).toBe(
      '<guid isPermaLink="true">https://news.ycombinator.com/item?id=42</guid><comments>https://worker.dev/hw/#/item/42</comments>',
    );
  });

  it('points links at whichever origin served the feed', () => {
    expect(rewriteFeed('<comments>https://news.ycombinator.com/item?id=7</comments>', 'http://127.0.0.1:8787')).toBe(
      '<comments>http://127.0.0.1:8787/hw/#/item/7</comments>',
    );
  });

  it('leaves the rest of the feed untouched', () => {
    // Titles, dates, authors, and external article URLs must survive verbatim.
    expect(rewritten).toContain(
      '<title><![CDATA[Meta Muse Glimmer – open weights 30B local coding model]]></title>',
    );
    expect(rewritten).toContain('<pubDate>Mon, 10 Aug 2026 10:10:02 +0000</pubDate>');
    expect(rewritten).toContain('<dc:creator>riordan</dc:creator>');
    expect(rewritten).toContain(
      '<link>https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model</link>',
    );
    // The channel-level HN link is not an item permalink and must not move.
    expect(rewritten).toContain('<link>https://news.ycombinator.com/</link>');
  });

  it('only changes the comment URLs', () => {
    const restored = rewritten.replace(
      /https:\/\/worker\.dev\/hw\/#\/item\/(\d+)/g,
      'https://news.ycombinator.com/item?id=$1',
    );
    expect(restored).toBe(fixture);
  });

  it('maps an id to its HackerWeb URL', () => {
    expect(hackerWebUrl(ORIGIN, '49241679')).toBe('https://worker.dev/hw/#/item/49241679');
  });
});

describe('upstreamUrlFor', () => {
  it('passes the path and query through to hnrss', () => {
    expect(upstreamUrlFor('https://worker.dev/frontpage?points=100')?.toString()).toBe(
      'https://hnrss.org/frontpage?points=100',
    );
  });

  it('supports other hnrss endpoints', () => {
    expect(upstreamUrlFor('https://worker.dev/newest')?.toString()).toBe('https://hnrss.org/newest');
    expect(upstreamUrlFor('https://worker.dev/best')?.toString()).toBe('https://hnrss.org/best');
  });

  it('defaults the root path to the front page', () => {
    expect(upstreamUrlFor('https://worker.dev/')?.toString()).toBe('https://hnrss.org/frontpage');
  });

  it('rejects paths that are not feed endpoints', () => {
    expect(upstreamUrlFor('https://worker.dev/a/b')).toBeNull();
    expect(upstreamUrlFor('https://worker.dev/feed.xml')).toBeNull();
  });

  it('cannot be pointed at another origin', () => {
    // URL parsing collapses traversal before the check, so the result is a
    // normal single-segment path that still resolves against hnrss.org.
    expect(upstreamUrlFor('https://worker.dev/../etc')?.toString()).toBe('https://hnrss.org/etc');
    expect(upstreamUrlFor('https://worker.dev//example.com/x')).toBeNull();
  });
});
