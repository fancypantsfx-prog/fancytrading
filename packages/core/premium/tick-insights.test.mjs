import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeTickInsights } from './tick-insights.mjs';
import { onRequestPost } from '../functions/api/premium/tick-insights/analysis.js';

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
