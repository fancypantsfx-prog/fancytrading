import { getStoredToken } from './useRestAPI';

export type TPremiumAccess = { access: 'free' | 'locked' } | { access: 'paid' | 'preview'; expiresAt: number };

const requestPremium = (path: string, signal: AbortSignal, input?: object) => {
    const token = getStoredToken();
    return fetch(`/api/premium/${path}`, {
        method: input ? 'POST' : 'GET',
        headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
            ...(input && { 'Content-Type': 'application/json' }),
        },
        body: input && JSON.stringify(input),
        cache: 'no-store',
        redirect: 'error',
        signal,
    });
};

export const fetchPremiumAccess = async (feature: string, signal: AbortSignal): Promise<TPremiumAccess> => {
    const response = await requestPremium(encodeURIComponent(feature), signal);
    if (!response.ok) throw new Error('Unable to check premium access');
    return response.json();
};

export const fetchTickInsights = async <T>(input: object, signal: AbortSignal): Promise<T | null> => {
    const response = await requestPremium('tick-insights/analysis', signal, input);
    if (response.status === 403) return null;
    if (!response.ok) throw new Error('Unable to analyze ticks');
    return response.json();
};

export const fetchStrategyFinder = async <T>(settings: URLSearchParams, signal: AbortSignal): Promise<T | null> => {
    const response = await requestPremium(`tick-insights/scan?${settings}`, signal);
    if (response.status === 403) return null;
    if (!response.ok) throw new Error('Cached market data is unavailable');
    return response.json();
};

let sharedMarketUnavailable = false;

export const fetchSharedMarketData = async <T>(signal: AbortSignal, input: object): Promise<T | undefined> => {
    if (sharedMarketUnavailable) return undefined;
    const response = await requestPremium('tick-insights/market', signal, input);
    if (response.status === 404) {
        sharedMarketUnavailable = true;
        return undefined;
    }
    const data = (await response.json()) as T & { error?: { code?: string } };
    if (response.status === 503 && data.error?.code === 'BackendDisabled') {
        sharedMarketUnavailable = true;
        return undefined;
    }
    return data;
};

let accountGatewayEnabled: boolean | undefined;

export const hasFancyAccountGateway = async (signal: AbortSignal): Promise<boolean> => {
    if (accountGatewayEnabled !== undefined) return accountGatewayEnabled;
    const response = await requestPremium('tick-insights/account', signal);
    if (response.status === 404) return (accountGatewayEnabled = false);
    if (!response.ok) throw new Error('Unable to check the FancyTrading backend.');
    const data = await response.json();
    accountGatewayEnabled = data.enabled === true;
    return accountGatewayEnabled;
};

export const fetchFancyAccount = async <T>(input: object, signal: AbortSignal): Promise<T> => {
    const response = await requestPremium('tick-insights/account', signal, input);
    return response.json();
};
