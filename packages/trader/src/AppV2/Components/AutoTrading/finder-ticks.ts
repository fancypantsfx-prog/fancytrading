import { sendInsightRequest, waitForInsightRequest } from './tick-insights-data';

export const FINDER_SAMPLE_MAX_AGE = 180000;
const SAMPLE_SIZE = 400;

type TWindow = { prices: number[]; sampleAt: number; precision?: number };

export const finderLiveSample = ({ prices, precision }: TWindow, duration: number, candidate: string) => {
    const [type, barrier] = candidate.split(':');
    const digitTarget = Number(barrier);
    const isDigit = type.startsWith('DIGIT');
    if (isDigit && (precision === undefined || !Number.isInteger(precision) || precision < 0 || precision > 10)) return;
    let hits = 0;
    let count = 0;
    for (let exit = duration; exit < prices.length; exit += duration) {
        const price = prices[exit];
        const entry = prices[exit - duration];
        const digit = isDigit ? Number(price.toFixed(precision).slice(-1)) : 0;
        const win =
            (type === 'CALL' && price > entry) ||
            (type === 'PUT' && price < entry) ||
            (type === 'DIGITEVEN' && digit % 2 === 0) ||
            (type === 'DIGITODD' && digit % 2 === 1) ||
            (type === 'DIGITOVER' && digit > digitTarget) ||
            (type === 'DIGITUNDER' && digit < digitTarget) ||
            (type === 'DIGITMATCH' && digit === digitTarget);
        if (win) hits++;
        count++;
    }
    return { hits, count };
};

export const fetchFinderWindows = async (
    send: Parameters<typeof sendInsightRequest>[0],
    symbols: string[],
    signal: AbortSignal
) => {
    const windows = new Map<string, TWindow>();
    await Promise.allSettled(
        symbols.map(async symbol => {
            const response = await sendInsightRequest(
                payload => waitForInsightRequest(send(payload), 'Tick history request timed out.', 6000),
                { ticks_history: symbol, end: 'latest', count: SAMPLE_SIZE, style: 'ticks' },
                signal
            );
            const { history, pip_size: precision, error } = response;
            if (
                signal.aborted ||
                error ||
                history?.prices.length !== SAMPLE_SIZE ||
                history.times.length !== SAMPLE_SIZE
            )
                return;
            const prices = history.prices.map(Number);
            const sampleAt = Number(history.times.at(-1)) * 1000;
            if (!(sampleAt > 0) || prices.some(price => !Number.isFinite(price) || price <= 0)) return;
            windows.set(symbol, { prices, sampleAt, precision });
        })
    );
    return windows;
};
