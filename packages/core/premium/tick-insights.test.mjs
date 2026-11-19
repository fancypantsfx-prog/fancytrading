import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTickInsights } from './tick-insights.mjs';
import { onRequestPost } from '../functions/api/premium/tick-insights/analysis.js';
import { onRequestGet } from '../functions/api/premium/tick-insights/scan.js';
import { warmStrategyFinder } from '../strategy-finder-worker/worker.mjs';

const ticks = {
    prices: Array.from({ length: 400 }, (_, i) => (i < 200 ? 100 + i : 500 - i)),
    times: Array.from({ length: 400 }, (_, i) => 1800000000 + i),
};
const digital = {
    ...ticks,
    family: 'digital',
    currency: 'USD',
    ticks: 5,
    precision: 2,
    quotes: {
        CALL: { ask_price: '10', payout: '19' },
        PUT: { ask_price: 10, payout: 20 },
        DIGITEVEN: { ask_price: 10, payout: 18 },
        DIGITODD: { ask_price: 10, payout: 18 },
    },
};

test('reports historical outcomes separately from quoted payouts and ranks by observed hit rate', () => {
    const result = analyzeTickInsights(digital);
    assert.deepEqual(
        result.rows.map(row => row.candidate),
        ['DIGITEVEN', 'CALL', 'PUT', 'DIGITODD']
    );
    const rise = result.rows[1];
    assert.deepEqual(rise.older, { hits: 39, count: 39 });
    assert.deepEqual(rise.recent, { hits: 0, count: 39 });
    assert.deepEqual(rise.historical, { hits: 39, count: 78 });
    assert.equal(rise.payout, 19);
    assert.equal(rise.breakEven, 10 / 19);
    assert.equal(analyzeTickInsights({ ...digital, precision: undefined }).rows.length, 2);
    assert.equal(analyzeTickInsights({ ...digital, prices: ticks.prices.slice(1) }), null);
});

test('excludes a range touch and omits targets outside the quoted accumulator limits', () => {
    const input = {
        ...ticks,
        prices: Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 100 : 101)),
        family: 'accumulator',
        currency: 'USD',
        ticks: 1,
        quotes: {
            1: {
                ask_price: 10,
                spot: 100,
                contract_details: { low_barrier: 99, high_barrier: 101, maximum_ticks: 20, maximum_payout: 100 },
            },
            2: {
                ask_price: 10,
                contract_details: { tick_size_barrier_percentage: '2%', maximum_ticks: 20, maximum_payout: 100 },
            },
            3: {
                ask_price: 10,
                contract_details: { tick_size_barrier_percentage: '3%', maximum_ticks: 0, maximum_payout: 100 },
            },
            4: {
                ask_price: 10,
                contract_details: { tick_size_barrier_percentage: '4%', maximum_ticks: 20, maximum_payout: 10 },
            },
        },
    };
    const { rows } = analyzeTickInsights(input);
    assert.deepEqual(
        rows.map(row => row.candidate),
        ['2', '1']
    );
    assert.deepEqual(rows[0].historical, { hits: 398, count: 398 });
    assert.deepEqual(rows[1].historical, { hits: 198, count: 398 });
    assert.equal(rows[0].payout, 10.2);
    assert.equal(rows[0].estimated, true);
});

test('compares a digit barrier over a selected window and totals the settled replay', () => {
    const digits = [0, 6, 7, 8, 3, 2, 9, 5, 4, 6, 7, 2, 5, 1, 9, 7, 6, 3, 2, 0];
    const {
        rows: [row],
    } = analyzeTickInsights({
        ...digital,
        windowSize: 20,
        ticks: 1,
        precision: 1,
        prices: digits.map(digit => 100 + digit / 10),
        times: ticks.times.slice(0, 20),
        candidate: 'DIGITOVER:5',
        quotes: { 'DIGITOVER:5': { ask_price: 10, payout: 20 } },
    });
    assert.deepEqual(row.historical, { hits: 9, count: 19 });
    assert.equal(row.maxWins, 3);
    assert.equal(row.maxLosses, 3);
    assert.equal(row.totalStaked, 190);
    assert.equal(row.estimatedNet, -10);
    assert.equal(row.returnOnStake, -10 / 190);
});

test('serves free launch and timed preview, and enforces paid access on the analysis endpoint', async () => {
    const makeRequest = () =>
        new Request('https://fancytrading.org/api/premium/tick-insights/analysis', {
            method: 'POST',
            body: JSON.stringify(digital),
        });
    const check = env => onRequestPost({ request: makeRequest(), env });
    const previewDb = active => ({
        prepare: () => ({ bind: () => ({ first: async () => (active ? { ends_at: 1800000900 } : null) }) }),
    });
    const free = await check({});
    assert.equal(free.status, 200);
    assert.equal((await free.json()).access.access, 'free');
    assert.equal(free.headers.get('Cache-Control'), 'private, no-store');

    const locked = await check({ TICK_INSIGHTS_ACCESS: 'paid', PREMIUM_DB: previewDb(false) });
    assert.equal(locked.status, 403);
    assert.equal(await locked.json().then(result => result.rows), undefined);

    const preview = await check({ TICK_INSIGHTS_ACCESS: 'paid', PREMIUM_DB: previewDb(true) });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).access.access, 'preview');
    assert.equal((await check({ TICK_INSIGHTS_ACCESS: 'paid' })).status, 503);
});


test('the finder displays older samples and works before a contract list has been cached', async () => {
    const now = Date.now();
    const market = {
        symbol: 'FRESH',
        groups: ['rise_fall'],
        lastTick: Math.floor(now / 1000) - 10,
        collectedAt: now - 5000,
        summaries: [{ count: 399, rise: 200, fall: 199 }],
    };
    const response = await onRequestGet({
        request: new Request('https://fancytrading.org/api/premium/tick-insights/scan?contract=rise_fall&ticks=1'),
        env: {
            STRATEGY_FINDER_CACHE: {
                get: async () => ({
                    updatedAt: now,
                    contractLists: Object.fromEntries(['FRESH', 'OLD_TICK', 'OLD_COLLECTION'].map(symbol => [
                        symbol, { checkedAt: now, contracts: [{ type: 'CALL', minimum: 1, maximum: 10 }] },
                    ])),
                    markets: [
                        market,
                        { ...market, symbol: 'OLD_TICK', lastTick: Math.floor(now / 1000) - 180 },
                        { ...market, symbol: 'OLD_COLLECTION', collectedAt: now - 180000 },
                        { ...market, symbol: 'UNKNOWN_TICK', lastTick: undefined },
                    ],
                }),
            },
        },
    });
    assert.equal(response.status, 200);
    const { rows } = await response.json();
    assert.deepEqual(rows.map(row => row.symbol), ['FRESH', 'OLD_TICK', 'OLD_COLLECTION', 'UNKNOWN_TICK', 'UNKNOWN_TICK']);
    assert.equal(rows.find(row => row.symbol === 'OLD_TICK').sampleAt, (Math.floor(now / 1000) - 180) * 1000);
    assert.equal(rows.find(row => row.symbol === 'UNKNOWN_TICK').sampleAt, market.collectedAt);
});

test('the finder returns an empty response while the Worker warms the cache', async () => {
    const request = new Request('https://fancytrading.org/api/premium/tick-insights/scan?contract=rise_fall&ticks=5');
    const response = await onRequestGet({ request, env: {} });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).rows, []);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('a failed market advances the refresh cursor and preserves older samples', async () => {
    const now = Date.now();
    const lastTick = Math.floor(now / 1000);
    const symbols = ['FIRST', 'SECOND', 'THIRD'];
    const calls = [];
    let snapshot = {
        updatedAt: now - 30000,
        lastAttempted: 'FIRST',
        contractLists: Object.fromEntries(['FIRST','THIRD'].map(symbol => [
            symbol, { checkedAt: now, contracts: [{ type: 'CALL', minimum: 1, maximum: 10 }] },
        ])),
        catalog: {
            updatedAt: now,
            instruments: symbols.map(underlying_symbol => ({ underlying_symbol, groups: ['rise_fall'] })),
        },
        markets: [
            { symbol: 'FIRST', groups: ['rise_fall'], lastTick, collectedAt: now },
            { symbol: 'SECOND', groups: ['rise_fall'], lastTick: lastTick - 181, collectedAt: now },
        ],
    };
    const cache = {
        get: async () => snapshot,
        put: async (_key, value) => { snapshot = JSON.parse(value); },
    };
    const connect = async () => ({
        close: () => undefined,
        send: async ({ ticks_history: symbol }) => {
            calls.push(symbol);
            if (symbol === 'SECOND') throw new Error('Connection closed');
            return { history: { prices: ticks.prices, times: ticks.times.map((_, i) => lastTick - 399 + i) } };
        },
    });
    const wait = async () => undefined;
    await warmStrategyFinder(cache, connect, wait);
    assert.deepEqual(calls, ['SECOND']);
    assert.equal(snapshot.updatedAt, now - 30000);
    assert.equal(snapshot.lastAttempted, 'SECOND');
    assert.deepEqual(snapshot.markets.map(market => market.symbol), ['FIRST', 'SECOND']);

    await warmStrategyFinder(cache, connect, wait);
    assert.deepEqual(calls, ['SECOND', 'THIRD', 'FIRST', 'SECOND']);
    assert.deepEqual(snapshot.markets.map(market => market.symbol), ['THIRD', 'FIRST', 'SECOND']);
});

test('a scheduled refresh prepares only eligible tick rankings before any Pages request', async () => {
    const lastTick = Math.floor(Date.now() / 1000);
    const history = { prices: ticks.prices, times: ticks.times.map((_, i) => lastTick - 399 + i) };
    const call = { contract_type: 'CALL', contract_category: 'callput', min_contract_duration: '5t', max_contract_duration: '10t' };
    const instruments = [
        { underlying_symbol: 'OPEN', exchange_is_open: 1 },
        { underlying_symbol: 'CLOSED', exchange_is_open: 0 },
        { underlying_symbol: 'STALE', exchange_is_open: 1 },
    ];
    const requests = [];
    let snapshot;
    const cache = {
        get: async () => snapshot,
        put: async (_key, value) => { snapshot = JSON.parse(value); },
    };
    const connect = async () => ({
        close: () => undefined,
        send: async request => {
            requests.push(request);
            if (request.active_symbols) return { active_symbols: request.contract_type.includes('CALL') ? instruments : [] };
            if (request.contracts_for) return { contracts_for: { available: [
                call,
                { ...call, contract_type: 'PUT', contract_category: 'higherlower' },
                { ...call, contract_type: 'PUT', start_type: 'forward' },
                { ...call, contract_type: 'PUT', min_contract_duration: '1m', max_contract_duration: '1d' },
            ] } };
            return {
                history: request.ticks_history === 'STALE'
                    ? { ...history, times: history.times.map(time => time - 181) }
                    : history,
            };
        },
    });
    await warmStrategyFinder(cache, connect, async () => undefined);
    assert.deepEqual(snapshot.markets.map(market => market.symbol), ['OPEN', 'STALE']);
    assert.deepEqual(requests.filter(request => request.contracts_for).map(request => request.contracts_for), ['OPEN', 'STALE']);
    const requestCount = requests.length;
    const scan = async duration => {
        const response = await onRequestGet({
            request: new Request(`https://fancytrading.org/api/premium/tick-insights/scan?contract=rise_fall&ticks=${duration}`),
            env: { STRATEGY_FINDER_CACHE: cache },
        });
        assert.equal(response.status, 200);
        return response.json();
    };
    const snapshotAtFiveTicks = await scan(5);
    assert.deepEqual(snapshotAtFiveTicks.rows.map(row => [row.symbol, row.candidate]), [['OPEN', 'CALL'], ['STALE', 'CALL']]);
    assert.deepEqual((await scan(4)).rows, []);
    assert.deepEqual((await scan(11)).rows, []);
    assert.equal(requests.length, requestCount);
});
