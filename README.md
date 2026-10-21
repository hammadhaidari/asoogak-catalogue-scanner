# AsooGak Distributed Catalogue & Episode Scanner

Multi-IP GitHub Actions verification engine for the AsooGak Smart TV:
- **16 parallel shards** every 30 minutes, each scanning for 20 minutes from an independent datacenter IP.
- **Deep verification (v2):** resolver → manifest → real init + first media segment bytes (MP4/TS signatures), plus an
  identity check (stream length vs TMDB runtime, release-name year and SxxEyy) so wrong films and trailers are rejected.
- **Every aired season verified:** the first and latest aired episode of each season must play; only those seasons are
  published as `playable_seasons`, and a series with none is not listed.
- **Daily re-verification, oldest first:** titles never deep-verified go first; any title not re-proven within 3 days is
  evicted. `scanner-state.json → lastRun.recheckLeft` > 0 for several runs means re-checks are falling behind.
- **Global CDN snapshot:** publishes `catalogue.json` and `scanner-state.json` to the `catalogue-data` branch.

Tests: `node --test scanner.test.mjs`
