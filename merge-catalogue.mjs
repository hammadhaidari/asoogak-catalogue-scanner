import fs from 'node:fs';
import path from 'node:path';

// A title must be re-proven within 3 days or it leaves the catalogue (was 14 days, so dead titles lingered for two weeks
// whenever re-checks were inconclusive). Re-checks run every 24h, so 3 days absorbs a couple of failed runs.
const POSITIVE_RETAIN_MS = 3 * 24 * 3600000;
const NEGATIVE_RETAIN_MS = 72 * 3600000;
const DEEP_VERSION = 2;
const AVAILABILITY_API = (process.env.AVAILABILITY_API || 'https://asoogak-availability.cinejoy-tv-3274.workers.dev').trim();
const EXISTING_CATALOGUE_URL = (process.env.EXISTING_CATALOGUE_URL || '').trim();
const STATE_URL = (process.env.STATE_URL || '').trim();
const ARTIFACTS_DIR = process.env.ARTIFACTS_DIR || '.';
const OUTPUT_DIR = process.env.OUTPUT_DIR || 'dist';

async function fetchJsonSafe(url) {
    if (!url) return null;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function fetchCloudflareCatalogue(baseUrl) {
    if (!baseUrl) return { records: {}, items: [] };
    const records = {};
    const items = [];
    let after = '';
    const seen = new Set();
    try {
        for (let pageCount = 0; pageCount < 60; pageCount++) {
            const url = baseUrl + '/catalogue' + (after ? '?after=' + encodeURIComponent(after) : '');
            const data = await fetchJsonSafe(url);
            if (!data || !data.records) break;
            Object.assign(records, data.records);
            if (Array.isArray(data.items)) items.push(...data.items);
            if (!data.paginated || !data.after || seen.has(data.after)) break;
            seen.add(data.after);
            after = data.after;
        }
    } catch (e) {}
    return { records, items };
}

function findShardFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findShardFiles(full));
        } else if (/^shard-output-\d+\.json$/.test(entry.name)) {
            results.push(full);
        }
    }
    return results;
}

export function mergeCatalogueSources(sources, now = Date.now()) {
    const mergedRecords = {};
    const mergedItemsMap = new Map();
    const isDeep = value => Number(value && (value.v || value.verified_v)) >= DEEP_VERSION;
    const retained = rec => { const age = now - rec.at; return age >= 0 && age < (rec.ok ? POSITIVE_RETAIN_MS : NEGATIVE_RETAIN_MS); };

    for (const src of sources) {
        if (!src) continue;
        for (const [key, rec] of Object.entries(src.records || {})) {
            if (!rec || typeof rec.ok !== 'boolean' || !Number.isFinite(rec.at)) continue;
            const next = { ok: rec.ok, at: rec.at, ...(isDeep(rec) ? { v: DEEP_VERSION } : {}) };
            const prev = mergedRecords[key];
            // A retained deep (segment + identity + season) verdict outranks any shallow manifest-only verdict, even a
            // newer one; otherwise the older/other checkers would keep re-listing titles the deep scan proved dead.
            const nextWins = !prev ||
                (isDeep(next) && !isDeep(prev) && retained(next)) ||
                (isDeep(next) === isDeep(prev) && next.at >= prev.at) ||
                (!isDeep(next) && isDeep(prev) && !retained(prev) && next.at >= prev.at);
            if (nextWins) mergedRecords[key] = next;
        }
        for (const item of (src.items || [])) {
            if (!item || !item.id || !['movie', 'tv'].includes(item.media_type)) continue;
            const key = item.media_type + ':' + item.id;
            const prev = mergedItemsMap.get(key);
            const nextWins = !prev ||
                (isDeep(item) && !isDeep(prev)) ||
                (isDeep(item) === isDeep(prev) && (item.availability_at || 0) >= (prev.availability_at || 0));
            if (nextWins) mergedItemsMap.set(key, { ...item });
        }
    }

    // Prune expired records
    const activeRecords = {};
    let episodeVerdicts = 0;
    for (const [key, rec] of Object.entries(mergedRecords)) {
        if (!retained(rec)) continue;
        activeRecords[key] = rec;
        if (key.includes(':s') && rec.ok) episodeVerdicts++;
    }

    // Build active verified items list (evicting any item whose latest verdict is ok: false or expired)
    const activeItems = [];
    let movieCount = 0;
    let tvCount = 0;
    let deepCount = 0;
    for (const [key, item] of mergedItemsMap.entries()) {
        const verdict = activeRecords[key];
        if (!verdict || !verdict.ok) continue;
        // A deep-verified series lists only its proven seasons; one with none proven is not playable at all.
        if (item.media_type === 'tv' && isDeep(item) && (!Array.isArray(item.playable_seasons) || !item.playable_seasons.length)) continue;
        item.availability_at = verdict.at;
        activeItems.push(item);
        if (isDeep(item)) deepCount++;
        if (item.media_type === 'movie') movieCount++;
        else if (item.media_type === 'tv') tvCount++;
    }

    activeItems.sort((a, b) => (b.popularity || 0) - (a.popularity || 0) || a.id - b.id);

    return {
        updatedAt: now,
        paginated: false,
        totalPlayable: activeItems.length,
        movieCount,
        tvCount,
        deepVerified: deepCount,
        episodeVerdicts,
        records: activeRecords,
        items: activeItems
    };
}

async function main() {
    const now = Date.now();
    const existingGitHub = await fetchJsonSafe(EXISTING_CATALOGUE_URL);
    const prevState = (await fetchJsonSafe(STATE_URL)) || { shardCursors: {} };
    const cloudflareData = await fetchCloudflareCatalogue(AVAILABILITY_API);

    const shardFiles = findShardFiles(ARTIFACTS_DIR);
    const shardPayloads = [];
    const shardCursors = { ...(prevState.shardCursors || {}) };
    const runStats = { shardsMerged: shardFiles.length, checked: 0, verified: 0, failed: 0, rechecked: 0, evicted: 0, episodesVerified: 0, seasonsChecked: 0, seasonsDead: 0, rateLimited: 0, recheckBacklog: 0, recheckLeft: 0, reasons: {} };

    for (const file of shardFiles) {
        try {
            const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            shardPayloads.push(payload);
            if (Number.isInteger(payload.shard) && Number.isFinite(payload.nextCursor)) {
                shardCursors[payload.shard] = payload.nextCursor;
            }
            if (payload.stats) {
                for (const name of ['checked', 'verified', 'failed', 'rechecked', 'evicted', 'episodesVerified', 'seasonsChecked', 'seasonsDead', 'rateLimited', 'recheckBacklog', 'recheckLeft']) {
                    runStats[name] += Number(payload.stats[name]) || 0;
                }
                for (const [reason, count] of Object.entries(payload.stats.reasons || {})) runStats.reasons[reason] = (runStats.reasons[reason] || 0) + (Number(count) || 0);
            }
        } catch (e) {}
    }

    const merged = mergeCatalogueSources([cloudflareData, existingGitHub, ...shardPayloads], now);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'catalogue.json'), JSON.stringify(merged));
    fs.writeFileSync(path.join(OUTPUT_DIR, 'scanner-state.json'), JSON.stringify({
        updatedAt: now,
        shardCursors,
        totalPlayable: merged.totalPlayable,
        movieCount: merged.movieCount,
        tvCount: merged.tvCount,
        deepVerified: merged.deepVerified,
        episodeVerdicts: merged.episodeVerdicts,
        // Catch-up health: recheckLeft > 0 for several runs in a row means re-verification is falling behind.
        lastRun: runStats
    }, null, 2));

    console.log(`Merged catalogue ready: ${merged.totalPlayable} playable titles (${merged.movieCount} movies, ${merged.tvCount} series, ${merged.deepVerified} deep-verified, ${merged.episodeVerdicts} verified episodes). Re-check backlog ${runStats.recheckBacklog}, left ${runStats.recheckLeft}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
