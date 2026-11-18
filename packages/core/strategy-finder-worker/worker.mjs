import { TICK_SAMPLE_SIZE } from '../premium/tick-insights.mjs';
import { finderContracts, finderSampleExpiry, SCAN_CACHE_KEY, summarizeFinderMarket } from '../premium/strategy-finder.mjs';

const DERIV_PUBLIC_WS = 'https://api.derivws.com/trading/v1/options/ws/public';
const REQUEST_SPACING_MS = 1000;
const RATE_LIMIT_RETRY_MS = 10000;
const CATALOG_MAX_AGE_MS = 3 * 60 * 1000;
const REFRESH_BUDGET_MS = 45000;

const isOpen = item => ![0, false].includes(item.exchange_is_open) && ![1, true].includes(item.is_trading_suspended);

const openMarketData = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
        response = await fetch(DERIV_PUBLIC_WS, {
            headers: { Upgrade: 'websocket' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
    const socket = response.webSocket;
    if (!socket) throw new Error('Deriv market connection unavailable');

    let requestId = 0;
    let pending;
    socket.addEventListener('message', ({ data }) => {
        let result;
        try {
            result = JSON.parse(data);
        } catch {
            return;
        }
        if (pending && result.req_id === pending.id) pending.resolve(result);
    });
    socket.addEventListener('close', () => pending?.reject(new Error('Deriv market connection closed')));
    socket.addEventListener('error', () => pending?.reject(new Error('Deriv market connection failed')));
    socket.accept();

    return {
        close: () => socket.close(1000, 'Snapshot complete'),
        async send(payload) {
            const id = ++requestId;
            let timer;
            try {
                return await new Promise((resolve, reject) => {
                    pending = { id, resolve, reject };
                    timer = setTimeout(() => reject(new Error('Deriv market request timed out')), 8000);
                    socket.send(JSON.stringify({ ...payload, req_id: id }));
                });
            } finally {
                clearTimeout(timer);
                pending = undefined;
            }
        },
    };
};

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export const warmStrategyFinder = async (cache, connect = openMarketData) => {
    const previous = await cache.get(SCAN_CACHE_KEY, 'json');
    const connection = await connect();
    const deadline = Date.now() + REFRESH_BUDGET_MS;
    let retriedRateLimit = false;
    const send = async payload => {
        await pause(REQUEST_SPACING_MS);
        let response = await connection.send(payload);
        if (response.error?.code === 'RateLimit' && !retriedRateLimit && Date.now() + RATE_LIMIT_RETRY_MS < deadline) {
            retriedRateLimit = true;
            await pause(RATE_LIMIT_RETRY_MS);
            response = await connection.send(payload);
        }
        return response;
    };

    try {
        let catalog = previous?.catalog;
        if (!catalog || Date.now() - catalog.updatedAt >= CATALOG_MAX_AGE_MS) {
            const instruments = new Map();
            try {
                for (const [group, contracts] of Object.entries(finderContracts)) {
                    const list = await send({ active_symbols: 'full', contract_type: contracts });
                    if (!Array.isArray(list.active_symbols)) {
                        throw new Error(list.error?.code || 'Deriv instrument list unavailable');
                    }
                    for (const item of list.active_symbols) {
                        const symbol = item.underlying_symbol;
                        if (!symbol) continue;
                        const market = instruments.get(symbol) ?? {
                            underlying_symbol: symbol,
                            underlying_symbol_name: item.underlying_symbol_name,
                            exchange_is_open: item.exchange_is_open,
                            is_trading_suspended: item.is_trading_suspended,
                            pip_size: item.pip_size,
                            groups: [],
                        };
                        market.groups.push(group);
                        instruments.set(symbol, market);
                    }
                }
                if (!instruments.size) throw new Error('Deriv returned an empty instrument list');
                catalog = { updatedAt: Date.now(), instruments: [...instruments.values()] };
            } catch (error) {
                if (!catalog) throw error;
                console.warn('Strategy Finder reusing its instrument list', String(error));
            }
        }

        const activeInstruments = new Map(catalog.instruments.map(item => [item.underlying_symbol, item]));
        const markets = [];
        const cachedMarkets = new Map((previous?.markets ?? []).map(market => [market.symbol, market]));
        // Refresh the oldest markets first so a partial refresh cannot starve later symbols.
        const instruments = [...activeInstruments.values()]
            .filter(isOpen)
            .sort(
                (a, b) =>
                    (cachedMarkets.get(a.underlying_symbol)?.collectedAt ?? 0) -
                    (cachedMarkets.get(b.underlying_symbol)?.collectedAt ?? 0)
            );
        // Leave time to publish before the next scheduled invocation.
        for (const item of instruments) {
            if (Date.now() >= deadline) break;
            const symbol = item.underlying_symbol;
            const { history, pip_size, error } = await send({
                ticks_history: symbol,
                end: 'latest',
                count: TICK_SAMPLE_SIZE,
                style: 'ticks',
            });
            if (error?.code === 'RateLimit') {
                console.warn('Strategy Finder history rate limited', { refreshed: markets.length });
                break;
            }
            if (history?.prices?.length !== TICK_SAMPLE_SIZE || history.times?.length !== TICK_SAMPLE_SIZE) continue;
            const lastTick = Number(history.times.at(-1));
            if (!(finderSampleExpiry({ collectedAt: Date.now(), lastTick }) > Date.now())) continue;
            const tickSize = Number(item.pip_size);
            let precision = Number.isInteger(pip_size) ? pip_size : undefined;
            if (precision === undefined && tickSize > 0 && tickSize <= 1) {
                const decimals = -Math.log10(tickSize);
                if (Math.abs(decimals - Math.round(decimals)) < 1e-8) precision = Math.round(decimals);
            }
            if (precision === undefined) {
                const spot = await send({ ticks: symbol });
                precision = spot.tick?.pip_size ?? cachedMarkets.get(symbol)?.precision;
                if (spot.error?.code === 'RateLimit') {
                    console.warn('Strategy Finder precision rate limited', { refreshed: markets.length });
                    break;
                }
            }
            const summaries = summarizeFinderMarket({ ...history, precision });
            if (!summaries) continue;
            markets.push({
                symbol,
                label: item.underlying_symbol_name,
                summaries,
                precision,
                groups: item.groups,
                lastTick,
                collectedAt: Date.now(),
            });
            cachedMarkets.delete(symbol);
        }

        if (!markets.length) throw new Error('No new Deriv tick windows collected');
        const updatedAt = Date.now();
        const refreshed = markets.length;
        for (const market of cachedMarkets.values()) {
            const active = activeInstruments.get(market.symbol);
            if (active && isOpen(active) && finderSampleExpiry(market) > updatedAt)
                markets.push({ ...market, groups: active.groups });
        }
        const instrumentsByGroup = Object.fromEntries(
            Object.keys(finderContracts).map(group => [
                group,
                [...activeInstruments.values()].filter(item => isOpen(item) && item.groups.includes(group)).length,
            ])
        );
        await cache.put(SCAN_CACHE_KEY, JSON.stringify({ updatedAt, markets, instrumentsByGroup, catalog }));
        console.info('Strategy Finder snapshot written', {
            refreshed,
            markets: markets.length,
            eligible: activeInstruments.size,
        });
    } finally {
        connection.close();
    }
};

export default {
    async scheduled(_event, env) {
        await warmStrategyFinder(env.STRATEGY_FINDER_CACHE);
    },
};
