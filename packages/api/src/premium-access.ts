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
