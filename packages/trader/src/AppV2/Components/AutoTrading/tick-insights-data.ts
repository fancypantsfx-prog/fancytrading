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
    rows: {
        candidate: string;
        stake: number;
        payout: number;
        estimated: boolean;
        breakEven?: number;
        historical: TSample;
        older: TSample;
        recent: TSample;
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

export type TInsightRun = TInsightTrade & { stopLoss: number; takeProfit?: number };

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

export const getInsightContract = (family: TFamily, candidate: string, ticks: number) => {
    if (family === 'accumulator' && ACCUMULATOR_RATES.includes(candidate)) {
        return { contract_type: 'ACCU', growth_rate: Number(candidate) / 100 };
    }
    if (family === 'digital' && DIGITAL_CONTRACTS.includes(candidate)) {
        return { contract_type: candidate, duration: ticks, duration_unit: 't' };
    }
    throw new Error('Choose a supported contract from the comparison.');
};

type TMarketData = {
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

export const compareRecentTicks = async (
    send: (request: Record<string, unknown>) => Promise<TMarketData>,
    options: { symbol: string; currency: string; stake: number; ticks: number; family: TFamily },
    signal: AbortSignal
) => {
    const { symbol, currency, stake, ticks, family } = options;
    const candidates = family === 'accumulator' ? ACCUMULATOR_RATES : DIGITAL_CONTRACTS;

    const historyRequest = send({ ticks_history: symbol, end: 'latest', count: 400, style: 'ticks' });
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
    if (history?.error || history?.history?.prices?.length !== 400 || history?.history?.times?.length !== 400) {
        throw new Error('Incomplete tick history');
    }

    const precisionRequest =
        family === 'digital' && !Number.isInteger(history.pip_size)
            ? send({ ticks: symbol }).then(
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
        },
        signal
    );
};
