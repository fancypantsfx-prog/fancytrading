import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    AutomationController,
    buildTemplate,
    parseParameters,
    validateParameter,
} from '../src/AppV2/Components/AutoTrading/automation.ts';

const strategy = {
    strategy_id: 'martingale',
    display_name: 'Martingale',
    supported_contract_types: ['CALL', 'PUT'],
    parameters: {
        type: 'object',
        required: ['multiplier'],
        additionalProperties: false,
        properties: {
            multiplier: { type: 'number', minimum: 1 },
            max_stake: { type: 'number', minimum: 0 },
            rounds: { type: 'integer', minimum: 1 },
            enabled: { type: 'boolean' },
        },
    },
};
const proposal = {
    proposal: 1,
    subscribe: 1,
    amount: 10,
    basis: 'stake',
    contract_type: 'CALL',
    underlying_symbol: 'R_100',
    currency: 'USD',
    duration: 5,
    duration_unit: 't',
};
const template = buildTemplate(proposal);
const run = {
    run_id: 'run-123',
    status: 'running',
    start_time: 123,
    strategy_id: 'martingale',
    strategy_parameters: { multiplier: 2 },
    contract_template: template,
    contracts: [],
    total_stake: 0,
    total_payout: 0,
};
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const setup = (handler = () => ({})) => {
    const requests = [];
    const states = [];
    const send = async (request) => {
        requests.push(request);
        if (request.auto_list_strategies) return { auto_list_strategies: { strategies: [strategy] } };
        if (request.auto_list) return { auto_list: { runs: [] } };
        return handler(request);
    };
    const controller = new AutomationController(send, (state) => states.push(state));
    return { controller, requests, states };
};

test('template preserves contract parameters and removes proposal/subscription fields', () => {
    assert.deepEqual(template, {
        amount: 10,
        basis: 'stake',
        contract_type: 'CALL',
        underlying_symbol: 'R_100',
        currency: 'USD',
        duration: 5,
        duration_unit: 't',
    });
});
test('digit zero barriers remain strings; dual barriers and selected tick are retained', () => {
    const result = buildTemplate({
        ...proposal,
        contract_type: 'DIGITMATCH',
        barrier: 0,
        barrier2: '-1',
        selected_tick: 2,
    });
    assert.equal(result.barrier, '0');
    assert.equal(result.barrier2, '-1');
    assert.equal(result.selected_tick, 2);
});
test('accumulator growth and multiplier limits are preserved', () => {
    assert.equal(
        buildTemplate({ ...proposal, contract_type: 'ACCU', growth_rate: 0.03, limit_order: { take_profit: 5 } })
            .growth_rate,
        0.03,
    );
    assert.deepEqual(
        buildTemplate({
            ...proposal,
            contract_type: 'MULTUP',
            multiplier: 100,
            limit_order: { take_profit: 10, stop_loss: 5 },
        }).limit_order,
        { take_profit: 10, stop_loss: 5 },
    );
});
for (const field of ['date_expiry', 'date_start', 'cancellation', 'payout_per_point'])
    test('rejects unsupported proposal field ' + field, () => {
        assert.throws(() => buildTemplate({ ...proposal, [field]: 123 }), /does not support/);
    });
for (const [key, value] of [
    ['amount', NaN],
    ['amount', -1],
    ['duration', 0],
    ['duration', 1.5],
    ['duration_unit', 'x'],
    ['currency', ''],
    ['underlying_symbol', 'bad symbol'],
    ['barrier', 'NaN'],
])
    test('rejects invalid template ' + key + '=' + value, () => {
        assert.throws(() => buildTemplate({ ...proposal, [key]: value }));
    });
test('rejects unsupported limit orders instead of dropping them', () =>
    assert.throws(() => buildTemplate({ ...proposal, limit_order: { take_profit: 5 } }), /limit orders/));
test('flat parameter schemas from the documentation are supported', () => {
    const flat = { ...strategy, parameters: { multiplier: { type: 'number' }, max_stake: { type: 'number' } } };
    assert.deepEqual(parseParameters(flat, { multiplier: '2', max_stake: '50' }), { multiplier: 2, max_stake: 50 });
});
test('required, integer, minimum, false and zero parameters validate correctly', () => {
    assert.deepEqual(parseParameters(strategy, { multiplier: '2', max_stake: '0', enabled: 'false' }), {
        multiplier: 2,
        max_stake: 0,
        enabled: false,
    });
    assert.throws(() => parseParameters(strategy, {}), /missing multiplier/);
    assert.throws(() => parseParameters(strategy, { multiplier: '0' }), /minimum/);
    assert.throws(() => parseParameters(strategy, { multiplier: '2', rounds: '1.5' }), /integer/);
    assert.throws(() => parseParameters(strategy, { multiplier: 'Infinity' }), /valid/);
});
test('nested object, array, strings and enums validate', () => {
    validateParameter(
        { list: [1, 2], label: 'ok', flag: false },
        {
            type: 'object',
            properties: {
                list: { type: 'array', items: { type: 'integer' } },
                label: { type: 'string', pattern: '^ok$' },
                flag: { enum: [true, false] },
            },
        },
    );
    assert.throws(() => validateParameter(['x'], { type: 'array', items: { type: 'number' } }));
    assert.throws(() => validateParameter('no', { type: 'string', enum: ['yes'] }));
});
test('refresh discovers strategies and existing runs before start', async () => {
    const { controller, requests } = setup();
    await controller.refresh();
    assert.equal(controller.state.ready, true);
    assert.deepEqual(requests, [{ auto_list_strategies: 1 }, { auto_list: 1 }]);
});
test('start sends exact documented request and records returned run', async () => {
    const { controller, requests } = setup(() => ({ auto_start: run }));
    await controller.refresh();
    await controller.start(strategy, template, { multiplier: 2 });
    assert.deepEqual(requests.at(-1), {
        auto_start: 1,
        strategy_id: 'martingale',
        contract_template: template,
        strategy_parameters: { multiplier: 2 },
    });
    assert.equal(controller.state.selected_id, run.run_id);
    assert.equal(controller.state.runs[0].status, 'running');
});
test('double start click sends only one purchase command', async () => {
    const pending = deferred();
    const { controller, requests } = setup(() => pending.promise);
    await controller.refresh();
    const first = controller.start(strategy, template, { multiplier: 2 });
    await controller.start(strategy, template, { multiplier: 2 });
    assert.equal(requests.filter((request) => request.auto_start).length, 1);
    pending.resolve({ auto_start: run });
    await first;
});
test('active runs and unsupported contracts prevent another start', async () => {
    const { controller } = setup(() => ({ auto_start: run }));
    await controller.refresh();
    await assert.rejects(
        controller.start(strategy, { ...template, contract_type: 'DIGITMATCH' }, { multiplier: 2 }),
        /does not support/,
    );
    await controller.start(strategy, template, { multiplier: 2 });
    await assert.rejects(controller.start(strategy, template, { multiplier: 2 }), /active run/);
});
test('pause, resume and stop use run id and update status', async () => {
    const { controller, requests } = setup((request) => {
        const endpoint = Object.keys(request)[0];
        return {
            [endpoint]: {
                ...run,
                status: endpoint === 'auto_pause' ? 'paused' : endpoint === 'auto_stop' ? 'stopped' : 'running',
            },
        };
    });
    await controller.refresh();
    await controller.start(strategy, template, { multiplier: 2 });
    for (const action of ['pause', 'resume', 'stop']) {
        await controller.control(action, run.run_id);
        assert.deepEqual(requests.at(-1), { ['auto_' + action]: 1, run_id: run.run_id });
    }
    assert.equal(controller.state.runs[0].status, 'stopped');
    await assert.rejects(controller.control('resume', run.run_id));
});
test('API error locks start until reconciliation and does not retry command', async () => {
    const { controller, requests } = setup(() => ({ error: { message: 'Unsupported endpoint' } }));
    await controller.refresh();
    await controller.start(strategy, template, { multiplier: 2 });
    assert.equal(controller.state.uncertain, true);
    assert.match(controller.state.error, /Unsupported endpoint/);
    await assert.rejects(controller.start(strategy, template, { multiplier: 2 }));
    assert.equal(requests.filter((request) => request.auto_start).length, 1);
    await controller.refresh();
    assert.equal(controller.state.uncertain, false);
});
test('malformed response cannot enable starting or crash refresh', async () => {
    const controller = new AutomationController(
        async () => ({}),
        () => {},
    );
    await controller.refresh();
    assert.equal(controller.state.ready, false);
    assert.match(controller.state.error, /Missing/);
});
test('unmounted/account-switched controller ignores late responses', async () => {
    const pending = deferred();
    const { controller, states } = setup(() => pending.promise);
    await controller.refresh();
    const start = controller.start(strategy, template, { multiplier: 2 });
    controller.dispose();
    const count = states.length;
    pending.resolve({ auto_start: run });
    await start;
    assert.equal(states.length, count);
});
test('poll requests auto_get and never retries auto_start', async () => {
    const { controller, requests } = setup((request) =>
        request.auto_start
            ? { auto_start: run }
            : {
                  auto_get: {
                      ...run,
                      total_stake: 10,
                      total_payout: 18,
                      contracts: [
                          {
                              contract_id: 42,
                              buy_price: 10,
                              sell_price: 18,
                              purchase_time: 123,
                              contract_status: 'won',
                          },
                      ],
                  },
              },
    );
    await controller.refresh();
    await controller.start(strategy, template, { multiplier: 2 });
    // Simulate a server list which includes the active run.
    const original = controller.state.runs;
    // A separate controller allows controlling list/get responses without mutating production state.
    const monitoring = new AutomationController(
        async (request) => {
            requests.push(request);
            if (request.auto_list_strategies) return { auto_list_strategies: { strategies: [strategy] } };
            if (request.auto_list) return { auto_list: { runs: original } };
            return { auto_get: { ...run, total_stake: 10, total_payout: 18 } };
        },
        () => {},
    );
    await monitoring.refresh();
    await monitoring.poll();
    assert.equal(monitoring.state.runs[0].total_payout, 18);
    assert.ok(requests.some((request) => request.auto_get === 1 && request.run_id === run.run_id));
    assert.equal(requests.filter((request) => request.auto_start).length, 1);
});
test('a stale poll cannot overwrite a newer pause response', async () => {
    const pending = deferred();
    let delay = false;
    const controller = new AutomationController(
        async (request) => {
            if (request.auto_list_strategies) return { auto_list_strategies: { strategies: [strategy] } };
            if (request.auto_list) return delay ? pending.promise : { auto_list: { runs: [run] } };
            if (request.auto_get) return { auto_get: run };
            if (request.auto_pause) return { auto_pause: { ...run, status: 'paused' } };
            return {};
        },
        () => {},
    );
    await controller.refresh();
    delay = true;
    const poll = controller.poll();
    await controller.control('pause', run.run_id);
    pending.resolve({ auto_list: { runs: [run] } });
    await poll;
    assert.equal(controller.state.runs[0].status, 'paused');
});

test('timed-out start is not replayed and requires reconciliation', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred();
    const { controller, requests } = setup(() => pending.promise);
    await controller.refresh();
    const start = controller.start(strategy, template, { multiplier: 2 });
    context.mock.timers.tick(15001);
    await start;
    assert.equal(controller.state.uncertain, true);
    assert.match(controller.state.error, /timed out/);
    assert.equal(requests.filter((request) => request.auto_start).length, 1);
    pending.resolve({ auto_start: run });
    await Promise.resolve();
    assert.equal(controller.state.uncertain, true);
});
test('reconnect/reload restores a server run without starting another', async () => {
    const requests = [];
    const controller = new AutomationController(
        async (request) => {
            requests.push(request);
            return request.auto_list
                ? { auto_list: { runs: [{ ...run, status: 'paused' }] } }
                : { auto_list_strategies: { strategies: [strategy] } };
        },
        () => {},
    );
    await controller.refresh();
    assert.equal(controller.state.selected_id, run.run_id);
    assert.equal(controller.state.runs[0].status, 'paused');
    assert.equal(
        requests.some((request) => request.auto_start),
        false,
    );
});
test('a failed monitoring read disables new starts until refreshed', async () => {
    let broken = false;
    const controller = new AutomationController(
        async (request) => {
            if (broken) throw new Error('Socket unavailable');
            return request.auto_list
                ? { auto_list: { runs: [] } }
                : { auto_list_strategies: { strategies: [strategy] } };
        },
        () => {},
    );
    await controller.refresh();
    broken = true;
    await controller.poll();
    assert.equal(controller.state.ready, false);
    await assert.rejects(controller.start(strategy, template, { multiplier: 2 }));
    broken = false;
    await controller.refresh();
    assert.equal(controller.state.ready, true);
});
