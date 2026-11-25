import React from 'react';
import { isInsightRateLimit, noteInsightRateLimit, waitForInsightRequestSlot } from './tick-insights-data';

export const FINDER_SAMPLE_MAX_AGE = 180000;
const SAMPLE_SIZE = 400;

type TWindow = { prices: number[]; sampleAt: number; precision?: number };
type TTickResponse = {
    history?: { prices: (number | string)[]; times: number[] };
    tick?: { quote: number | string; epoch: number; pip_size?: number };
    pip_size?: number;
    error?: unknown;
};
type TSubscribe = (
    request: Record<string, unknown>,
    callback: (response: TTickResponse) => void
) => { unsubscribe: () => void };

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

export const useFinderTicks = (subscribe: TSubscribe | undefined, marketKey: string, refresh: number) => {
    const [windows, setWindows] = React.useState<Map<string, TWindow>>(() => new Map());

    React.useEffect(() => {
        if (!subscribe || !marketKey) return;
        const controller = new AbortController();
        const { signal } = controller;
        const samples = new Map<string, TWindow>();
        const subscriptions = new Map<string, ReturnType<TSubscribe>>();
        const retries = new Set<ReturnType<typeof setTimeout>>();
        let publish: ReturnType<typeof setTimeout> | undefined;

        const openStream = async (symbol: string) => {
            const retry = () => {
                const timer = setTimeout(() => {
                    retries.delete(timer);
                    subscriptions.get(symbol)?.unsubscribe();
                    subscriptions.delete(symbol);
                    openStream(symbol);
                }, 60000);
                retries.add(timer);
            };
            try {
                await waitForInsightRequestSlot(signal);
                if (signal.aborted) return;
                let failed = false;
                let firstTick = true;
                const subscription = subscribe(
                    {
                        ticks_history: symbol,
                        end: 'latest',
                        count: SAMPLE_SIZE,
                        style: 'ticks',
                        subscribe: 1,
                        passthrough: { fancytrading_insights: true },
                    },
                    response => {
                        if (signal.aborted || failed) return;
                        if (isInsightRateLimit(response)) noteInsightRateLimit();
                        if (response.error || isInsightRateLimit(response)) {
                            failed = true;
                            samples.delete(symbol);
                            retry();
                            return;
                        }
                        const sample = samples.get(symbol);
                        const { history, tick } = response;
                        if (history?.prices?.length === SAMPLE_SIZE && history.times?.length === SAMPLE_SIZE) {
                            const prices = history.prices.map(Number);
                            const sampleAt = Number(history.times.at(-1)) * 1000;
                            if (!(sampleAt > 0) || prices.some(price => !Number.isFinite(price) || price <= 0)) return;
                            samples.set(symbol, {
                                prices,
                                sampleAt,
                                precision: response.pip_size ?? sample?.precision,
                            });
                            firstTick = true;
                        } else if (sample && tick) {
                            const price = Number(tick.quote);
                            const sampleAt = Number(tick.epoch) * 1000;
                            if (!(sampleAt >= sample.sampleAt) || !Number.isFinite(price) || price <= 0) return;
                            // The first subscription update may repeat the last tick in the history response.
                            const prices =
                                firstTick && sampleAt === sample.sampleAt && price === sample.prices.at(-1)
                                    ? sample.prices
                                    : [...sample.prices.slice(1), price];
                            firstTick = false;
                            samples.set(symbol, { prices, sampleAt, precision: tick.pip_size ?? sample.precision });
                        } else {
                            return;
                        }
                        publish ??= setTimeout(() => {
                            publish = undefined;
                            const received = new Map(samples);
                            setWindows(previous => {
                                const next = new Map(previous);
                                received.forEach((sample, market) => {
                                    if (sample.sampleAt >= (previous.get(market)?.sampleAt ?? 0))
                                        next.set(market, sample);
                                });
                                return next;
                            });
                        }, 200);
                    }
                );
                subscriptions.set(symbol, subscription);
            } catch {
                if (!signal.aborted) retry();
            }
        };

        marketKey.split(',').forEach(openStream);
        return () => {
            controller.abort();
            clearTimeout(publish);
            retries.forEach(clearTimeout);
            subscriptions.forEach(subscription => subscription.unsubscribe());
        };
    }, [subscribe, marketKey, refresh]);

    return windows;
};
