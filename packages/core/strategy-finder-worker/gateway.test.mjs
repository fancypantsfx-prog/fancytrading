import assert from 'node:assert/strict';
import test from 'node:test';
import { accountSessionName, FancyTradingAccount } from './account-gateway.mjs';
import { FancyMarketData } from './market-gateway.mjs';
import { onRequestPost as publicEndpoint } from '../functions/api/premium/tick-insights/market.js';

const post = (body, authorization = 'Bearer test-token') =>
    new Request('https://fancytrading.example', {
        method: 'POST',
        headers: { Authorization: authorization },
        body: JSON.stringify(body),
    });

test('deduplicates history across users and windows without forwarding browser credentials', async () => {
    const requests = [];
    const market = new FancyMarketData(null, null, async () => ({
        send: async payload => {
            requests.push(payload);
            const ticks = Array.from({ length: 400 }, (_, index) => index + 1);
            return { history: { prices: ticks, times: ticks } };
        },
        close: () => undefined,
    }));
    const env = {
        FANCY_TRADING_BACKEND: {
            fetch: (url, options) => {
                const request = new Request(url, options);
                assert.equal(request.headers.has('Authorization'), false);
                return market.fetch(request);
            },
        },
    };
    try {
        const results = await Promise.all(
            [20, 100, 400].map(count =>
                publicEndpoint({
                    request: post(
                        { ticks_history: 'R_50', count, end: 'latest', style: 'ticks' },
                        `Bearer user-${count}`
                    ),
                    env,
                })
            )
        );
        const data = await Promise.all(results.map(response => response.json()));
        assert.deepEqual(
            data.map(item => item.history.prices.length),
            [20, 100, 400]
        );
        assert.equal(requests.length, 1);
        const denied = await market.fetch(post({ buy: 'proposal-id', price: 10 }));
        assert.equal(denied.status, 400);
    } finally {
        market.close();
    }
});

test('isolates broker sessions by account and credential', async () => {
    const first = await accountSessionName('VRTC123', 'Bearer one');
    assert.notEqual(first, await accountSessionName('VRTC124', 'Bearer one'));
    assert.notEqual(first, await accountSessionName('VRTC123', 'Bearer two'));
    assert.ok(!first.includes('Bearer'));
});

test('reuses an order result, rejects changed quotes, and never resubmits an unknown purchase', async () => {
    const state = new Map();
    const calls = [];
    let payout = 18;
    let unknown = false;
    const storage = { get: key => state.get(key), put: (key, value) => state.set(key, value) };
    const broker = new FancyTradingAccount({ storage }, { DERIV_APP_ID: '42' }, async (account, authorization) => {
        assert.equal(account, 'VRTC123');
        assert.equal(authorization, 'Bearer test-token');
        return {
            send: async request => {
                calls.push(request);
                if (request.proposal) return { proposal: { id: 'proposal', ask_price: 10, payout } };
                if (unknown) throw new Error('connection lost');
                return { buy: { contract_id: 123 } };
            },
            close: () => undefined,
        };
    });
    const request = requestId =>
        post({
            operation: 'buy',
            account: 'VRTC123',
            requestId,
            expiresAt: Date.now() + 15000,
            payout: 18,
            template: {
                proposal: 1,
                amount: 10,
                basis: 'stake',
                currency: 'USD',
                underlying_symbol: 'R_50',
                contract_type: 'CALL',
                duration: 1,
                duration_unit: 't',
            },
        });
    const submit = async id => (await broker.fetch(request(id))).json();
    const requestId = () => crypto.randomUUID().replaceAll('-', '');
    try {
        const id = requestId();
        assert.deepEqual(await Promise.all([submit(id), submit(id)]), [
            { buy: { contract_id: 123 } },
            { buy: { contract_id: 123 } },
        ]);
        payout = 17;
        assert.equal((await submit(requestId())).error.code, 'QuoteChanged');
        payout = 18;
        unknown = true;
        const unknownId = requestId();
        assert.equal((await submit(unknownId)).error.code, 'PurchaseUnknown');
        assert.equal((await submit(unknownId)).error.code, 'PurchaseUnknown');
        assert.equal(calls.filter(call => call.buy).length, 2);
    } finally {
        broker.close();
    }
});
