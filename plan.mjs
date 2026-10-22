/* Capacity planner: runs before every scan and sizes it from real measurements, so re-verification keeps up as the
   library grows without anyone touching the workflow.

   demand   = worker-seconds/day needed to re-prove every listed title on schedule
              (movies x measured cost per movie + series x measured cost per series, both learned from past runs)
   capacity = worker-seconds/day one shard delivers (runs/day x workers x scan seconds x efficiency)

   1. Shards scale between MIN_SHARDS and MAX_SHARDS (GitHub's free plan runs 20 jobs concurrently) so re-checks use at
      most ~70% of capacity and discovery keeps the rest.
   2. If even MAX_SHARDS cannot re-prove everything daily, popular titles stay on 24h and the long tail is stretched
      (never beyond 60h, inside the 3-day retention), instead of silently falling behind.
   3. The health verdict ('ok' | 'tight' | 'behind' | 'over-capacity') drives the watchdog issue in the workflow. */
import fs from 'node:fs';

// Both repos (this scanner and the verified feed) run on the same account's ~20 concurrent runner slots, so the split is a setting.
export const MIN_SHARDS = Math.max(1, Number(process.env.MIN_SHARDS) || 16);
export const MAX_SHARDS = Math.max(MIN_SHARDS, Number(process.env.MAX_SHARDS) || 20);
const HOUR = 3600000;
const DEFAULT_COST = { movie: 6, tv: 25 }; // seconds per title before anything has been measured
const TAIL_MAX_MS = 60 * HOUR;

export function planCapacity(state = {}, popularity = [], options = {}) {
    const scanSeconds = (options.scanMs || 1200000) / 1000;
    const workers = options.workers || 3;
    const runsPerDay = options.runsPerDay || 40;        // cron is every 30 min; GitHub delays some runs

    // Efficiency is MEASURED, not assumed: busy worker-seconds over available worker-seconds in the last run. The provider
    // throttles each runner IP (429s stretched resolver gaps to ~9.5s), so the old fixed 0.75 promised ~2x the capacity the
    // fleet really delivered and the plan said "ok" while the library drifted stale. Smoothed, and bounded so one odd run
    // cannot swing the fleet.
    const lastRun = state.lastRun || {};
    const available = (Number(lastRun.shardsMerged) || 0) * workers * scanSeconds;
    const busy = ((Number(lastRun.movieWorkMs) || 0) + (Number(lastRun.tvWorkMs) || 0)) / 1000;
    const measuredEfficiency = available > 0 && busy > 0 ? Math.min(0.75, busy / available) : null;
    const learnedEfficiency = Number(state.plan && state.plan.efficiency) || 0;
    const smoothedEfficiency = measuredEfficiency === null ? (learnedEfficiency || 0.5)
        : learnedEfficiency ? learnedEfficiency * 0.7 + measuredEfficiency * 0.3 : measuredEfficiency;
    const efficiency = options.efficiency || Math.max(0.2, Math.min(0.75, smoothedEfficiency));
    const fastAgeMs = options.fastAgeMs || 24 * HOUR;

    const last = state.lastRun || {};
    const learned = state.costs || {};
    const measured = (ms, tasks, fallback) => tasks >= 20 ? ms / tasks / 1000 : fallback;
    // Exponential smoothing so one noisy run does not swing the fleet size.
    const smooth = (prev, sample) => prev ? prev * 0.7 + sample * 0.3 : sample;
    const costs = {
        movie: smooth(learned.movie, measured(last.movieWorkMs || 0, last.movieTasks || 0, learned.movie || DEFAULT_COST.movie)),
        tv: smooth(learned.tv, measured(last.tvWorkMs || 0, last.tvTasks || 0, learned.tv || DEFAULT_COST.tv))
    };

    const movies = Number(state.movieCount) || 0, series = Number(state.tvCount) || 0;
    const perShardDay = runsPerDay * workers * scanSeconds * efficiency;
    const demandAt = ageMs => (movies * costs.movie + series * costs.tv) * (24 * HOUR / ageMs);
    const demand = demandAt(fastAgeMs);
    const wanted = Math.ceil(demand / (perShardDay * 0.7));
    const shards = Math.max(MIN_SHARDS, Math.min(MAX_SHARDS, wanted));
    const capacity = shards * perShardDay;

    let popularMin = 0, tailAgeMs = fastAgeMs;
    const budget = capacity * 0.85;
    if (demand > budget) {
        // Keep the most popular share on 24h; stretch the rest just enough to fit the budget.
        const sorted = popularity.slice().sort((a, b) => b - a);
        const titles = Math.max(1, sorted.length || movies + series);
        const avgCost = (movies * costs.movie + series * costs.tv) / Math.max(1, movies + series);
        for (const share of [0.5, 0.35, 0.2, 0.1]) {
            const head = Math.floor(titles * share);
            const headDemand = head * avgCost;
            const tailBudget = budget - headDemand;
            if (tailBudget <= 0) continue;
            const ageMs = ((titles - head) * avgCost * 24 * HOUR) / tailBudget;
            if (ageMs <= TAIL_MAX_MS) {
                tailAgeMs = Math.max(fastAgeMs, Math.ceil(ageMs / HOUR) * HOUR);
                popularMin = sorted.length ? sorted[Math.max(0, head - 1)] : 0;
                break;
            }
            tailAgeMs = TAIL_MAX_MS;
            popularMin = sorted.length ? sorted[Math.max(0, head - 1)] : 0;
        }
    }

    const history = (Array.isArray(state.history) ? state.history : []).slice(-11);
    const behindRuns = (() => { let n = 0; for (let i = history.length - 1; i >= 0 && history[i].overdueLeft > 0; i--) n++; return n; })();
    const utilization = demand / capacity;
    const health = demandAt(TAIL_MAX_MS) > budget ? 'over-capacity'
        : behindRuns >= 4 ? 'behind'
        : utilization > 0.7 ? 'tight' : 'ok';

    return {
        shards, matrix: Array.from({ length: shards }, (_, i) => i),
        recheckAgeMs: fastAgeMs, recheckAgeTailMs: tailAgeMs, popularMin,
        costs: { movie: Number(costs.movie.toFixed(2)), tv: Number(costs.tv.toFixed(2)) },
        efficiency: Number(efficiency.toFixed(3)),
        demandHours: Math.round(demand / 3600), capacityHours: Math.round(capacity / 3600),
        utilization: Number(utilization.toFixed(2)), behindRuns, health
    };
}

async function fetchJson(url) {
    try { const res = await fetch(url, { signal: AbortSignal.timeout(60000) }); return res.ok ? await res.json() : null; } catch (e) { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const state = (await fetchJson(process.env.STATE_URL)) || {};
    const catalogue = await fetchJson(process.env.EXISTING_CATALOGUE_URL);
    const popularity = (catalogue && Array.isArray(catalogue.items) ? catalogue.items : []).map(item => Number(item.popularity) || 0);
    if (catalogue) { state.movieCount = catalogue.movieCount ?? state.movieCount; state.tvCount = catalogue.tvCount ?? state.tvCount; }
    const plan = planCapacity(state, popularity, { scanMs: Number(process.env.SCAN_DURATION_MS) || 1200000, fastAgeMs: Number(process.env.FAST_AGE_MS) || undefined });
    console.log('Capacity plan:', JSON.stringify(plan));
    fs.writeFileSync('plan.json', JSON.stringify(plan));
    const out = process.env.GITHUB_OUTPUT;
    if (out) {
        fs.appendFileSync(out, [
            'matrix=' + JSON.stringify(plan.matrix),
            'shards=' + plan.shards,
            'recheck_age_ms=' + plan.recheckAgeMs,
            'recheck_age_tail_ms=' + plan.recheckAgeTailMs,
            'popular_min=' + plan.popularMin,
            'health=' + plan.health
        ].join('\n') + '\n');
    }
}
