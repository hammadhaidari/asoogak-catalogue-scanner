import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';

const SHARD_INDEX = Math.max(0, Number(process.env.SHARD_INDEX || 0));
const SHARD_TOTAL = Math.max(1, Number(process.env.SHARD_TOTAL || 8));
const SCAN_DURATION_MS = Math.max(30000, Number(process.env.SCAN_DURATION_MS || 210000));
const RECHECK_AGE_MS = Math.max(6 * 3600000, Number(process.env.RECHECK_AGE_MS || 24 * 3600000));
const NEGATIVE_RECHECK_MS = 48 * 3600000;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 3));
const CHECK_PACE_MS = Math.max(250, Number(process.env.CHECK_PACE_MS || 650));

const TMDB_KEY = (process.env.TMDB_KEY || '').trim();
const RESOLVER_KEY = (process.env.RESOLVER_KEY || '').trim();
const PROXY_URL = (process.env.PROXY_URL || '').trim();
const EXISTING_CATALOGUE_URL = (process.env.EXISTING_CATALOGUE_URL || '').trim();
const STATE_URL = (process.env.STATE_URL || '').trim();

if (!TMDB_KEY || !RESOLVER_KEY) {
    console.error('Missing required TMDB_KEY or RESOLVER_KEY environment secrets.');
    process.exit(1);
}

export function isAnimation(media) {
    if (!media) return false;
    return (Array.isArray(media.genre_ids) ? media.genre_ids : []).some(id => Number(id) === 16) ||
        (Array.isArray(media.genres) ? media.genres : []).some(genre => genre && Number(genre.id) === 16);
}

export function catalogueMetadata(key, data) {
    if (!/^(movie|tv):[1-9]\d{0,9}$/.test(key) || !data || String(data.id) !== key.split(':')[1]) return null;
    if (isAnimation(data)) return null;
    const type = key.split(':')[0];
    const genres = (data.genre_ids || (data.genres || []).map(g => g.id)).filter(Number.isInteger);
    if (type === 'tv' && genres.some(id => id === 10767 || id === 10763)) return null;
    const title = type === 'movie' ? data.title : data.name;
    const date = type === 'movie' ? data.release_date : data.first_air_date;
    if (typeof title !== 'string' || !title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date > new Date().toISOString().slice(0, 10)) return null;
    const text = value => typeof value === 'string' ? value.slice(0, 2000) : '';
    const image = value => typeof value === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(value) ? value : null;
    const number = value => Number.isFinite(value) ? value : 0;
    return {
        id: data.id,
        media_type: type,
        [type === 'movie' ? 'title' : 'name']: title.trim().slice(0, 300),
        [type === 'movie' ? 'release_date' : 'first_air_date']: date,
        poster_path: image(data.poster_path),
        backdrop_path: image(data.backdrop_path),
        overview: text(data.overview).slice(0, 400),
        popularity: number(data.popularity),
        vote_average: number(data.vote_average),
        vote_count: number(data.vote_count),
        genre_ids: genres.slice(0, 30),
        original_language: text(data.original_language).slice(0, 10),
        origin_country: (data.origin_country || (data.production_countries || []).map(c => c.iso_3166_1))
            .filter(c => typeof c === 'string' && /^[A-Z]{2}$/.test(c)).slice(0, 10)
    };
}

export function resolverUrl(key, secret, now = Date.now()) {
    const match = /^(movie|tv):(\d+)(?::s(\d+):e(\d+))?$/.exec(key);
    const identity = new TextEncoder().encode(match[2]);
    const message = new Uint8Array(identity.length + 8);
    message.set(identity);
    new DataView(message.buffer).setBigUint64(identity.length, BigInt(Math.floor(now / 1000) + 480), false);
    const nonce = new Uint8Array(24);
    const encrypted = nacl.secretbox(message, nonce, Uint8Array.from(secret.match(/../g), byte => parseInt(byte, 16)));
    const token = Buffer.from(new Uint8Array([...nonce, ...encrypted])).toString('base64url');
    return 'https://vidlink.pro/api/b/' + match[1] + '/' + token + (match[1] === 'tv' ? '/' + (match[3] || 1) + '/' + (match[4] || 1) : '') + '?multiLang=1';
}

function hashKey(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return Math.abs(h >>> 0);
}

async function fetchWithFallback(targetUrl, headers, timeoutMs = 10000) {
    try {
        const direct = await fetch(targetUrl, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
        if (direct.ok || direct.status === 206 || direct.status === 404 || direct.status === 410) return direct;
        await direct.body?.cancel();
    } catch (err) {}
    if (PROXY_URL) {
        const proxied = PROXY_URL + encodeURIComponent(targetUrl) + '&base=' + encodeURIComponent('https://vidlink.pro');
        return fetch(proxied, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    }
    throw new Error('Request failed');
}

export async function verifyStreamKey(key, secret) {
    const headers = {
        Referer: 'https://vidlink.pro/',
        Origin: 'https://vidlink.pro',
        'User-Agent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36'
    };
    let response;
    let reader;
    try {
        response = await fetchWithFallback(resolverUrl(key, secret), headers, 11000);
        if (response.status === 429) return { rateLimited: true };
        if ([400, 403, 404, 410, 422, 428].includes(response.status)) return { ok: false };
        if (!response.ok) return {};
        const data = await response.json();
        const stream = data && data.stream;
        const source = stream && (
            Object.values(stream.qualities || {}).find(v => v && v.url) ||
            (typeof stream.playlist === 'string' ? { url: stream.playlist, type: stream.type, headers: stream.playlistHeaders } : null)
        );
        if (!source || !source.url) return { ok: false };
        const target = new URL(source.url);
        if (target.protocol !== 'https:') return { ok: false };
        const cookie = source.headers && (source.headers.Cookie || source.headers.cookie);
        if (cookie) {
            for (const part of cookie.split(';')) {
                const sep = part.indexOf('=');
                if (sep < 0) continue;
                const names = { 'CloudFront-Policy': 'Policy', 'CloudFront-Signature': 'Signature', 'CloudFront-Key-Pair-Id': 'Key-Pair-Id' };
                const mapped = names[part.slice(0, sep).trim()];
                if (mapped) target.searchParams.set(mapped, part.slice(sep + 1).trim());
            }
        }
        response = await fetchWithFallback(target.href, { ...headers, Range: 'bytes=0-1024' }, 9000);
        if (response.status === 429) return { rateLimited: true };
        if ([400, 403, 404, 410, 422, 428].includes(response.status)) return { ok: false };
        if (!response.ok && response.status !== 206) return {};
        const contentType = response.headers.get('Content-Type') || '';
        if (/html|json/i.test(contentType)) return { ok: false };
        reader = response.body?.getReader();
        if (!reader) return {};
        let prefix = '';
        const decoder = new TextDecoder();
        while (prefix.length < 1024) {
            const chunk = await reader.read();
            if (chunk.done) break;
            prefix += decoder.decode(chunk.value.subarray(0, 1024 - prefix.length), { stream: true });
            if (/#EXTM3U|<(?:\w+:)?MPD\b/i.test(prefix)) break;
        }
        const hls = source.type === 'hls' || /\.m3u8(?:[?#]|$)|mpegurl/i.test(source.url + ' ' + contentType);
        const dash = source.type === 'dash' || /\.mpd(?:[?#]|$)|dash\+xml/i.test(source.url + ' ' + contentType);
        const ok = hls ? /^#EXTM3U/.test(prefix.trim()) : dash ? /<(?:\w+:)?MPD\b/i.test(prefix) : !!prefix.trim() && !/^(?:<!doctype|<html|\{)/i.test(prefix.trim());
        return { ok };
    } catch (err) {
        return {};
    } finally {
        try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch (e) {}
    }
}

export function discoveryFeed(counter) {
    const step = Math.max(0, counter - 1);
    const type = step % 3 === 2 ? 'tv' : 'movie';
    const ordinal = type === 'tv' ? Math.floor(step / 3) : step - Math.floor(step / 3);
    if (ordinal < 2000) {
        const partition = Math.floor(ordinal / 500);
        const page = (ordinal % 500) + 1;
        const sorts = ['popularity.desc', 'vote_count.desc', type === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc', 'vote_average.desc'];
        const votes = partition === 0 ? (type === 'tv' ? 30 : 50) : partition === 1 ? (type === 'tv' ? 10 : 15) : partition === 2 ? 5 : 10;
        return { type, path: '/discover/' + type + '?sort_by=' + sorts[partition] + '&include_adult=false&without_genres=16,10767,10763&vote_count.gte=' + votes + '&page=' + page };
    }
    const yearStep = ordinal - 2000;
    const page = (yearStep % 25) + 1;
    const yearOffset = Math.floor(yearStep / 25);
    const year = Math.max(1970, new Date().getFullYear() - yearOffset);
    return {
        type,
        path: '/discover/' + type + '?sort_by=popularity.desc&include_adult=false&without_genres=16,10767,10763&vote_count.gte=5&page=' + page +
            '&' + (type === 'tv' ? 'first_air_date_year' : 'primary_release_year') + '=' + year
    };
}

async function fetchJsonSafe(url) {
    if (!url) return null;
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
}

async function runShard() {
    const startedAt = Date.now();
    const existingCatalogue = (await fetchJsonSafe(EXISTING_CATALOGUE_URL)) || { records: {}, items: [] };
    const scannerState = (await fetchJsonSafe(STATE_URL)) || { shardCursors: {} };

    const knownRecords = existingCatalogue.records || {};
    const knownItemsMap = new Map((existingCatalogue.items || []).map(item => [item.media_type + ':' + item.id, item]));

    let cursor = Number(scannerState.shardCursors?.[SHARD_INDEX]) || (SHARD_INDEX + 1);
    const outputRecords = {};
    const outputItems = {};
    const stats = { shard: SHARD_INDEX, checked: 0, verified: 0, failed: 0, rechecked: 0, episodesVerified: 0, rateLimited: 0 };

    // 1. Collect stale titles assigned to this shard for 24-hour freshness re-verification
    const now = Date.now();
    const recheckQueue = [];
    for (const [key, item] of knownItemsMap.entries()) {
        if (hashKey(key) % SHARD_TOTAL !== SHARD_INDEX) continue;
        const lastAt = knownRecords[key]?.at || item.availability_at || 0;
        if (now - lastAt >= RECHECK_AGE_MS) {
            recheckQueue.push({ key, metadata: item, isRecheck: true });
        }
    }

    // 2. Discover new candidates for this shard from TMDB feeds
    const discoveryQueue = [];
    const priorityFeeds = [
        { type: 'movie', path: '/trending/movie/day?page=' + (SHARD_INDEX + 1) },
        { type: 'tv', path: '/trending/tv/day?page=' + (SHARD_INDEX + 1) },
        { type: 'movie', path: '/movie/now_playing?page=' + (SHARD_INDEX + 1) },
        { type: 'tv', path: '/tv/on_the_air?page=' + (SHARD_INDEX + 1) }
    ];

    async function pullMoreCandidates() {
        const feed = priorityFeeds.length ? priorityFeeds.shift() : discoveryFeed(cursor);
        if (!priorityFeeds.length) cursor += SHARD_TOTAL;
        try {
            const res = await fetch('https://api.themoviedb.org/3' + feed.path + '&api_key=' + encodeURIComponent(TMDB_KEY), { signal: AbortSignal.timeout(8000) });
            if (!res.ok) return;
            const data = await res.json();
            for (const raw of (data.results || [])) {
                const key = feed.type + ':' + raw.id;
                const meta = catalogueMetadata(key, raw);
                if (!meta) continue;
                const existing = knownRecords[key];
                if (existing) {
                    const age = Date.now() - (existing.at || 0);
                    if (existing.ok && age < RECHECK_AGE_MS) continue;
                    if (!existing.ok && age < NEGATIVE_RECHECK_MS) continue;
                }
                if (outputRecords[key]) continue;
                discoveryQueue.push({ key, metadata: meta, isRecheck: false });
            }
        } catch (e) {}
    }

    // Pre-fill initial discovery candidates
    for (let i = 0; i < 6; i++) {
        await pullMoreCandidates();
    }

    let cooldownUntil = 0;

    async function workerLoop(workerId) {
        while (Date.now() - startedAt < SCAN_DURATION_MS) {
            if (cooldownUntil > Date.now()) {
                await new Promise(r => setTimeout(r, Math.min(5000, cooldownUntil - Date.now())));
                continue;
            }
            // Balance: 35% re-verification of existing titles, 65% new title discovery
            let task = null;
            if (recheckQueue.length && (workerId === 0 || discoveryQueue.length === 0)) {
                task = recheckQueue.shift();
            } else {
                if (discoveryQueue.length < 15) await pullMoreCandidates();
                task = discoveryQueue.shift() || recheckQueue.shift();
            }
            if (!task) {
                await pullMoreCandidates();
                if (!discoveryQueue.length && !recheckQueue.length) break;
                continue;
            }

            const verdict = await verifyStreamKey(task.key, RESOLVER_KEY);
            const checkedAt = Date.now();
            if (verdict.rateLimited) {
                stats.rateLimited++;
                cooldownUntil = Math.max(cooldownUntil, Date.now() + 8000);
                continue;
            }
            if (typeof verdict.ok === 'boolean') {
                stats.checked++;
                if (task.isRecheck) stats.rechecked++;
                outputRecords[task.key] = { ok: verdict.ok, at: checkedAt };
                if (verdict.ok) {
                    stats.verified++;
                    outputItems[task.key] = { ...task.metadata, availability_at: checkedAt };
                    // If TV series is playable on S1:E1, also record S1:E1 and probe S1:E2 & S1:E3
                    if (task.key.startsWith('tv:')) {
                        outputRecords[task.key + ':s1:e1'] = { ok: true, at: checkedAt };
                        stats.episodesVerified++;
                        for (const epNum of [2, 3]) {
                            if (Date.now() - startedAt >= SCAN_DURATION_MS) break;
                            await new Promise(r => setTimeout(r, CHECK_PACE_MS));
                            const epKey = task.key + ':s1:e' + epNum;
                            const epVerdict = await verifyStreamKey(epKey, RESOLVER_KEY);
                            if (typeof epVerdict.ok === 'boolean') {
                                outputRecords[epKey] = { ok: epVerdict.ok, at: Date.now() };
                                if (epVerdict.ok) stats.episodesVerified++;
                            }
                        }
                    }
                } else {
                    stats.failed++;
                }
            }
            await new Promise(r => setTimeout(r, CHECK_PACE_MS));
        }
    }

    await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, idx) => workerLoop(idx)));

    const outPath = `shard-output-${SHARD_INDEX}.json`;
    fs.writeFileSync(outPath, JSON.stringify({
        shard: SHARD_INDEX,
        nextCursor: cursor,
        updatedAt: Date.now(),
        stats,
        records: outputRecords,
        items: Object.values(outputItems)
    }));
    console.log(`Shard ${SHARD_INDEX} complete:`, JSON.stringify(stats));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    runShard().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
