import { getPremiumAccess, premiumResponse } from '../../../../premium/access.mjs';
import { analyzeTickInsights, TICK_INSIGHTS_FEATURE } from '../../../../premium/tick-insights.mjs';

const readInput = async request => {
    const reader = request.body?.getReader();
    if (!reader) return null;

    const bytes = new Uint8Array(32768);
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > bytes.length) {
            await reader.cancel();
            return null;
        }
        bytes.set(value, size);
        size += value.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
};

export const onRequestPost = async ({ request, env }) => {
    let input;
    try {
        input = await readInput(request);
    } catch {
        return premiumResponse({ error: 'Invalid tick sample' }, 400);
    }
    if (!input) return premiumResponse({ error: 'Invalid tick sample' }, 400);

    let access;
    try {
        access = await getPremiumAccess(request, env, TICK_INSIGHTS_FEATURE);
    } catch {
        return premiumResponse({ error: 'Premium access is unavailable' }, 503);
    }
    if (access.access === 'locked') return premiumResponse({ error: 'Premium access is required' }, 403);

    const result = analyzeTickInsights(input);
    return result ? premiumResponse({ ...result, access }) : premiumResponse({ error: 'Invalid tick sample' }, 400);
};
