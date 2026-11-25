import { getPremiumAccess, premiumResponse } from '../../../../premium/access.mjs';
import { analyzeTickInsights, TICK_INSIGHTS_FEATURE, TICK_SAMPLE_SIZE } from '../../../../premium/tick-insights.mjs';
import {
    CONTRACT_LIST_MAX_AGE_MS,
    finderCandidates,
    finderHistorical,
    finderRankingKey,
    finderSupportsDuration,
    SCAN_CACHE_KEY,
} from '../../../../premium/strategy-finder.mjs';

export const onRequestGet = async ({ request, env }) => {
    const params = new URL(request.url).searchParams;
    const ticks = Number(params.get('ticks'));
    const barrier = params.has('barrier') ? Number(params.get('barrier')) : NaN;
    const contract = params.get('contract');
    const candidates = finderCandidates(contract, barrier);
    if (!candidates.length || !Number.isInteger(ticks) || ticks < 1 || ticks > 20)
        return premiumResponse({ error: 'Invalid scan settings' }, 400);

    try {
        const access = await getPremiumAccess(request, env, TICK_INSIGHTS_FEATURE);
        if (access.access === 'locked') return premiumResponse({ error: 'Premium access is required' }, 403);
        const snapshot = await env.STRATEGY_FINDER_CACHE?.get(SCAN_CACHE_KEY, { type: 'json', cacheTtl: 30 });

        const markets = (snapshot?.markets ?? []).filter(market => market.groups.includes(contract));
        const precisionBySymbol = Object.fromEntries(
            markets.filter(market => Number.isInteger(market.precision)).map(market => [market.symbol, market.precision])
        );
        const prepared = snapshot?.rankings?.[finderRankingKey(contract, ticks, barrier)];
        if (prepared) {
            return premiumResponse({
                access, rows: prepared, ticks, updatedAt: snapshot.updatedAt, marketsScanned: markets.length,
                instrumentsTotal: snapshot.instrumentsByGroup?.[contract] ?? markets.length,
                precisionBySymbol,
            });
        }
        const now = Date.now();
        const rows = [];
        for (const market of markets) {
            const listing = snapshot.contractLists?.[market.symbol];
            const availableCandidates = listing?.checkedAt + CONTRACT_LIST_MAX_AGE_MS > now
                ? candidates.filter(candidate => finderSupportsDuration(listing.contracts, candidate, ticks))
                : candidates;
            if (!availableCandidates.length) continue;
            const lastTick = Number(market.lastTick ?? market.times?.at(-1));
            const sampleAt = lastTick > 0 ? lastTick * 1000 : market.collectedAt;
            const summary = market.summaries?.[ticks - 1];
            if (summary) {
                for (const candidate of availableCandidates) {
                    const historical = finderHistorical(summary, candidate);
                    if (!historical) continue;
                    rows.push({
                        candidate,
                        historical,
                        symbol: market.symbol,
                        label: market.label,
                        sampleAt,
                    });
                }
                continue;
            }
            // Read older snapshots while the deployed Worker replaces them.

            const report = analyzeTickInsights({
                ...market,
                currency: 'USD',
                family: 'digital',
                ticks,
                windowSize: TICK_SAMPLE_SIZE,
                candidates: availableCandidates,
                historyOnly: true,
            });
            if (!report) continue;
            rows.push(
                ...report.rows.map(row => ({
                    ...row,
                    symbol: market.symbol,
                    label: market.label,
                    sampleAt,
                }))
            );
        }
        rows.sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
        return premiumResponse({
            access,
            rows,
            ticks,
            updatedAt: snapshot?.updatedAt ?? 0,
            marketsScanned: new Set(rows.map(row => row.symbol)).size,
            instrumentsTotal: snapshot?.instrumentsByGroup?.[contract] ?? markets.length,
            precisionBySymbol,
        });
    } catch {
        return premiumResponse({ error: 'Market data is unavailable' }, 503);
    }
};
