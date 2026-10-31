# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-31

### Added
- A self-hosted copy of HackerWeb at `/hw/`, vendored from cheeaun/hackerweb by `npm run vendor:hackerweb`.
- `/hw/api/news`, `/hw/api/news2` and `/hw/api/item/<id>`, replacing the public HackerWeb API. Threads come from Algolia in one request, so a thread either loads in full or fails and falls back to the public API. Top-level comments follow HN's ranking.

### Changed
- Comment links in feeds now point at `/hw/#/item/<id>` on the same host as the feed, not hackerweb.app. The public HackerWeb API was dropping comments at random and caching the result, so many threads showed up empty or cut short.
- `<guid>` is no longer rewritten and keeps the HN URL. Feed readers will list current items as new one more time after this update, but item identity won't change again if the frontend moves.

## [1.0.0] - 2026-08-10

### Added
- Proxy for hnrss.org feeds that points Hacker News comment links at HackerWeb.

[1.1.0]: https://github.com/tarikd/hn-proxied-rss/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tarikd/hn-proxied-rss/releases/tag/v1.0.0
