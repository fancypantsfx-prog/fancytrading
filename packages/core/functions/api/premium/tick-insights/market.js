import { getPremiumAccess, premiumResponse } from '../../../../premium/access.mjs';
import { TICK_INSIGHTS_FEATURE } from '../../../../premium/tick-insights.mjs';

export const onRequestPost = async ({ request, env }) => {
    if (!env.FANCY_TRADING_BACKEND) return premiumResponse({ error: { code: 'BackendDisabled' } }, 503);
    try {
        const access = await getPremiumAccess(request, env, TICK_INSIGHTS_FEATURE);
        if (access.access === 'locked') return premiumResponse({ error: { code: 'AccessDenied' } }, 403);
        const body = await request.text();
        if (body.length > 2048) return premiumResponse({ error: { code: 'RequestTooLarge' } }, 413);
        const response = await env.FANCY_TRADING_BACKEND.fetch('https://fancytrading.internal/market', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
        });
        return premiumResponse(await response.json(), response.status);
    } catch {
        return premiumResponse({ error: { code: 'MarketDataUnavailable' } }, 503);
    }
};
