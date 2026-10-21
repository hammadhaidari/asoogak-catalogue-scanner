import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMedia, isoDurationSeconds, dashPlan, identityVerdict, airedSeasons, VERIFY_VERSION } from './scan-shard.mjs';
import { mergeCatalogueSources } from './merge-catalogue.mjs';

const box = type => { const b = Buffer.alloc(4096); b.write(type, 4, 'latin1'); return b; };

test('media sniffing accepts real video and rejects error pages', () => {
    assert.equal(looksLikeMedia(box('ftyp')), true);
    assert.equal(looksLikeMedia(box('styp')), true);
    const ts = Buffer.alloc(400); ts[0] = 0x47; ts[188] = 0x47;
    assert.equal(looksLikeMedia(ts), true);
    assert.equal(looksLikeMedia(Buffer.from('<html><body>403 Forbidden</body></html>'.padEnd(400))), false);
    assert.equal(looksLikeMedia(Buffer.from('{"error":"expired"}'.padEnd(400))), false);
    assert.equal(looksLikeMedia(Buffer.alloc(50)), false);
    assert.equal(looksLikeMedia(Buffer.alloc(400, 7), true), true); // AES-encrypted HLS segment
});

test('ISO-8601 durations', () => {
    assert.equal(isoDurationSeconds('PT2H19M8.3S'), 8348.3);
    assert.equal(isoDurationSeconds('PT47M'), 2820);
    assert.equal(isoDurationSeconds('bogus'), 0);
});

test('DASH plan finds init + first media segment with inherited CloudFront policy', () => {
    const xml = `<?xml version="1.0"?><MPD mediaPresentationDuration="PT2H19M8.3S"><ProgramInformation><Title>Fight.Club.1999.REMASTERED.1080p</Title></ProgramInformation>
      <Period id="0"><AdaptationSet id="0" contentType="video"><Representation id="0" mimeType="video/mp4" bandwidth="350000">
      <SegmentTemplate timescale="24000" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1">
      <SegmentTimeline><S t="0" d="140140" /></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
    const plan = dashPlan(xml, 'https://sacdn.example.com/dash/abc/index_web.mpd?Policy=p&Signature=s&Key-Pair-Id=k');
    assert.equal(Math.round(plan.duration), 8348);
    assert.equal(plan.title, 'Fight.Club.1999.REMASTERED.1080p');
    assert.deepEqual(plan.segments, [
        'https://sacdn.example.com/dash/abc/init-stream0.m4s?Policy=p&Signature=s&Key-Pair-Id=k',
        'https://sacdn.example.com/dash/abc/chunk-stream0-00001.m4s?Policy=p&Signature=s&Key-Pair-Id=k'
    ]);
});

test('identity: right film passes; wrong runtime, wrong film, trailers and wrong episodes fail', () => {
    assert.equal(identityVerdict({ duration: 8348, title: 'Fight.Club.1999.REMASTERED' }, { runtimeMin: 139, year: 1999, titles: ['Fight Club'] }).ok, true);
    assert.equal(identityVerdict({ duration: 150 * 60 }, { runtimeMin: 120 }).ok, true);                       // director's cut
    assert.equal(identityVerdict({ duration: 95 * 60 }, { runtimeMin: 139 }).reason, 'runtime-mismatch');
    assert.equal(identityVerdict({ duration: 150 }, { runtimeMin: 110 }).reason, 'too-short');
    assert.equal(identityVerdict({ duration: 6000, title: 'Other.Movie.2011.1080p' }, { year: 1999, titles: ['Fight Club'] }).reason, 'wrong-title');
    assert.equal(identityVerdict({ duration: 6000, title: 'Fight.Club.2004.Rerelease' }, { year: 1999, titles: ['Fight Club'] }).ok, true); // same name keeps
    assert.equal(identityVerdict({ duration: 2800, title: 'Show.S03E05.720p' }, { season: 3, episode: 1, runtimeMin: 47 }).reason, 'wrong-episode');
    assert.equal(identityVerdict({ duration: 2800, title: 'Show.S03E01.720p' }, { season: 3, episode: 1, runtimeMin: 47 }).ok, true);
    assert.equal(identityVerdict({ duration: 0 }, { runtimeMin: 100 }).ok, true);                               // no data -> no false fail
    assert.equal(identityVerdict({ duration: 6 * 60 }, { runtimeMin: 7, episode: 1, season: 1 }).ok, true);    // genuinely short episodes
});

test('aired seasons: specials and unaired seasons skipped, airing season proves its latest aired episode', () => {
    const details = {
        last_episode_to_air: { season_number: 3, episode_number: 4 },
        seasons: [
            { season_number: 0, episode_count: 5, air_date: '2010-01-01' },
            { season_number: 1, episode_count: 10, air_date: '2020-01-01' },
            { season_number: 2, episode_count: 8, air_date: '2021-01-01' },
            { season_number: 3, episode_count: 10, air_date: '2026-09-01' },
            { season_number: 4, episode_count: 10, air_date: '2027-09-01' }
        ]
    };
    assert.deepEqual(airedSeasons(details, '2026-10-20'), [{ number: 1, last: 10 }, { number: 2, last: 8 }, { number: 3, last: 4 }]);
});

test('merge: deep failure beats newer shallow ok; deep series without proven seasons is not listed', () => {
    const now = Date.now(), H = 3600000;
    const shallow = {
        records: { 'movie:1': { ok: true, at: now - 1 * H }, 'tv:2': { ok: true, at: now - 1 * H }, 'movie:3': { ok: true, at: now - 1 * H } },
        items: [{ id: 1, media_type: 'movie', title: 'A' }, { id: 2, media_type: 'tv', name: 'B' }, { id: 3, media_type: 'movie', title: 'C' }]
    };
    const deep = {
        records: { 'movie:1': { ok: false, at: now - 5 * H, v: VERIFY_VERSION }, 'tv:2': { ok: true, at: now - 2 * H, v: VERIFY_VERSION } },
        items: [{ id: 2, media_type: 'tv', name: 'B', verified_v: VERIFY_VERSION, playable_seasons: [1, 2], availability_at: now - 2 * H }]
    };
    const merged = mergeCatalogueSources([shallow, deep], now);
    const keys = merged.items.map(i => i.media_type + ':' + i.id).sort();
    assert.deepEqual(keys, ['movie:3', 'tv:2']);
    assert.deepEqual(merged.items.find(i => i.id === 2).playable_seasons, [1, 2]);
    assert.equal(merged.deepVerified, 1);

    const noSeasons = mergeCatalogueSources([{ records: { 'tv:9': { ok: true, at: now, v: 2 } }, items: [{ id: 9, media_type: 'tv', name: 'X', verified_v: 2, playable_seasons: [] }] }], now);
    assert.equal(noSeasons.items.length, 0);
    const stale = mergeCatalogueSources([{ records: { 'movie:5': { ok: true, at: now - 4 * 24 * H } }, items: [{ id: 5, media_type: 'movie', title: 'Old' }] }], now);
    assert.equal(stale.items.length, 0, 'titles not re-proven within 3 days leave the catalogue');
});
