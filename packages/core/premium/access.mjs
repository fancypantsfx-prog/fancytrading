import { TICK_INSIGHTS_FEATURE } from './tick-insights.mjs';

const DERIV_ACCOUNTS_URL = 'https://api.derivws.com/trading/v1/options/accounts';

const verifiedAccountIds = async authorization => {
    if (!authorization || !/^Bearer \S+$/i.test(authorization)) return [];

    const response = await fetch(DERIV_ACCOUNTS_URL, {
        headers: { Authorization: authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
    });

    if ([401, 403, 404].includes(response.status)) return [];
    if (!response.ok) throw new Error('Unable to verify Deriv accounts');

    const { data } = await response.json();
    return data.map(account => account.account_id).filter(id => typeof id === 'string' && id.length > 0);
};

export const isPremiumFeatureKey = feature => typeof feature === 'string' && /^[a-z0-9-]{1,64}$/.test(feature);

export const premiumResponse = (body, status = 200) =>
    Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });

// Use this check in every server endpoint that serves a premium feature.
export const getPremiumAccess = async (request, env, feature) => {
    if (feature === TICK_INSIGHTS_FEATURE && (env.TICK_INSIGHTS_ACCESS ?? 'free') === 'free') {
        return { access: 'free' };
    }

    const db = env.PREMIUM_DB;
    const preview = await db
        .prepare(
            'SELECT ends_at FROM premium_previews WHERE feature = ? AND starts_at <= unixepoch() AND ends_at > unixepoch()'
        )
        .bind(feature)
        .first();
    if (preview) return { access: 'preview', expiresAt: preview.ends_at };

    const accountIds = await verifiedAccountIds(request.headers.get('Authorization'));
    if (accountIds.length === 0) return { access: 'locked' };

    const grant = await db
        .prepare(
            `SELECT expires_at FROM premium_grants
                  WHERE feature = ? AND expires_at > unixepoch()
                    AND account_id IN (SELECT value FROM json_each(?))
                  ORDER BY expires_at DESC LIMIT 1`
        )
        .bind(feature, JSON.stringify(accountIds))
        .first();
    return grant ? { access: 'paid', expiresAt: grant.expires_at } : { access: 'locked' };
};
