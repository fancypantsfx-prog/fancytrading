import { TICK_SAMPLE_SIZE } from '../premium/tick-insights.mjs';
import { finderContracts, SCAN_CACHE_KEY, SCAN_MAX_AGE_MS } from '../premium/strategy-finder.mjs';

const DERIV_PUBLIC_WS = 'https://api.derivws.com/trading/v1/options/ws/public';
const REQUEST_SPACING_MS = 500;

const openMarketData = async () => {
    const response = await fetch(DERIV_PUBLIC_WS, {
        headers: { Upgrade: 'websocket' },
        signal: AbortSignal.timeout(10000),
    });
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
    const connection = await connect();
    try {
        const activeInstruments = new Map();
        for (const [group, contracts] of Object.entries(finderContracts)) {
            const list = await connection.send({ active_symbols: 'full', contract_type: contracts });
            if (!Array.isArray(list.active_symbols)) throw new Error('Deriv instrument list unavailable');
            for (const item of list.active_symbols) {
                const symbol = item.underlying_symbol;
                if (!symbol || item.exchange_is_open === 0 || item.is_trading_suspended === 1) continue;
                const market = activeInstruments.get(symbol) ?? { ...item, groups: [] };
                market.groups.push(group);
                activeInstruments.set(symbol, market);
            }
            await pause(REQUEST_SPACING_MS);
        }
        const markets = [];
        const previous = await cache.get(SCAN_CACHE_KEY, 'json');
        const cachedMarkets = new Map((previous?.markets ?? []).map(market => [market.symbol, market]));
        // Refresh the oldest markets first so a partial refresh cannot starve later symbols.
        const instruments = [...activeInstruments.values()].sort(
            (a, b) =>
                (cachedMarkets.get(a.underlying_symbol)?.collectedAt ?? 0) -
                (cachedMarkets.get(b.underlying_symbol)?.collectedAt ?? 0)
        );
        for (const item of instruments) {
            const symbol = item.underlying_symbol;
            await pause(REQUEST_SPACING_MS);
            const { history, pip_size, error } = await connection.send({
                ticks_history: symbol,
                end: 'latest',
                count: TICK_SAMPLE_SIZE,
                style: 'ticks',
            });
            if (error?.code === 'RateLimit') break;
            if (history?.prices?.length !== TICK_SAMPLE_SIZE || history.times?.length !== TICK_SAMPLE_SIZE) continue;
            const tickSize = Number(item.pip_size);
            let precision = Number.isInteger(pip_size) ? pip_size : undefined;
            if (precision === undefined && tickSize > 0 && tickSize <= 1) {
                const decimals = -Math.log10(tickSize);
                if (Math.abs(decimals - Math.round(decimals)) < 1e-8) precision = Math.round(decimals);
            }
            if (precision === undefined) {
                await pause(REQUEST_SPACING_MS);
                const spot = await connection.send({ ticks: symbol });
                if (spot.error?.code === 'RateLimit') break;
                precision = spot.tick?.pip_size;
            }
            markets.push({
                symbol,
                precision,
                groups: item.groups,
                prices: history.prices,
                times: history.times,
                collectedAt: Date.now(),
            });
            cachedMarkets.delete(symbol);
        }

        const now = Date.now();
        for (const market of cachedMarkets.values()) {
            const active = activeInstruments.get(market.symbol);
            if (active && now - market.collectedAt <= SCAN_MAX_AGE_MS)
                markets.push({ ...market, groups: active.groups });
        }
        if (!markets.length) throw new Error('No recent Deriv tick windows available');
        await cache.put(SCAN_CACHE_KEY, JSON.stringify({ updatedAt: now, markets }), { expirationTtl: 1800 });
    } finally {
        connection.close();
    }
};

export default {
    async scheduled(_event, env) {
        await warmStrategyFinder(env.STRATEGY_FINDER_CACHE);
    },
};
