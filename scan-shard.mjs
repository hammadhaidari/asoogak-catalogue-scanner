import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import nacl from 'tweetnacl';

const SHARD_INDEX = Math.max(0, Number(process.env.SHARD_INDEX || 0));
const SHARD_TOTAL = Math.max(1, Number(process.env.SHARD_TOTAL || 16));
const SCAN_DURATION_MS = Math.max(30000, Number(process.env.SCAN_DURATION_MS || 1200000));
// Every listed title is re-proven daily (was 48h, and the queue was unordered so some titles waited ~4 days).
const RECHECK_AGE_MS = Math.max(6 * 3600000, Number(process.env.RECHECK_AGE_MS || 24 * 3600000));
// Set by plan.mjs when demand outgrows capacity: the long tail (popularity below POPULAR_MIN) is re-proven less often
// than popular titles, but always inside the 3-day retention window.
const RECHECK_AGE_TAIL_MS = Math.max(RECHECK_AGE_MS, Number(process.env.RECHECK_AGE_TAIL_MS || RECHECK_AGE_MS));
const POPULAR_MIN = Number(process.env.POPULAR_MIN || 0);
export function recheckAgeFor(item, popularMin = POPULAR_MIN, fast = RECHECK_AGE_MS, tail = RECHECK_AGE_TAIL_MS) {
    return (Number(item && item.popularity) || 0) >= popularMin ? fast : tail;
}
const NEGATIVE_RECHECK_MS = 72 * 3600000;
const WORKER_CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 3));
const CHECK_PACE_MS = Math.max(250, Number(process.env.CHECK_PACE_MS || 600));
// v2 = deep check: resolver + manifest + real init/media segment bytes + runtime/title identity + every aired season.
export const VERIFY_VERSION = 2;

const TMDB_KEY = (process.env.TMDB_KEY || '').trim();
const RESOLVER_KEY = (process.env.RESOLVER_KEY || '').trim();
const PROXY_URLS = (process.env.PROXY_URL || '').split(',').map(s => s.trim()).filter(Boolean);
let proxyCursor = SHARD_INDEX;
const EXISTING_CATALOGUE_URL = (process.env.EXISTING_CATALOGUE_URL || '').trim();
const STATE_URL = (process.env.STATE_URL || '').trim();
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;

if (IS_MAIN && (!TMDB_KEY || !RESOLVER_KEY)) {
    console.error('Missing required TMDB_KEY or RESOLVER_KEY environment secrets.');
    process.exit(1);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));

async function tmdbJson(path) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch('https://api.themoviedb.org/3' + path + (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(TMDB_KEY), { signal: AbortSignal.timeout(8000) });
            if (res.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            await sleep(800);
        }
    }
    return null;
}

/* Aired seasons with the episode number to prove last: the latest aired episode for the airing season, otherwise the
   season's final episode. Specials (season 0) and unaired seasons are never offered on the TV. */
export function airedSeasons(details, today = new Date().toISOString().slice(0, 10)) {
    const lastAired = details && details.last_episode_to_air;
    return (details && Array.isArray(details.seasons) ? details.seasons : [])
        .filter(season => season && season.season_number > 0 && season.episode_count > 0 && season.air_date && season.air_date <= today)
        .map(season => {
            let last = season.episode_count;
            if (lastAired && lastAired.season_number === season.season_number) last = Math.min(last, lastAired.episode_number || last);
            if (lastAired && lastAired.season_number < season.season_number) last = 0;
            return { number: season.season_number, last };
        })
        .filter(season => season.last > 0)
        .sort((a, b) => a.number - b.number);
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
    if (PROXY_URLS.length) {
        const proxyBase = PROXY_URLS[proxyCursor++ % PROXY_URLS.length];
        const proxied = proxyBase + encodeURIComponent(targetUrl) + '&base=' + encodeURIComponent('https://vidlink.pro');
        return fetch(proxied, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    }
    throw new Error('Request failed');
}

export async function verifyStreamKey(key, secret, expect = {}) {
    const headers = {
        Referer: 'https://vidlink.pro/',
        Origin: 'https://vidlink.pro',
        'User-Agent': 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36',
        'X-Playback-Environment': 'dash-hevc'
    };
    let response;
    try {
        response = await fetchWithFallback(resolverUrl(key, secret), headers, 11000);
        if (response.status === 429) return { rateLimited: true };
        if ([400, 403, 404, 410, 422, 428].includes(response.status)) return { ok: false, reason: 'resolver-' + response.status };
        if (!response.ok) return {};
        const data = await response.json();
        const stream = data && data.stream;
        const source = stream && (
            Object.values(stream.qualities || {}).find(v => v && v.url) ||
            (typeof stream.playlist === 'string' ? { url: stream.playlist, type: stream.type, headers: stream.playlistHeaders } : null)
        );
        if (!source || !source.url) return { ok: false, reason: 'no-stream' };
        const target = new URL(source.url);
        if (target.protocol !== 'https:') return { ok: false, reason: 'insecure' };
        if (/^hcdn\d*\.hakunaymatata\.com$/i.test(target.hostname)) target.hostname = 'hcdn5.hakunaymatata.com';
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
        const isHakunaDirect = target.hostname.endsWith('hakunaymatata.com') && target.hostname !== 'sacdn.hakunaymatata.com';
        const probeHeaders = isHakunaDirect
            ? {
                'User-Agent': (source.headers && (source.headers['User-Agent'] || source.headers['user-agent'])) || 'com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)',
                Accept: '*/*'
            }
            : { ...headers };
        const metaDuration = Number(stream.playbackMetadata && stream.playbackMetadata.duration) || 0;
        // A raw progressive file (mp4/mkv) has no manifest: its first bytes must be real media.
        const hlsHint = source.type === 'hls' || /\.m3u8(?:[?#]|$)/i.test(source.url);
        const dashHint = source.type === 'dash' || /\.mpd(?:[?#]|$)/i.test(source.url);
        if (!hlsHint && !dashHint) {
            const media = await probeMediaBytes(target.href, probeHeaders);
            if (media.rateLimited || media.unknown) return media.rateLimited ? { rateLimited: true } : {};
            if (!media.ok) return { ok: false, reason: 'file-' + media.reason };
            return identityVerdict({ duration: metaDuration, title: '' }, expect);
        }
        const manifest = await fetchText(target.href, probeHeaders, 9000, 2 * 1024 * 1024);
        if (manifest.rateLimited) return { rateLimited: true };
        if (manifest.status && [400, 403, 404, 410, 422, 428].includes(manifest.status)) return { ok: false, reason: 'manifest-' + manifest.status };
        if (manifest.unknown) return {};
        const plan = /<(?:\w+:)?MPD\b/i.test(manifest.text) ? dashPlan(manifest.text, target.href)
            : /^#EXTM3U/.test(manifest.text.trim()) ? await hlsPlan(manifest.text, target.href, probeHeaders) : null;
        if (!plan) return { ok: false, reason: 'bad-manifest' };
        if (plan.unknown) return {};
        if (plan.rateLimited) return { rateLimited: true };
        if (!plan.segments.length) return { ok: false, reason: 'no-segments' };
        // The TV only plays if the CDN actually serves video bytes; a valid manifest over dead segments used to pass.
        for (const segment of plan.segments) {
            const media = await probeMediaBytes(segment, probeHeaders, plan.encrypted);
            if (media.rateLimited) return { rateLimited: true };
            if (media.unknown) return {};
            if (!media.ok) return { ok: false, reason: 'segment-' + media.reason };
        }
        return identityVerdict({ duration: plan.duration || metaDuration, title: plan.title || '' }, expect);
    } catch (err) {
        return {};
    } finally {
        try { await response?.body?.cancel(); } catch (e) {}
    }
}

/* ---------- Deep verification helpers ---------- */

async function fetchText(url, headers, timeoutMs, maxBytes) {
    let res, reader;
    try {
        res = await fetchWithFallback(url, headers, timeoutMs);
        if (res.status === 429) return { rateLimited: true };
        if (!res.ok) return res.status >= 500 || res.status === 408 ? { unknown: true } : { status: res.status };
        if (/html|json/i.test(res.headers.get('Content-Type') || '')) return { status: 415 };
        reader = res.body?.getReader();
        if (!reader) return { unknown: true };
        const decoder = new TextDecoder();
        let text = '', size = 0;
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            text += decoder.decode(chunk.value, { stream: true });
            if (size > maxBytes) break;
        }
        return { text: text + decoder.decode() };
    } catch (e) {
        return { unknown: true };
    } finally {
        try { if (reader) await reader.cancel(); else await res?.body?.cancel(); } catch (e) {}
    }
}

export function looksLikeMedia(bytes, encrypted) {
    if (!bytes || bytes.length < 188) return false;
    const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
    if (/^\s*(<|\{|#EXTM3U)/i.test(head)) return false;                       // HTML, JSON or a playlist, not video
    if (bytes[0] === 0x47 && (bytes.length < 189 || bytes[188] === 0x47)) return true; // MPEG-TS sync bytes
    const box = Buffer.from(bytes.subarray(4, 8)).toString('latin1');
    if (/^(ftyp|styp|moof|moov|sidx|mdat|free|emsg|prft)$/.test(box)) return true;   // ISO-BMFF / fMP4
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true; // Matroska/WebM
    if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return true;          // ADTS audio
    return !!encrypted;                                                        // AES-128 segments are opaque binary
}

async function probeMediaBytes(url, headers, encrypted) {
    let res, reader;
    try {
        res = await fetchWithFallback(url, { ...headers, Range: 'bytes=0-4095' }, 9000);
        if (res.status === 429) return { rateLimited: true };
        if ([400, 401, 403, 404, 410, 416, 422, 428].includes(res.status)) return { ok: false, reason: String(res.status) };
        if (!res.ok && res.status !== 206) return { unknown: true };
        if (/html|json|text\//i.test(res.headers.get('Content-Type') || '')) return { ok: false, reason: 'not-media' };
        reader = res.body?.getReader();
        if (!reader) return { unknown: true };
        const parts = [];
        let size = 0;
        while (size < 4096) {
            const chunk = await reader.read();
            if (chunk.done) break;
            parts.push(chunk.value);
            size += chunk.value.byteLength;
        }
        const bytes = Buffer.concat(parts.map(p => Buffer.from(p)));
        return looksLikeMedia(bytes, encrypted) ? { ok: true } : { ok: false, reason: 'not-media' };
    } catch (e) {
        return { unknown: true };
    } finally {
        try { if (reader) await reader.cancel(); else await res?.body?.cancel(); } catch (e) {}
    }
}

function withParentQuery(child, parentHref) {
    const url = new URL(child, parentHref);
    const parent = new URL(parentHref);
    // CloudFront signed-policy parameters cover the whole directory; segments inherit them when they carry none.
    if (!url.search && parent.search && url.hostname === parent.hostname) url.search = parent.search;
    return url.href;
}

export function isoDurationSeconds(value) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(value || '').trim());
    if (!m) return 0;
    return (Number(m[1] || 0) * 86400) + (Number(m[2] || 0) * 3600) + (Number(m[3] || 0) * 60) + Number(m[4] || 0);
}

export function dashPlan(xml, manifestHref) {
    const duration = isoDurationSeconds((/mediaPresentationDuration="([^"]+)"/.exec(xml) || [])[1]);
    const title = ((/<Title>([^<]*)<\/Title>/i.exec(xml) || [])[1] || '').trim();
    const encrypted = /<ContentProtection\b/i.test(xml);
    const videoSet = (/<AdaptationSet\b[^>]*(?:contentType="video"|mimeType="video\/)[\s\S]*?<\/AdaptationSet>/i.exec(xml) || [])[0] ||
        (/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/i.exec(xml) || [])[0] || xml;
    const baseRoot = (/<BaseURL>([^<]+)<\/BaseURL>/i.exec(xml.slice(0, xml.search(/<Period\b/i) >= 0 ? xml.search(/<Period\b/i) : 0)) || [])[1];
    const base = baseRoot ? withParentQuery(baseRoot.trim(), manifestHref) : manifestHref;
    const repMatch = /<Representation\b([^>]*)>([\s\S]*?)(?:<\/Representation>|$)/i.exec(videoSet);
    const repAttrs = repMatch ? repMatch[1] : '';
    const repBody = repMatch ? repMatch[2] : '';
    const repId = (/\bid="([^"]+)"/.exec(repAttrs) || [])[1] || '0';
    const bandwidth = (/\bbandwidth="(\d+)"/.exec(repAttrs) || [])[1] || '0';
    const repBase = (/<BaseURL>([^<]+)<\/BaseURL>/i.exec(repBody) || /<BaseURL>([^<]+)<\/BaseURL>/i.exec(videoSet) || [])[1];
    const template = /<SegmentTemplate\b([^>]*)\/?>([\s\S]*?(?:<\/SegmentTemplate>|$))?/i.exec(repBody) || /<SegmentTemplate\b([^>]*)\/?>([\s\S]*?(?:<\/SegmentTemplate>|$))?/i.exec(videoSet);
    const segments = [];
    const fill = (pattern, number, time) => pattern
        .replace(/\$RepresentationID\$/g, repId).replace(/\$Bandwidth\$/g, bandwidth)
        .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => pad ? String(number).padStart(Number(pad), '0') : String(number))
        .replace(/\$Time\$/g, String(time)).replace(/\$\$/g, '$');
    const segBase = repBase ? withParentQuery(repBase.trim(), base) : base;
    if (template) {
        const attrs = template[1];
        const init = (/initialization="([^"]+)"/.exec(attrs) || [])[1];
        const media = (/media="([^"]+)"/.exec(attrs) || [])[1];
        const startNumber = Number((/startNumber="(\d+)"/.exec(attrs) || [])[1] || 1);
        const firstTime = Number((/<S\b[^>]*\bt="(\d+)"/.exec(template[2] || '') || [])[1] || 0);
        if (init) segments.push(withParentQuery(fill(init, startNumber, firstTime), segBase));
        if (media) segments.push(withParentQuery(fill(media, startNumber, firstTime), segBase));
    } else if (repBase) {
        segments.push(segBase); // SegmentBase / single-file representation
    }
    return { duration, title, encrypted, segments };
}

async function hlsPlan(text, playlistHref, headers) {
    let body = text, href = playlistHref;
    if (/#EXT-X-STREAM-INF/i.test(body)) {
        const lines = body.split(/\r?\n/);
        const idx = lines.findIndex(line => /^#EXT-X-STREAM-INF/i.test(line));
        const variant = lines.slice(idx + 1).find(line => line.trim() && !line.startsWith('#'));
        if (!variant) return { segments: [] };
        href = withParentQuery(variant.trim(), playlistHref);
        const child = await fetchText(href, headers, 9000, 4 * 1024 * 1024);
        if (child.rateLimited) return { rateLimited: true };
        if (child.unknown) return { unknown: true };
        if (!child.text || !/^#EXTM3U/.test(child.text.trim())) return { segments: [] };
        body = child.text;
    }
    let duration = 0;
    for (const m of body.matchAll(/#EXTINF:([\d.]+)/g)) duration += Number(m[1]) || 0;
    const segments = [];
    const map = /#EXT-X-MAP:[^\n]*URI="([^"]+)"/i.exec(body);
    if (map) segments.push(withParentQuery(map[1], href));
    const first = body.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
    if (first) segments.push(withParentQuery(first.trim(), href));
    const encrypted = /#EXT-X-KEY:(?![^\n]*METHOD=NONE)/i.test(body);
    return { duration, title: '', encrypted, segments };
}

const normalizeWords = value => String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(word => word.length > 1 && !['the', 'a', 'an', 'of', 'and'].includes(word));

/* Wrong-title detection. The upstream matches by name, so a remake, a same-name film from another year, a trailer or a
   different episode can come back under a valid id. Duration is the strongest signal; the release name (DASH <Title>,
   e.g. "Fight.Club.1999.REMASTERED...") adds year and SxxEyy checks. Margins are generous so real cuts never fail. */
export function identityVerdict(found, expect) {
    const duration = Number(found.duration) || 0;
    const result = { ok: true, duration: Math.round(duration) };
    if (duration > 0 && duration < 8 * 60 && !(expect.runtimeMin > 0 && expect.runtimeMin < 12)) return { ok: false, reason: 'too-short', duration: result.duration };
    if (expect.runtimeMin > 0 && duration > 0) {
        const expected = expect.runtimeMin * 60, diff = Math.abs(duration - expected);
        const tolerance = expect.episode ? Math.max(20 * 60, expected * 0.6) : Math.max(30 * 60, expected * 0.3);
        if (diff > tolerance) return { ok: false, reason: 'runtime-mismatch', duration: result.duration };
    }
    const title = String(found.title || '');
    if (title) {
        const se = /\bS(\d{1,2})[ ._-]?E(\d{1,3})\b/i.exec(title);
        if (expect.episode && se && (Number(se[1]) !== expect.season || Number(se[2]) !== expect.episode)) {
            return { ok: false, reason: 'wrong-episode', duration: result.duration };
        }
        const yearMatch = /(?:^|[^0-9])(19\d{2}|20\d{2})(?:[^0-9]|$)/.exec(title.replace(/\bS\d{1,2}E\d{1,3}\b/ig, ''));
        if (!expect.episode && yearMatch && expect.year) {
            const words = new Set(normalizeWords(title));
            const wanted = (expect.titles || []).flatMap(normalizeWords);
            const overlap = wanted.some(word => words.has(word));
            if (Math.abs(Number(yearMatch[1]) - expect.year) > 1 && !overlap) return { ok: false, reason: 'wrong-title', duration: result.duration };
        }
    }
    return result;
}

export function discoveryFeed(counter) {
    const step = Math.max(0, counter - 1);
    const type = step % 3 === 2 ? 'tv' : 'movie';
    const rawOrdinal = type === 'tv' ? Math.floor(step / 3) : step - Math.floor(step / 3);
    const ordinal = rawOrdinal % 17000;
    // Tier 1 (0..1999): Global sort partitions (500 pages each = 40,000 candidates per type)
    if (ordinal < 2000) {
        const partition = Math.floor(ordinal / 500);
        const page = (ordinal % 500) + 1;
        const sorts = ['popularity.desc', 'vote_count.desc', type === 'tv' ? 'first_air_date.desc' : 'primary_release_date.desc', 'vote_average.desc'];
        const votes = partition === 0 ? (type === 'tv' ? 15 : 25) : partition === 1 ? (type === 'tv' ? 5 : 10) : partition === 2 ? 2 : 5;
        return { type, path: '/discover/' + type + '?sort_by=' + sorts[partition] + '&include_adult=false&without_genres=16,10767,10763&vote_count.gte=' + votes + '&page=' + page };
    }
    // Tier 2 (2000..7699): Deep year-by-year sweep (76 years x 75 pages = 114,000 candidates per type)
    if (ordinal < 7700) {
        const yearStep = ordinal - 2000;
        const page = (yearStep % 75) + 1;
        const yearOffset = Math.floor(yearStep / 75);
        const year = Math.max(1950, new Date().getFullYear() - yearOffset);
        return {
            type,
            path: '/discover/' + type + '?sort_by=popularity.desc&include_adult=false&without_genres=16,10767,10763&vote_count.gte=2&page=' + page +
                '&' + (type === 'tv' ? 'first_air_date_year' : 'primary_release_year') + '=' + year
        };
    }
    // Tier 3 (7700..12499): Genre-by-genre deep sweep (16 genres x 300 pages = 96,000 candidates per type)
    if (ordinal < 12500) {
        const genreStep = ordinal - 7700;
        const movieGenres = [28, 12, 35, 80, 18, 14, 36, 27, 9648, 10749, 878, 53, 10752, 37, 10751, 99];
        const tvGenres = [10759, 35, 80, 18, 9648, 10765, 10768, 37, 10751, 99, 10766, 10762, 10759, 18, 80, 10765];
        const genres = type === 'tv' ? tvGenres : movieGenres;
        const genreId = genres[Math.floor(genreStep / 300) % genres.length];
        const page = (genreStep % 300) + 1;
        return {
            type,
            path: '/discover/' + type + '?sort_by=popularity.desc&include_adult=false&without_genres=16,10767,10763&with_genres=' + genreId + '&vote_count.gte=2&page=' + page
        };
    }
    // Tier 4 (12500..16999): International cinema & series sweep (18 languages x 250 pages)
    const langStep = ordinal - 12500;
    const langs = ['en', 'ko', 'es', 'fr', 'ja', 'hi', 'de', 'it', 'pt', 'tr', 'zh', 'th', 'pl', 'sv', 'da', 'no', 'nl', 'tl'];
    const lang = langs[Math.floor(langStep / 250) % langs.length];
    const page = (langStep % 250) + 1;
    return {
        type,
        path: '/discover/' + type + '?sort_by=popularity.desc&include_adult=false&without_genres=16,10767,10763&with_original_language=' + lang + '&vote_count.gte=2&page=' + page
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
    const stats = { shard: SHARD_INDEX, checked: 0, verified: 0, failed: 0, rechecked: 0, evicted: 0, episodesVerified: 0, seasonsChecked: 0, seasonsDead: 0, rateLimited: 0, recheckBacklog: 0, recheckLeft: 0, overdueLeft: 0,
        movieTasks: 0, movieWorkMs: 0, tvTasks: 0, tvWorkMs: 0, reasons: {} };

    // 1. Collect stale titles assigned to this shard for rolling freshness re-verification. Titles that were never
    //    deep-verified (older scanner: manifest-only, season 1 only) go first, then the most overdue, so the backlog
    //    is provably drained instead of re-checking whatever happens to be at the head of the map.
    const now = Date.now();
    const recheckQueue = [];
    for (const [key, item] of knownItemsMap.entries()) {
        if (hashKey(key) % SHARD_TOTAL !== SHARD_INDEX) continue;
        const deep = item.verified_v >= VERIFY_VERSION;
        const lastAt = deep ? (knownRecords[key]?.at || item.availability_at || 0) : 0;
        const dueAt = lastAt + recheckAgeFor(item);
        if (now >= dueAt) {
            recheckQueue.push({ key, metadata: item, isRecheck: true, lastAt, dueAt });
        }
    }
    recheckQueue.sort((a, b) => a.dueAt - b.dueAt);
    stats.recheckBacklog = recheckQueue.length;
    // Overdue = never deep-verified or more than 6h past due. While any exist, every worker re-checks (discovery waits):
    // keeping listed titles honest always outranks adding new ones, so growth can never starve re-verification.
    const isOverdue = task => task.lastAt === 0 || now - task.dueAt > 6 * 3600000;

    // 2. Discover new candidates for this shard from TMDB feeds
    const discoveryQueue = [];
    const priorityFeeds = [
        { type: 'movie', path: '/trending/movie/day?page=' + (SHARD_INDEX + 1) },
        { type: 'tv', path: '/trending/tv/day?page=' + (SHARD_INDEX + 1) },
        { type: 'movie', path: '/movie/now_playing?page=' + (SHARD_INDEX + 1) },
        { type: 'tv', path: '/tv/on_the_air?page=' + (SHARD_INDEX + 1) }
    ];

    async function pullMoreCandidates() {
        const fromPriority = priorityFeeds.length > 0;
        const feed = fromPriority ? priorityFeeds.shift() : discoveryFeed(cursor);
        if (!fromPriority) cursor += SHARD_TOTAL;
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
    const timeLeft = () => SCAN_DURATION_MS - (Date.now() - startedAt);

    // One probe with patience: a 429 waits out the shared cooldown and retries the SAME key (it used to be dropped for the
    // whole run), a network hiccup retries once. Only a definitive answer is ever recorded.
    async function probe(key, expect) {
        for (let attempt = 0; attempt < 4 && timeLeft() > 15000; attempt++) {
            if (cooldownUntil > Date.now()) await sleep(Math.min(20000, cooldownUntil - Date.now()));
            const verdict = await verifyStreamKey(key, RESOLVER_KEY, expect);
            if (verdict.rateLimited) {
                stats.rateLimited++;
                cooldownUntil = Math.max(cooldownUntil, Date.now() + 8000 + attempt * 6000);
                continue;
            }
            if (typeof verdict.ok === 'boolean') {
                if (!verdict.ok && verdict.reason) stats.reasons[verdict.reason] = (stats.reasons[verdict.reason] || 0) + 1;
                return verdict;
            }
            await sleep(2000);
        }
        return {};
    }

    async function verifyMovie(task) {
        const details = await tmdbJson('/movie/' + task.key.split(':')[1]);
        const expect = {
            runtimeMin: Number(details?.runtime) || 0,
            year: Number(String(task.metadata.release_date || '').slice(0, 4)) || 0,
            titles: [task.metadata.title, details?.title, details?.original_title].filter(Boolean)
        };
        const verdict = await probe(task.key, expect);
        if (typeof verdict.ok !== 'boolean') return null;
        const at = Date.now();
        outputRecords[task.key] = { ok: verdict.ok, at, v: VERIFY_VERSION };
        if (!verdict.ok) return false;
        outputItems[task.key] = { ...task.metadata, availability_at: at, verified_v: VERIFY_VERSION, ...(verdict.duration ? { stream_duration: verdict.duration } : {}) };
        return true;
    }

    /* Every aired season is verified: its first episode and its latest aired episode must both deliver real video.
       Only seasons that pass are published (playable_seasons); the TV hides the rest. A series with no playable season
       is not listed at all. This is what catches "seasons 1-2 play, season 3 never does". */
    async function verifyShow(task) {
        const id = task.key.split(':')[1];
        const details = await tmdbJson('/tv/' + id);
        if (!details || !Array.isArray(details.seasons)) return null;
        const seasons = airedSeasons(details).slice(0, 40);
        if (!seasons.length) {
            outputRecords[task.key] = { ok: false, at: Date.now(), v: VERIFY_VERSION };
            return false;
        }
        const runtimeMin = Number((details.episode_run_time || [])[0]) || Number(details.last_episode_to_air?.runtime) || 0;
        const previous = Array.isArray(task.metadata.playable_seasons) ? new Set(task.metadata.playable_seasons) : null;
        const playable = [];
        let unknown = 0;
        for (const season of seasons) {
            if (timeLeft() < 20000) return null; // never publish a half-checked show; it is retried next run
            const episodes = season.last > 1 ? [1, season.last] : [1];
            let seasonOk = true, seasonUnknown = false;
            for (const episode of episodes) {
                const epKey = task.key + ':s' + season.number + ':e' + episode;
                const verdict = await probe(epKey, { episode, season: season.number, runtimeMin });
                if (typeof verdict.ok !== 'boolean') { seasonUnknown = true; break; }
                outputRecords[epKey] = { ok: verdict.ok, at: Date.now(), v: VERIFY_VERSION };
                if (verdict.ok) stats.episodesVerified++;
                else { seasonOk = false; break; }
                await sleep(CHECK_PACE_MS);
            }
            stats.seasonsChecked++;
            if (seasonUnknown) {
                unknown++;
                // Undecided this run: keep the season only if the previous deep scan had proven it.
                if (previous && previous.has(season.number)) playable.push(season.number);
                continue;
            }
            if (seasonOk) playable.push(season.number);
            else stats.seasonsDead++;
        }
        if (unknown === seasons.length) return null;
        const at = Date.now();
        const ok = playable.length > 0;
        outputRecords[task.key] = { ok, at, v: VERIFY_VERSION };
        if (!ok) return false;
        outputItems[task.key] = {
            ...task.metadata, availability_at: at, verified_v: VERIFY_VERSION,
            playable_seasons: playable, season_count: seasons.length
        };
        return true;
    }

    async function workerLoop(workerId) {
        while (timeLeft() > 15000) {
            if (cooldownUntil > Date.now()) {
                await sleep(Math.min(5000, cooldownUntil - Date.now()));
                continue;
            }
            // Overdue re-checks: all workers. On schedule: workers 0-1 re-check, worker 2 leads discovery.
            let task = null;
            const overdue = recheckQueue.length && isOverdue(recheckQueue[0]);
            if (recheckQueue.length && (overdue || workerId < 2 || discoveryQueue.length === 0)) {
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

            const taskStarted = Date.now();
            const isShow = task.key.startsWith('tv:');
            const result = isShow ? await verifyShow(task) : await verifyMovie(task);
            if (typeof result === 'boolean') {
                // Measured cost per title feeds plan.mjs, which sizes the next run's shard count from real numbers.
                if (isShow) { stats.tvTasks++; stats.tvWorkMs += Date.now() - taskStarted; }
                else { stats.movieTasks++; stats.movieWorkMs += Date.now() - taskStarted; }
            }
            if (typeof result === 'boolean') {
                stats.checked++;
                if (task.isRecheck) {
                    stats.rechecked++;
                    if (!result) stats.evicted++;
                }
                if (result) stats.verified++;
                else stats.failed++;
            }
            await sleep(CHECK_PACE_MS);
        }
    }

    await Promise.all(Array.from({ length: WORKER_CONCURRENCY }, (_, idx) => workerLoop(idx)));
    stats.recheckLeft = recheckQueue.length; // > 0 means re-verification is NOT keeping up; surfaced in scanner-state.json
    stats.overdueLeft = recheckQueue.filter(isOverdue).length;

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

if (IS_MAIN) {
    runShard().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
