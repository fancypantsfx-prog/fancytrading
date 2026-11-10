import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';
import { onRequestGet } from '../functions/api/premium/[feature].js';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const feature = 'example-feature';
let database;
let env;
let now;

beforeEach(() => {
    database = new DatabaseSync(':memory:');
    database.exec(schema);
    now = 1_800_000_000;
    database.function('unixepoch', () => now);
    env = {
        PREMIUM_DB: {
            prepare: sql => ({ bind: (...values) => ({ first: async () => database.prepare(sql).get(...values) }) }),
        },
    };
});

afterEach(() => database.close());

const checkAccess = (headers, key = feature, bindings = env) =>
    onRequestGet({
        request: new Request(`https://fancytrading.org/api/premium/${key}?account_id=PAID`, { headers }),
        env: bindings,
        params: { feature: key },
    });

test('requires a verified account and a current grant for this feature', async t => {
    database.prepare('INSERT INTO premium_grants VALUES (?, ?, ?)').run(feature, 'PAID', now + 60);
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url, 'https://api.derivws.com/trading/v1/options/accounts');
        assert.equal(options.redirect, 'error');
        if (options.headers.Authorization === 'Bearer invalid') return new Response(null, { status: 401 });
        const accounts = [{ account_id: 'DEMO' }];
        if (options.headers.Authorization === 'Bearer paid') accounts.push({ account_id: 'PAID' });
        return Response.json({ data: accounts });
    });

    assert.deepEqual(await (await checkAccess()).json(), { access: 'locked' });
    assert.deepEqual(await (await checkAccess({ Authorization: 'Bearer unpaid' })).json(), { access: 'locked' });
    assert.deepEqual(await (await checkAccess({ Authorization: 'Bearer invalid' })).json(), { access: 'locked' });

    const headers = { Authorization: 'Bearer paid' };
    const response = await checkAccess(headers);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.deepEqual(await response.json(), { access: 'paid', expiresAt: now + 60 });
    assert.deepEqual(await (await checkAccess(headers, 'other-feature')).json(), { access: 'locked' });

    now += 60;
    assert.deepEqual(await (await checkAccess(headers)).json(), { access: 'locked' });
});

test('starts and ends an anonymous preview at the configured boundaries', async () => {
    database.prepare('INSERT INTO premium_previews VALUES (?, ?, ?)').run(feature, now + 1, now + 2);
    assert.deepEqual(await (await checkAccess()).json(), { access: 'locked' });

    now += 1;
    assert.deepEqual(await (await checkAccess()).json(), { access: 'preview', expiresAt: now + 1 });
    assert.deepEqual(await (await checkAccess(undefined, 'other-feature')).json(), { access: 'locked' });

    now += 1;
    assert.deepEqual(await (await checkAccess()).json(), { access: 'locked' });
});

test('fails closed for invalid feature keys and unavailable access services', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 502 }));
    assert.equal((await checkAccess(undefined, 'Invalid')).status, 400);
    assert.equal((await checkAccess(undefined, feature, {})).status, 503);
    assert.equal((await checkAccess({ Authorization: 'Bearer paid' })).status, 503);
});
