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

/* added_at = when a title first became playable on AsooGak (drives the TV's "New on AsooGak" row). It survives every
   merge; titles already listed before this field existed get 1 ("long-standing") so they never flood the row, and only
   titles that genuinely join the catalogue (or return after being evicted) are stamped with their verification time. */
export function stampAddedAt(items, previousItems) {
    const previous = new Map();
    for (const item of (Array.isArray(previousItems) ? previousItems : [])) {
        if (item && item.id && item.media_type) previous.set(item.media_type + ':' + item.id, Number(item.added_at) || 1);
    }
    for (const item of items) {
        const key = item.media_type + ':' + item.id;
        item.added_at = previous.has(key) ? previous.get(key) : (Number(item.added_at) || item.availability_at || Date.now());
    }
    return items;
}

/* How old the proof behind what the TV lists really is. This, not the re-check backlog, is the number that decides how
   many dead titles anyone sees: hot = the most popular titles (what rails and search surface first). */
export function proofAgeStats(items, now = Date.now(), hotPopularity = Number(process.env.HOT_POPULARITY || 15)) {
    const HOUR = 3600000;
    const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const ages = [], hot = [];
    for (const item of items) {
        const age = Math.max(0, now - (Number(item.availability_at) || 0)) / HOUR;
        ages.push(age);
        if ((Number(item.popularity) || 0) >= hotPopularity) hot.push(age);
    }
    ages.sort((a, b) => a - b);
    hot.sort((a, b) => a - b);
    const round = value => Math.round(value * 10) / 10;
    return {
        p50h: round(pct(ages, 0.5)), p95h: round(pct(ages, 0.95)), maxh: round(ages.at(-1) || 0),
        over24h: ages.filter(age => age > 24).length, over48h: ages.filter(age => age > 48).length,
        hotTitles: hot.length, hotP50h: round(pct(hot, 0.5)), hotP95h: round(pct(hot, 0.95)), hotMaxh: round(hot.at(-1) || 0)
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
    const runStats = { shardsMerged: shardFiles.length, checked: 0, verified: 0, failed: 0, rechecked: 0, proactive: 0, evicted: 0, episodesVerified: 0, seasonsChecked: 0, seasonsDead: 0, rateLimited: 0, recheckBacklog: 0, recheckLeft: 0, overdueLeft: 0, movieTasks: 0, movieWorkMs: 0, tvTasks: 0, tvWorkMs: 0, reasons: {} };

    for (const file of shardFiles) {
        try {
            const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
            shardPayloads.push(payload);
            if (Number.isInteger(payload.shard) && Number.isFinite(payload.nextCursor)) {
                shardCursors[payload.shard] = payload.nextCursor;
            }
            if (payload.stats) {
                for (const name of ['checked', 'verified', 'failed', 'rechecked', 'proactive', 'evicted', 'episodesVerified', 'seasonsChecked', 'seasonsDead', 'rateLimited', 'recheckBacklog', 'recheckLeft', 'overdueLeft', 'movieTasks', 'movieWorkMs', 'tvTasks', 'tvWorkMs']) {
                    runStats[name] += Number(payload.stats[name]) || 0;
                }
                for (const [reason, count] of Object.entries(payload.stats.reasons || {})) runStats.reasons[reason] = (runStats.reasons[reason] || 0) + (Number(count) || 0);
            }
        } catch (e) {}
    }

    let plan = null;
    try { plan = JSON.parse(process.env.PLAN_JSON || 'null'); } catch (e) {}
    const merged = mergeCatalogueSources([cloudflareData, existingGitHub, ...shardPayloads], now);
    stampAddedAt(merged.items, existingGitHub && existingGitHub.items);
    const proofAge = proofAgeStats(merged.items, now);

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
        proofAge,
        // Catch-up health: overdueLeft > 0 for several runs in a row means re-verification is falling behind.
        lastRun: runStats,
        // Rolling history + learned per-title costs feed plan.mjs (auto-scaling) and the watchdog issue.
        costs: plan && plan.costs ? plan.costs : (prevState.costs || null),
        plan: plan || null,
        history: [...(Array.isArray(prevState.history) ? prevState.history : []), {
            at: now, shards: runStats.shardsMerged, checked: runStats.checked, rechecked: runStats.rechecked, proactive: runStats.proactive,
            evicted: runStats.evicted, recheckLeft: runStats.recheckLeft, overdueLeft: runStats.overdueLeft,
            total: merged.totalPlayable, deep: merged.deepVerified,
            p50h: proofAge.p50h, p95h: proofAge.p95h, hotP95h: proofAge.hotP95h, over24h: proofAge.over24h
        }].slice(-48)
    }, null, 2));

    console.log(`Merged catalogue ready: ${merged.totalPlayable} playable titles (${merged.movieCount} movies, ${merged.tvCount} series, ${merged.deepVerified} deep-verified, ${merged.episodeVerdicts} verified episodes). Re-check backlog ${runStats.recheckBacklog}, left ${runStats.recheckLeft}. Proof age: median ${proofAge.p50h}h, p95 ${proofAge.p95h}h, popular p95 ${proofAge.hotP95h}h, ${proofAge.over24h} older than 24h.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
