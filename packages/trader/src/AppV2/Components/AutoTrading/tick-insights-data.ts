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

export const getInsightMarkets = async (send: (payload: Record<string, unknown>) => Promise<TMarketData>) => {
    const response = await send({ active_symbols: 'brief' });
    if (response.error) throw new Error('Could not load instruments');
    return (response.active_symbols ?? []).map(item => ({
        symbol: item.underlying_symbol,
        label: item.name || item.display_name || item.underlying_symbol,
    }));
};

export const compareInsightMarkets = async (
    send: Parameters<typeof compareRecentTicks>[0],
    options: Parameters<typeof compareRecentTicks>[1],
    markets: string[],
    signal: AbortSignal,
    onProgress: (scanned: number) => void
): Promise<TTickInsights | null> => {
    const reports: TTickInsights[] = [];
    let next = 0;
    let scanned = 0;
    let locked = false;
    await Promise.all(
        Array.from({ length: Math.min(4, markets.length) }, async () => {
            while (!signal.aborted && !locked && next < markets.length) {
                const symbol = markets[next++];
                try {
                    const report = await waitForInsightRequest(
                        compareRecentTicks(send, { ...options, symbol }, signal),
                        'Instrument comparison timed out'
                    );
                    if (!report) locked = true;
                    else reports.push({ ...report, rows: report.rows.map(row => ({ ...row, symbol })) });
                } catch (error) {
                    if (markets.length === 1) throw error;
                }
                if (!signal.aborted) onProgress(++scanned);
            }
        })
    );
    if (locked || signal.aborted) return null;
    const latest = reports.reduce<TTickInsights | undefined>(
        (result, report) => (!result || report.lastTick > result.lastTick ? report : result),
        undefined
    );
    if (!latest) throw new Error('No instrument history could be loaded');
    return { ...latest, marketsScanned: markets.length, rows: reports.flatMap(report => report.rows) };
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
        const request = send(payload);
        marketRequests.set(key, request);
        return request;
    };

    const historyRequest = marketRequest(`history:${symbol}`, {
        ticks_history: symbol,
        end: 'latest',
        count,
        style: 'ticks',
    });
    const quotesRequest = Promise.allSettled(
        candidates.map(async candidate => {
            const settings = getInsightContract(family, candidate, ticks);
            const response = await send({
                proposal: 1,
                amount: stake,
                basis: 'stake',
                currency,
                underlying_symbol: symbol,
                ...settings,
            });
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

    const history = await historyRequest;
    if (signal.aborted) return null;
    if (history?.error || history?.history?.prices?.length !== count || history?.history?.times?.length !== count) {
        throw new Error('Incomplete tick history');
    }

    const precisionRequest =
        family === 'digital' && !Number.isInteger(history.pip_size)
            ? marketRequest(`precision:${symbol}`, { ticks: symbol }).then(
                  response => response.tick?.pip_size,
                  () => undefined
              )
            : Promise.resolve(history.pip_size);
    const [quotes, precision] = await Promise.all([quotesRequest, precisionRequest]);
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
