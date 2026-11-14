import { fetchTickInsights } from '@deriv/api';
import type { TPremiumAccess } from '@deriv/api';

type TSample = { hits: number; count: number };
export type TFamily = 'accumulator' | 'digital';
export type TTickInsights = {
    access: TPremiumAccess;
    currency: string;
    ticks: number;
    firstTick: number;
    lastTick: number;
    marketsScanned?: number;
    rows: {
        candidate: string;
        symbol?: string;
        stake: number;
        payout: number;
        estimated: boolean;
        breakEven?: number;
        historical: TSample;
        older: TSample;
        recent: TSample;
        outcomes?: boolean[];
        maxWins?: number;
        maxLosses?: number;
        estimatedNet?: number;
        returnOnStake?: number | null;
    }[];
};

export type TInsightTrade = {
    candidate: string;
    family: TFamily;
    ticks: number;
    symbol: string;
    currency: string;
    stake: number;
    payout: number;
    contractTakeProfit?: number;
};

export type TInsightRun = TInsightTrade & {
    stopLoss: number;
    takeProfit?: number;
    strategyId: string;
    multiplier?: string;
    maxStake?: string;
};

export type TInsightStrategyOption = {
    id: string;
    label: string;
    description?: string;
    requiresTakeProfit: boolean;
    multiplier?: { defaultValue: string };
    maxStake: boolean;
};

export type TInsightPreset = { stake: number; ticks: number; stopLoss: number; takeProfit?: number };

export const getInsightPreset = (key?: string): TInsightPreset | undefined => {
    if (!key) return undefined;
    try {
        const preset = JSON.parse(localStorage.getItem(key) ?? 'null') as TInsightPreset | null;
        if (!preset || !isInsightPresetValid(preset)) return undefined;
        return preset;
    } catch {
        return undefined;
    }
};

export const isInsightPresetValid = ({ stake, ticks, stopLoss, takeProfit }: TInsightPreset) =>
    Number.isFinite(stake) &&
    stake >= 0.01 &&
    stake <= 1000000 &&
    Number.isInteger(ticks) &&
    ticks >= 1 &&
    ticks <= 20 &&
    Number.isFinite(stopLoss) &&
    stopLoss >= stake &&
    (takeProfit === undefined || (Number.isFinite(takeProfit) && takeProfit > 0));

export const waitForInsightRequest = async <T>(request: Promise<T>, timeoutMessage: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            request,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(timeoutMessage)), 15000);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

const DIGITAL_CONTRACTS = ['CALL', 'PUT', 'DIGITEVEN', 'DIGITODD'];
const ACCUMULATOR_RATES = ['1', '2', '3', '4', '5'];
const DIGIT_BARRIER = /^(DIGITOVER:[0-8]|DIGITUNDER:[1-9]|DIGIT(?:MATCH|DIFF):[0-9])$/;

export const getInsightContract = (family: TFamily, candidate: string, ticks: number) => {
    if (family === 'accumulator' && ACCUMULATOR_RATES.includes(candidate)) {
        return { contract_type: 'ACCU', growth_rate: Number(candidate) / 100 };
    }
    if (family === 'digital' && DIGITAL_CONTRACTS.includes(candidate)) {
        return { contract_type: candidate, duration: ticks, duration_unit: 't' };
    }
    if (family === 'digital' && DIGIT_BARRIER.test(candidate)) {
        const [contract_type, barrier] = candidate.split(':');
        return { contract_type, barrier, duration: ticks, duration_unit: 't' };
    }
    throw new Error('Choose a supported contract from the comparison.');
};

type TMarketData = {
    active_symbols?: { underlying_symbol: string; name?: string; display_name?: string }[];
    history?: { prices: (number | string)[]; times: number[] };
    pip_size?: number;
    tick?: { pip_size?: number };
    proposal?: {
        ask_price?: number | string;
        payout?: number | string;
        spot?: number | string;
        contract_details?: {
            high_barrier?: number | string;
            low_barrier?: number | string;
            maximum_ticks?: number;
            maximum_payout?: number;
            tick_size_barrier_percentage?: string;
        };
    };
    error?: unknown;
};

export const isInsightRateLimit = (response: unknown): boolean => {
    const failure = response as { code?: string; error?: { code?: string } } | null;
    return (failure?.error?.code ?? failure?.code) === 'RateLimit';
};

export class InsightRateLimitError extends Error {}

const REQUEST_SPACING_MS = 400;
const RATE_LIMIT_COOLDOWN_MS = 60000;
let nextRequestAt = 0;
let cooldownUntil = 0;
let requestQueue = Promise.resolve();

export const noteInsightRateLimit = () => {
    cooldownUntil = performance.now() + RATE_LIMIT_COOLDOWN_MS;
};

export const waitForInsightRequestSlot = (signal: AbortSignal) => {
    const turn = requestQueue.then(async () => {
        if (signal.aborted) throw new DOMException('Comparison cancelled', 'AbortError');
        if (performance.now() < cooldownUntil) throw new InsightRateLimitError();
        const delay = nextRequestAt - performance.now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (signal.aborted) throw new DOMException('Comparison cancelled', 'AbortError');
        if (performance.now() < cooldownUntil) throw new InsightRateLimitError();
        nextRequestAt = performance.now() + REQUEST_SPACING_MS;
    });
    requestQueue = turn.catch(() => undefined);
    return turn;
};

const sendInsightRequest = async (
    send: (payload: Record<string, unknown>) => Promise<TMarketData>,
    payload: Record<string, unknown>,
    signal: AbortSignal
) => {
    await waitForInsightRequestSlot(signal);
    try {
        const response = await send({ ...payload, passthrough: { fancytrading_insights: true } });
        if (!isInsightRateLimit(response)) return response;
    } catch (error) {
        if (!isInsightRateLimit(error)) throw error;
    }
    noteInsightRateLimit();
    throw new InsightRateLimitError();
};

export const getLiveInsightQuote = async (
    send: (payload: Record<string, unknown>) => Promise<TMarketData>,
    { symbol, currency, stake, ticks, candidate }: {
        symbol: string; currency: string; stake: number; ticks: number; candidate: string;
    },
    signal: AbortSignal
) => {
    const response = await waitForInsightRequest(
        sendInsightRequest(send, {
            proposal: 1,
            amount: stake,
            basis: 'stake',
            currency,
            underlying_symbol: symbol,
            ...getInsightContract('digital', candidate, ticks),
        }, signal),
        'Trade quote timed out'
    );
    if (signal.aborted || response.error || !response.proposal) return null;
    const ask = Number(response.proposal.ask_price);
    const payout = Number(response.proposal.payout);
    return ask > 0 && Number.isFinite(payout) && payout > ask ? { stake: ask, payout } : null;
};

export const getInsightMarkets = async (
    send: (payload: Record<string, unknown>) => Promise<TMarketData>,
    signal: AbortSignal
) => {
    const response = await sendInsightRequest(send, { active_symbols: 'brief' }, signal);
    if (response.error) throw new Error('Could not load instruments');
    return (response.active_symbols ?? []).map(item => ({
        symbol: item.underlying_symbol,
        label: item.name || item.display_name || item.underlying_symbol,
    }));
};

export const compareRecentTicks = async (
    send: (request: Record<string, unknown>) => Promise<TMarketData>,
    options: {
        symbol: string;
        currency: string;
        stake: number;
        ticks: number;
        family: TFamily;
        windowSize?: number;
        candidate?: string;
        candidates?: string[];
    },
    signal: AbortSignal,
    marketRequests = new Map<string, Promise<TMarketData>>()
) => {
    const { symbol, currency, stake, ticks, family, windowSize, candidate, candidates: selectedCandidates } = options;
    const count = windowSize ?? 400;
    const candidates = candidate
        ? [candidate]
        : (selectedCandidates ?? (family === 'accumulator' ? ACCUMULATOR_RATES : DIGITAL_CONTRACTS));
    const marketRequest = (key: string, payload: Record<string, unknown>) => {
        const existing = marketRequests.get(key);
        if (existing) return existing;
        const request = sendInsightRequest(send, payload, signal);
        marketRequests.set(key, request);
        return request;
    };

    const history = await marketRequest(`history:${symbol}`, {
        ticks_history: symbol,
        end: 'latest',
        count,
        style: 'ticks',
    });
    if (signal.aborted) return null;
    if (history?.error || history?.history?.prices?.length !== count || history?.history?.times?.length !== count) {
        throw new Error('Incomplete tick history');
    }
    const quotesRequest = Promise.allSettled(
        candidates.map(async candidate => {
            const settings = getInsightContract(family, candidate, ticks);
            const response = await sendInsightRequest(
                send,
                {
                    proposal: 1,
                    amount: stake,
                    basis: 'stake',
                    currency,
                    underlying_symbol: symbol,
                    ...settings,
                },
                signal
            );
            if (!response?.proposal || response.error) return [];
            const { ask_price, payout, spot, contract_details } = response.proposal;
            const { high_barrier, low_barrier, maximum_ticks, maximum_payout, tick_size_barrier_percentage } =
                contract_details ?? {};
            return [
                candidate,
                {
                    ask_price,
                    payout,
                    spot,
                    contract_details: {
                        high_barrier,
                        low_barrier,
                        maximum_ticks,
                        maximum_payout,
                        tick_size_barrier_percentage,
                    },
                },
            ] as const;
        })
    );

    const precisionRequest =
        family === 'digital' && !Number.isInteger(history.pip_size)
            ? marketRequest(`precision:${symbol}`, { ticks: symbol }).then(
                  response => response.tick?.pip_size,
                  error => {
                      if (error instanceof InsightRateLimitError) throw error;
                      return undefined;
                  }
              )
            : Promise.resolve(history.pip_size);
    const [quotes, precision] = await Promise.all([quotesRequest, precisionRequest]);
    if (quotes.some(quote => quote.status === 'rejected' && quote.reason instanceof InsightRateLimitError)) {
        throw new InsightRateLimitError();
    }
    if (signal.aborted) return null;

    return fetchTickInsights<TTickInsights>(
        {
            prices: history.history.prices,
            times: history.history.times,
            currency,
            ticks,
            precision,
            family,
            quotes: Object.fromEntries(
                quotes.flatMap(quote => (quote.status === 'fulfilled' && quote.value.length ? [quote.value] : []))
            ),
            windowSize,
            candidate,
            candidates: selectedCandidates,
        },
        signal
    );
};
