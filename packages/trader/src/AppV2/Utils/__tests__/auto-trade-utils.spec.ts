import type { TAutoRun, TAutoStrategy } from '@deriv/api';

import {
    buildContractTemplate,
    buildStrategyParameters,
    EMPTY_TEMPLATE_FORM,
    extractRun,
    getRunStats,
    getTemplateFieldFlags,
    isRunActive,
} from '../auto-trade-utils';

const valid_form = {
    ...EMPTY_TEMPLATE_FORM,
    underlying_symbol: 'R_100',
    contract_type: 'CALL',
    currency: 'USD',
    amount: '10',
    duration: '1',
    duration_unit: 'm' as const,
};

describe('auto-trade-utils', () => {
    describe('buildContractTemplate', () => {
        it('builds the template shown in the documentation example', () => {
            const { template, errors } = buildContractTemplate(valid_form);
            expect(errors).toEqual({});
            expect(template).toEqual({
                amount: 10,
                basis: 'stake',
                contract_type: 'CALL',
                currency: 'USD',
                duration: 1,
                duration_unit: 'm',
                underlying_symbol: 'R_100',
            });
        });

        it('reports missing / invalid fields', () => {
            const { template, errors } = buildContractTemplate({ ...EMPTY_TEMPLATE_FORM });
            expect(template).toBeUndefined();
            expect(Object.keys(errors)).toEqual(
                expect.arrayContaining(['underlying_symbol', 'contract_type', 'currency', 'amount'])
            );
        });

        it('rejects a non-integer duration and a malformed barrier', () => {
            const { errors } = buildContractTemplate({
                ...valid_form,
                contract_type: 'HIGHER',
                duration: '1.5',
                barrier: 'abc',
            });
            expect(errors.duration).toBeDefined();
            expect(errors.barrier).toBeDefined();
        });

        it('requires a barrier (last digit) for digit contracts', () => {
            const { errors } = buildContractTemplate({ ...valid_form, contract_type: 'DIGITMATCH' });
            expect(errors.barrier).toBeDefined();
            const ok = buildContractTemplate({ ...valid_form, contract_type: 'DIGITMATCH', barrier: '5' });
            expect(ok.template?.barrier).toBe('5');
        });

        it('does not send a duration for multipliers and sends limit_order', () => {
            const { template, errors } = buildContractTemplate({
                ...valid_form,
                contract_type: 'MULTUP',
                multiplier: '50',
                take_profit: '5',
                stop_loss: '3',
            });
            expect(errors).toEqual({});
            expect(template?.duration).toBeUndefined();
            expect(template?.multiplier).toBe(50);
            expect(template?.limit_order).toEqual({ take_profit: 5, stop_loss: 3 });
        });

        it('requires a growth rate for accumulators', () => {
            expect(buildContractTemplate({ ...valid_form, contract_type: 'ACCU' }).errors.growth_rate).toBeDefined();
            expect(
                buildContractTemplate({ ...valid_form, contract_type: 'ACCU', growth_rate: '0.03' }).template
                    ?.growth_rate
            ).toBe(0.03);
        });
    });

    describe('getTemplateFieldFlags', () => {
        it('flags the right fields per contract type', () => {
            expect(getTemplateFieldFlags('ACCU')).toMatchObject({ needs_duration: false, needs_growth_rate: true });
            expect(getTemplateFieldFlags('RANGE')).toMatchObject({ needs_barrier: true, needs_barrier2: true });
            expect(getTemplateFieldFlags('TICKHIGH').needs_selected_tick).toBe(true);
            expect(getTemplateFieldFlags('CALL').needs_barrier).toBe(false);
        });
    });

    describe('buildStrategyParameters', () => {
        const martingale: TAutoStrategy = {
            strategy_id: 'martingale',
            display_name: 'Martingale',
            parameters: { multiplier: { type: 'number' }, max_stake: { type: 'number' } },
            supported_contract_types: ['CALL', 'PUT'],
        };

        it('parses numeric params and optional run limits', () => {
            const { parameters, errors } = buildStrategyParameters(martingale, {
                multiplier: '2',
                max_stake: '40',
                stop_loss: '50',
                take_profit: '100',
            });
            expect(errors).toEqual({});
            expect(parameters).toEqual({ multiplier: 2, max_stake: 40, stop_loss: 50, take_profit: 100 });
        });

        it('omits blank optional values and flags invalid ones', () => {
            const { parameters, errors } = buildStrategyParameters(martingale, { multiplier: 'x', max_stake: '' });
            expect(errors.multiplier).toBeDefined();
            expect(parameters).toEqual({});
        });

        it('asks for a strategy when none is selected', () => {
            expect(buildStrategyParameters(undefined, {}).errors.strategy_id).toBeDefined();
        });
    });

    describe('run helpers', () => {
        const run: TAutoRun = {
            run_id: 'atr_1',
            status: 'running',
            strategy_id: 'martingale',
            strategy_parameters: {},
            contract_template: {},
            start_time: 1,
            contracts: [
                { contract_id: 1, buy_price: 10, purchase_time: 1, contract_status: 'lost', sell_price: 0 },
                { contract_id: 2, buy_price: 20, purchase_time: 2, contract_status: 'won', sell_price: 39 },
                { contract_id: 3, buy_price: 10, purchase_time: 3, contract_status: 'open' },
            ],
            total_stake: 40,
            total_payout: 39,
        };

        it('computes stats from settled contracts only', () => {
            expect(getRunStats(run)).toMatchObject({ total: 3, open: 1, wins: 1, losses: 1, profit: 9 });
        });

        it('knows when a run is active', () => {
            expect(isRunActive(run)).toBe(true);
            expect(isRunActive({ status: 'paused' })).toBe(true);
            expect(isRunActive({ status: 'stopped' })).toBe(false);
            expect(isRunActive(undefined)).toBe(false);
        });

        it('extracts the run from any auto_* response', () => {
            expect(extractRun({ auto_stop: run })).toBe(run);
            expect(extractRun({ auto_get: run, subscription: { id: 'x' } })).toBe(run);
            expect(extractRun({})).toBeUndefined();
        });
    });
});
