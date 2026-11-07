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
        0.03
    );
    assert.deepEqual(
        buildTemplate({
            ...proposal,
            contract_type: 'MULTUP',
            multiplier: 100,
            limit_order: { take_profit: 10, stop_loss: 5 },
        }).limit_order,
        { take_profit: 10, stop_loss: 5 }
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
        }
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
        /does not support/
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
test('an explicit API rejection permits a corrected manual retry but is never replayed automatically', async () => {
    const { controller, requests } = setup(() => ({ error: { message: 'Unsupported endpoint' } }));
    await controller.refresh(); await controller.start(strategy, template, { multiplier: 2 });
    assert.equal(controller.state.uncertain, false); assert.match(controller.state.error, /Unsupported endpoint/);
    assert.equal(requests.filter(request => request.auto_start).length, 1);
    await controller.start(strategy, template, { multiplier: 2 });
    assert.equal(requests.filter(request => request.auto_start).length, 2);
});

test('malformed response cannot enable starting or crash refresh', async () => {
    const controller = new AutomationController(
        async () => ({}),
        () => {}
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
              }
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
        () => {}
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
        () => {}
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
        () => {}
    );
    await controller.refresh();
    assert.equal(controller.state.selected_id, run.run_id);
    assert.equal(controller.state.runs[0].status, 'paused');
    assert.equal(
        requests.some((request) => request.auto_start),
        false
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
        () => {}
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

const { getRunParameterSchema, getSharedContractType, validateRunParameters, riskFieldInfo } =
    await import('../src/AppV2/Components/AutoTrading/automation.ts');
test('documented run limits augment an open strategy schema', () => {
    const open = { ...strategy, parameters: { multiplier: { type: 'number' }, max_stake: { type: 'number' } } };
    assert.deepEqual(parseParameters(open, { multiplier: '2', take_profit: '20', stop_loss: '10' }), {
        multiplier: 2,
        take_profit: 20,
        stop_loss: 10,
    });
    validateRunParameters(open, template, { multiplier: 2, take_profit: 20, stop_loss: 10 });
});
test('closed advertised schemas do not gain unsupported risk fields', () => {
    assert.equal(getRunParameterSchema(strategy).properties.take_profit, undefined);
    assert.throws(
        () => validateRunParameters(strategy, template, { multiplier: 2, take_profit: 20 }),
        /unknown parameter/
    );
});
test('zero and negative run protection values are rejected; blanks are off', () => {
    const open = { ...strategy, parameters: { multiplier: { type: 'number' } } };
    assert.throws(() => parseParameters(open, { take_profit: '0' }));
    assert.throws(() => parseParameters(open, { stop_loss: '-1' }));
    assert.deepEqual(parseParameters(open, { take_profit: '', stop_loss: '' }), {});
});
test('maximum stake cannot be smaller than the shared initial stake', () => {
    assert.throws(() => validateRunParameters(strategy, template, { multiplier: 2, max_stake: 5 }), /initial stake/);
    assert.doesNotThrow(() => validateRunParameters(strategy, template, { multiplier: 2, max_stake: 10 }));
});
test('1x keeps stakes fixed while values below 1 are rejected', () => {
    assert.doesNotThrow(() => validateRunParameters(strategy, template, { multiplier: 1 }));
    assert.throws(() => validateRunParameters(strategy, template, { multiplier: 0.5 }));
});
test('only the selected shared direction is used; ambiguous directions are not guessed', () => {
    assert.equal(getSharedContractType(['CALL', 'PUT'], 'PUT'), 'PUT');
    assert.equal(getSharedContractType(['CALL', 'PUT'], ''), '');
    assert.equal(getSharedContractType(['ACCU'], ''), 'ACCU');
    assert.equal(getSharedContractType([], 'CALL'), '');
});
test('stake lists accept comma-separated amounts and preserve the manual initial stake', () => {
    const listStrategy = {
        ...strategy,
        strategy_id: 'stake_list',
        parameters: { stake_list: { type: 'array', items: { type: 'number' } }, max_stake: { type: 'number' } },
    };
    const parameters = parseParameters(listStrategy, { stake_list: '10, 20, 40', max_stake: '40' });
    assert.deepEqual(parameters.stake_list, [10, 20, 40]);
    assert.doesNotThrow(() => validateRunParameters(listStrategy, template, parameters));
    assert.throws(() => validateRunParameters(listStrategy, template, { stake_list: [5, 20] }), /first stake/);
    assert.throws(
        () => validateRunParameters(listStrategy, template, { stake_list: [10, 50], max_stake: 40 }),
        /maximum stake/
    );
    assert.throws(() => validateRunParameters(listStrategy, template, { stake_list: [10, 0] }), /positive amounts/);
});
test('cooldown and recovery settings are grouped without inventing request keys', () => {
    assert.equal(riskFieldInfo('cooldown_after_losses').group, 'cooldown');
    assert.equal(riskFieldInfo('stop_after_max_martingale_level').group, 'recovery');
    assert.equal(riskFieldInfo('unadvertised_custom_parameter').group, 'advanced');
});
test('starting sends shared template and run protection together', async () => {
    const open = { ...strategy, parameters: { multiplier: { type: 'number' } } };
    const { controller, requests } = setup(() => ({ auto_start: run }));
    await controller.refresh();
    await controller.start(open, template, { multiplier: 2, take_profit: 30, stop_loss: 20 });
    assert.deepEqual(requests.at(-1).contract_template, template);
    assert.deepEqual(requests.at(-1).strategy_parameters, { multiplier: 2, take_profit: 30, stop_loss: 20 });
});

const { getFixedStakeStrategy, getMethodValues, supportsFixedMultiplier } =
    await import('../src/AppV2/Components/AutoTrading/automation.ts');
test('fixed stake prefers an actual fixed-stake server strategy', () => {
    const fixed = { ...strategy, strategy_id: 'fixed_stake', parameters: {} };
    assert.equal(getFixedStakeStrategy([strategy, fixed]).strategy_id, 'fixed_stake');
});
test('no martingale uses exactly 1x and removes hidden recovery settings', () => {
    const open = { ...strategy, parameters: { multiplier: { type: 'number' }, max_levels: { type: 'integer' } } };
    assert.deepEqual(
        getMethodValues(open, { multiplier: '2', max_levels: '3', take_profit: '30', stop_loss: '20' }, true),
        { multiplier: '1', take_profit: '30', stop_loss: '20' }
    );
    validateRunParameters(open, template, { multiplier: 1, take_profit: 30, stop_loss: 20 });
});
test('a strategy requiring multiplier greater than one cannot pretend to be fixed stake', () => {
    const strict = { ...strategy, parameters: { multiplier: { type: 'number', minimum: 1.1 } } };
    assert.equal(supportsFixedMultiplier(strict), false);
    assert.equal(getFixedStakeStrategy([strict]), undefined);
    assert.throws(() => getMethodValues(strict, {}, true), /not available/);
});
test('required recovery controls do not disappear behind fixed stake', () => {
    const strict = {
        ...strategy,
        parameters: {
            type: 'object',
            required: ['max_levels'],
            properties: { multiplier: { type: 'number' }, max_levels: { type: 'integer' } },
        },
    };
    assert.equal(supportsFixedMultiplier(strict), false);
});

const { validateEnabledLimits, numericStep, stepNumber } =
    await import('../src/AppV2/Components/AutoTrading/automation.ts');
test('take profit and stop loss remain optional even when listed among strategy requirements', () => {
    const limits = {
        ...strategy,
        parameters: {
            type: 'object',
            required: ['multiplier', 'take_profit', 'stop_loss'],
            properties: {
                multiplier: { type: 'number' },
                take_profit: { type: 'number' },
                stop_loss: { type: 'number' },
            },
        },
    };
    assert.deepEqual(parseParameters(limits, { multiplier: '2' }), { multiplier: 2 });
});
test('only explicitly enabled blank limits require an amount', () => {
    assert.doesNotThrow(() => validateEnabledLimits({}));
    assert.throws(() => validateEnabledLimits({ take_profit: '' }), /switch it off/);
    assert.throws(() => validateEnabledLimits({ stop_loss: ' ' }), /switch it off/);
    assert.doesNotThrow(() => validateEnabledLimits({ take_profit: '10' }));
});
test('strategy initial stake always inherits Manual and ignores a stale entered amount', () => {
    const inherited = {
        ...strategy,
        parameters: { type: 'object', required: ['initial_stake'], properties: { initial_stake: { type: 'number' } } },
    };
    assert.deepEqual(parseParameters(inherited, { initial_stake: '999' }, template), { initial_stake: 10 });
    assert.deepEqual(parseParameters(inherited, {}, { ...template, amount: 25 }), { initial_stake: 25 });
});
test('recovery list prepends the current manual stake without entering it twice', () => {
    const listed = {
        ...strategy,
        strategy_id: 'stake_list',
        parameters: { stake_list: { type: 'array', items: { type: 'number' } } },
    };
    assert.deepEqual(parseParameters(listed, { stake_list: '20,40' }, template), { stake_list: [10, 20, 40] });
    assert.deepEqual(parseParameters(listed, {}, template), { stake_list: [10] });
    assert.deepEqual(parseParameters(listed, { stake_list: '20,40' }, { ...template, amount: 15 }), {
        stake_list: [15, 20, 40],
    });
});
test('shared stake parameters cannot mistake payout amount for initial stake', () => {
    const inherited = { ...strategy, parameters: { initial_stake: { type: 'number' } } };
    assert.throws(() => parseParameters(inherited, {}, { ...template, basis: 'payout' }), /manual trading form/);
});
test('numeric steps distinguish integer, money and multipliers', () => {
    assert.equal(numericStep('max_levels', { type: 'integer' }), 1);
    assert.equal(numericStep('take_profit', { type: 'number' }), 0.01);
    assert.equal(numericStep('multiplier', { type: 'number' }), 0.1);
    assert.equal(numericStep('custom', { type: 'number', multipleOf: 0.25 }), 0.25);
});
test('numeric adjustment preserves decimals and respects both bounds', () => {
    assert.equal(stepNumber('0.2', 1, 0.1), '0.3');
    assert.equal(stepNumber('1', -1, 1, 1, 5), '1');
    assert.equal(stepNumber('5', 1, 1, 1, 5), '5');
    assert.equal(stepNumber('', 1, 0.01, 0.01), '0.01');
});

test('live decimal-string initial_stake inherits Manual as text rather than failing validation', () => {
    const live = {
        ...strategy,
        parameters: {
            type: 'object',
            required: ['initial_stake'],
            properties: { initial_stake: { type: 'string', pattern: '^[0-9]+([.][0-9]+)?$' } },
        },
    };
    const manual = { ...template, amount: 5 };
    assert.deepEqual(parseParameters(live, {}, manual), { initial_stake: '5' });
    assert.deepEqual(parseParameters(live, {}, { ...manual, amount: 5.25 }), { initial_stake: '5.25' });
    assert.equal(manual.amount, 5);
});
test('shared stake aliases respect their own string, number or integer types', () => {
    const mixed = {
        ...strategy,
        parameters: {
            initial_stake: { type: 'string' },
            base_stake: { type: 'number' },
            starting_stake: { type: 'integer' },
        },
    };
    assert.deepEqual(parseParameters(mixed, { initial_stake: '999' }, { ...template, amount: 5 }), {
        initial_stake: '5',
        base_stake: 5,
        starting_stake: 5,
    });
    assert.throws(() => parseParameters(mixed, {}, { ...template, amount: 5.25 }), /integer/);
});
test('auto_start accepts the live string stake while keeping contract amount numeric', async () => {
    const live = { ...strategy, parameters: { initial_stake: { type: 'string' }, multiplier: { type: 'number' } } };
    const manual = { ...template, amount: 5 };
    const { controller, requests } = setup(() => ({ auto_start: run }));
    await controller.refresh();
    const parameters = parseParameters(live, { multiplier: '2' }, manual);
    await controller.start(live, manual, parameters);
    assert.deepEqual(requests.at(-1).strategy_parameters, { initial_stake: '5', multiplier: 2 });
    assert.equal(requests.at(-1).contract_template.amount, 5);
});

const { validateAutomaticStake, hasRunStopLoss } = await import('../src/AppV2/Components/AutoTrading/automation.ts');
test('automatic stake rejects the zero, blank and nonfinite inputs that cannot be traded', () => {
    for (const value of ['', ' ', '0', '-1', 'Infinity', 'NaN', '5abc'])
        assert.throws(() => validateAutomaticStake(value), /greater than 0/);
    assert.equal(validateAutomaticStake('5.25'), 5.25);
});
test('only a positive run stop loss avoids the confirmation', () => {
    for (const stop_loss of [undefined, null, '', '0', 0, -1, NaN, Infinity, true])
        assert.equal(hasRunStopLoss({ stop_loss }), false);
    assert.equal(hasRunStopLoss({ stop_loss: 20 }), true);
    assert.equal(hasRunStopLoss({ stop_loss: '20.5' }), true);
});
test('server validation failures retain the rejected field instead of a bare message', async () => {
    const { controller } = setup(() => ({
        error: { message: 'must be > 0', details: { field: 'strategy_parameters.initial_stake' } },
    }));
    await controller.refresh();
    await controller.start(strategy, template, { multiplier: 2 });
    assert.match(controller.state.error, /strategy_parameters.initial_stake: must be > 0/);
});

test('decimal-string monetary limits retain API types while enforcing positive amounts', () => {
    const money = { ...strategy, parameters: { initial_stake: { type: 'string' }, max_stake: { type: 'string' }, stop_loss: { type: 'string' }, take_profit: { type: 'string' } } };
    const parameters = parseParameters(money, { max_stake: '40.00', stop_loss: '20.00', take_profit: '30.00' }, template);
    assert.deepEqual(parameters, { initial_stake: '10', max_stake: '40.00', stop_loss: '20.00', take_profit: '30.00' });
    assert.doesNotThrow(() => validateRunParameters(money, template, parameters));
    assert.equal(hasRunStopLoss(parameters), true);
    assert.throws(() => validateRunParameters(money, template, { ...parameters, stop_loss: '0.00' }), /greater than zero/);
    assert.throws(() => validateRunParameters(money, template, { ...parameters, max_stake: '5.00' }), /initial stake/);
});
