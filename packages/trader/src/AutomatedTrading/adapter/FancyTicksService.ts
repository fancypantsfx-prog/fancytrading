import { WS } from '@deriv/shared';

import type { AutomatedTick } from '../types/automated-trading.types';

type Tick = AutomatedTick;

type Candle = {
    open: number;
    high: number;
    low: number;
    close: number;
    epoch: number;
};

type MonitorOptions = {
    symbol: string;
    pipSize?: number;
    granularity?: number;
    callback: (data: Tick) => void;
};

type Subscription = {
    key: string;
    symbol: string;
    granularity?: number;
    subscriber: any;
};

const parseTick = (tick: any, symbol: string, pipSize?: number): Tick => {
    const quoteString = String(tick.quote);

    return {
        epoch: Number(tick.epoch),
        quote: Number(tick.quote),
        quoteString,
        symbol: tick.symbol ?? symbol,
        pipSize: tick.pip_size == null ? pipSize : Number(tick.pip_size),
    };
};

const parseCandle = (candle: any): Candle => ({
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    epoch: Number(candle.open_time ?? candle.epoch),
});

class FancyTicksService {
    private ticks = new Map<string, Tick[]>();
    private candles = new Map<string, Candle[]>();
    private pipSizes = new Map<string, number>();
    private subscriptions = new Map<string, Subscription>();

    private generateKey() {
        return `bot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    async request(options: {
        symbol: string;
        count?: number;
        pipSize?: number;
        granularity?: number;
    }): Promise<Tick[] | Candle[]> {
        const {
            symbol,
            count = 1000,
            pipSize,
            granularity,
        } = options;

        if (pipSize != null) {
            this.pipSizes.set(symbol, pipSize);
        }

        const request = {
            ticks_history: symbol,
            end: 'latest',
            count,
            ...(granularity
                ? {
                      granularity: Number(granularity),
                      style: 'candles',
                  }
                : {
                      style: 'ticks',
                  }),
        };

        const response = await WS.storage.send(request);

        if (response?.error) {
            throw new Error(response.error.message || 'Unable to load tick history');
        }

        if (granularity) {
            const candles = (response?.candles ?? []).map(parseCandle);

            this.candles.set(`${symbol}:${granularity}`, candles);

            return candles;
        }

        const times = response?.history?.times ?? [];
        const prices = response?.history?.prices ?? [];

        const ticks = times.map((epoch: number, index: number) =>
            parseTick(
                {
                    epoch,
                    quote: prices[index],
                },
                symbol,
                this.pipSizes.get(symbol)
            )
        );

        this.ticks.set(symbol, ticks);

        return ticks;
    }

    async monitor(options: MonitorOptions): Promise<string> {
        const {
            symbol,
            pipSize,
            granularity,
            callback,
        } = options;

        if (pipSize != null) {
            this.pipSizes.set(symbol, pipSize);
        }

        const key = this.generateKey();

        const request = {
            ticks_history: symbol,
            subscribe: 1,
            end: 'latest',
            count: 1000,
            ...(granularity
                ? {
                      granularity: Number(granularity),
                      style: 'candles',
                  }
                : {
                      style: 'ticks',
                  }),
        };

        const subscriber = WS.subscribeTicksHistory(request, (response: any) => {
            if (granularity) {
                if (response?.ohlc) {
                    const candle = parseCandle(response.ohlc);
                    const cacheKey = `${symbol}:${granularity}`;
                    const existing = this.candles.get(cacheKey) ?? [];
                    const updated = [...existing.slice(-999), candle];

                    this.candles.set(cacheKey, updated);
                }

                return;
            }

            if (!response?.tick) return;

            const tick = parseTick(
                response.tick,
                symbol,
                this.pipSizes.get(symbol)
            );

            const existing = this.ticks.get(symbol) ?? [];
            const updated = [...existing.slice(-999), tick];

            this.ticks.set(symbol, updated);

            callback(tick);
        });

        this.subscriptions.set(key, {
            key,
            symbol,
            granularity,
            subscriber,
        });

        return key;
    }

    stopMonitor(key: string): void {
        const subscription = this.subscriptions.get(key);

        if (!subscription) return;

        if (subscription.subscriber?.unsubscribe) {
            subscription.subscriber.unsubscribe();
        }

        this.subscriptions.delete(key);
    }

    async getTicks(symbol: string, count = 1000): Promise<Tick[]> {
        const result = await this.request({
            symbol,
            count,
            pipSize: this.pipSizes.get(symbol),
        });

        return result as Tick[];
    }

    async getOhlc(symbol: string, granularity = 60): Promise<Candle[]> {
        const result = await this.request({
            symbol,
            granularity,
        });

        return result as Candle[];
    }

    getLastTick(symbol: string): Tick | undefined {
        const ticks = this.ticks.get(symbol);

        return ticks?.[ticks.length - 1];
    }

    setPipSize(symbol: string, pipSize: number): void {
        this.pipSizes.set(symbol, pipSize);
    }

    getPipSize(symbol: string): number | undefined {
        return this.pipSizes.get(symbol);
    }

    async unsubscribeFromTicksService(): Promise<void> {
        for (const subscription of this.subscriptions.values()) {
            if (subscription.subscriber?.unsubscribe) {
                subscription.subscriber.unsubscribe();
            }
        }

        this.subscriptions.clear();
        this.ticks.clear();
        this.candles.clear();
        this.pipSizes.clear();
    }
}

export const fancyTicksService = new FancyTicksService();

export default fancyTicksService;