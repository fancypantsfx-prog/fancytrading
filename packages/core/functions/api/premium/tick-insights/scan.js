import { getPremiumAccess, premiumResponse } from '../../../../premium/access.mjs';
import { analyzeTickInsights, TICK_INSIGHTS_FEATURE, TICK_SAMPLE_SIZE } from '../../../../premium/tick-insights.mjs';
import { finderCandidates, SCAN_CACHE_KEY, SCAN_MAX_AGE_MS } from '../../../../premium/strategy-finder.mjs';

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
        const snapshot = await env.STRATEGY_FINDER_CACHE?.get(SCAN_CACHE_KEY, 'json');
        if (!snapshot || Date.now() - snapshot.updatedAt > SCAN_MAX_AGE_MS)
            return premiumResponse({ error: 'Market data is warming up' }, 503);

        const recent = snapshot.markets.filter(market => Date.now() - market.collectedAt <= SCAN_MAX_AGE_MS);
        if (!recent.length) return premiumResponse({ error: 'Market data is warming up' }, 503);
        const markets = recent.filter(market => market.groups.includes(contract));
        const rows = [];
        for (const market of markets) {
            const report = analyzeTickInsights({
                ...market,
                currency: 'USD',
                family: 'digital',
                ticks,
                windowSize: TICK_SAMPLE_SIZE,
                candidates,
                historyOnly: true,
            });
            if (!report) continue;
            rows.push(...report.rows.map(row => ({ ...row, symbol: market.symbol, lastTick: report.lastTick })));
        }
        rows.sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
        return premiumResponse({ access, rows, ticks, updatedAt: snapshot.updatedAt, marketsScanned: markets.length });
    } catch {
        return premiumResponse({ error: 'Market data is unavailable' }, 503);
    }
};
