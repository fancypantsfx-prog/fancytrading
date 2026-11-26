import { getPremiumAccess, premiumResponse } from '../../../../premium/access.mjs';
import { TICK_INSIGHTS_FEATURE } from '../../../../premium/tick-insights.mjs';

const enabled = env => Boolean(env.FANCY_TRADING_BACKEND && env.FANCY_TRADING_ORDERS === 'enabled');

export const onRequestGet = ({ env }) => premiumResponse({ enabled: enabled(env) });

export const onRequestPost = async ({ request, env }) => {
    if (!enabled(env)) return premiumResponse({ error: { code: 'BackendDisabled' } }, 503);
    const authorization = request.headers.get('Authorization');
    if (!/^Bearer \S{1,4096}$/i.test(authorization ?? ''))
        return premiumResponse({ error: { code: 'AccessDenied' } }, 403);
    try {
        const access = await getPremiumAccess(request, env, TICK_INSIGHTS_FEATURE);
        if (access.access === 'locked') return premiumResponse({ error: { code: 'AccessDenied' } }, 403);
        const body = await request.text();
        if (body.length > 2048) return premiumResponse({ error: { code: 'RequestTooLarge' } }, 413);
        const response = await env.FANCY_TRADING_BACKEND.fetch('https://fancytrading.internal/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: authorization },
            body,
        });
        return premiumResponse(await response.json(), response.status);
    } catch {
        return premiumResponse({ error: { code: 'AccountGatewayUnavailable' } }, 503);
    }
};
