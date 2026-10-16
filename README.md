# AsooGak Distributed Catalogue & Episode Scanner

Multi-IP GitHub Actions verification engine for AsooGak Smart TV:
- **8 Parallel Shards (`ubuntu-latest`)** run every 2 hours across independent datacenter IPs.
- **24-Hour Freshness Re-Verification:** Existing titles older than 24 hours are continuously re-verified so dead links are automatically evicted.
- **Multi-Episode TV Series Probing:** Verifies `S1:E1`, `S1:E2`, and `S1:E3` for series candidates.
- **Global CDN Snapshot:** Publishes `catalogue.json` and `scanner-state.json` to the `catalogue-data` branch.
