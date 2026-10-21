/* Catch-up watchdog. Reads the freshly published scanner-state.json and keeps exactly one GitHub issue in sync:
   - opens/updates "Scanner falling behind" when overdue re-checks persist for 4+ runs, the plan says over-capacity,
     or the catalogue suddenly shrinks by more than 15% between runs (scanner/provider outage, not real removals);
   - closes it automatically once everything is back on schedule.
   GitHub notifies the repo owner by email/app on issue creation, so nobody has to watch the Actions tab. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const TITLE = 'Scanner falling behind (auto-managed)';

export function assess(state) {
    const history = Array.isArray(state.history) ? state.history : [];
    const plan = state.plan || {};
    let behindRuns = 0;
    for (let i = history.length - 1; i >= 0 && history[i].overdueLeft > 0; i--) behindRuns++;
    const lastTwo = history.slice(-2);
    const shrink = lastTwo.length === 2 && lastTwo[0].total > 1000 ? 1 - lastTwo[1].total / lastTwo[0].total : 0;
    const problems = [];
    if (behindRuns >= 4) problems.push(`Overdue re-checks for ${behindRuns} consecutive runs (latest: ${history.at(-1).overdueLeft} titles still overdue).`);
    if (plan.health === 'over-capacity') problems.push(`Demand ${plan.demandHours} worker-hours/day exceeds capacity ${plan.capacityHours} even at ${plan.shards} shards with a 60h tail.`);
    if (shrink > 0.15) problems.push(`Catalogue shrank ${(shrink * 100).toFixed(0)}% in one run (${lastTwo[0].total} → ${lastTwo[1].total}); likely a provider/scanner outage.`);
    return { problems, behindRuns, plan };
}

function gh(args) {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        const state = JSON.parse(fs.readFileSync(process.argv[2] || 'dist/scanner-state.json', 'utf8'));
        const { problems, plan } = assess(state);
        const existing = gh(['issue', 'list', '--state', 'open', '--search', `"${TITLE}" in:title`, '--json', 'number', '--jq', '.[0].number']);
        const summary = [
            `Catalogue: ${state.totalPlayable} titles (${state.movieCount} movies, ${state.tvCount} series), ${state.deepVerified ?? 0} deep-verified.`,
            `Plan: ${plan.shards} shards, utilization ${plan.utilization}, health \`${plan.health}\`, tail re-check ${Math.round((plan.recheckAgeTailMs || 0) / 3600000)}h.`,
            `Last run: re-checked ${state.lastRun?.rechecked}, evicted ${state.lastRun?.evicted}, overdue left ${state.lastRun?.overdueLeft}.`
        ].join('\n');
        if (problems.length) {
            const body = '### Problems\n- ' + problems.join('\n- ') + '\n\n### Status\n' + summary +
                '\n\nOptions if this persists: add more `PROXY_URL` egress, raise `MAX_SHARDS` (paid plan), or run a second scanner repo on another account.';
            if (existing) gh(['issue', 'comment', existing, '--body', body]);
            else gh(['issue', 'create', '--title', TITLE, '--body', body]);
            console.log('Watchdog: problems reported.\n' + problems.join('\n'));
        } else if (existing) {
            gh(['issue', 'close', existing, '--comment', 'Caught up again.\n\n' + summary]);
            console.log('Watchdog: healthy, issue closed.');
        } else {
            console.log('Watchdog: healthy.\n' + summary);
        }
    } catch (error) {
        console.log('Watchdog skipped: ' + error.message); // never fail the publish because of the watchdog
    }
}
