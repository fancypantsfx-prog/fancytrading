import { getPremiumAccess, isPremiumFeatureKey, premiumResponse } from '../../../premium/access.mjs';

export const onRequestGet = async ({ request, env, params }) => {
    if (!isPremiumFeatureKey(params.feature)) return premiumResponse({ error: 'Invalid feature key' }, 400);

    try {
        return premiumResponse(await getPremiumAccess(request, env, params.feature));
    } catch {
        return premiumResponse({ error: 'Premium access is unavailable' }, 503);
    }
};
