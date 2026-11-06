import type {
    TAutoContract,
    TAutoContractTemplate,
    TAutoContractType,
    TAutoDurationUnit,
    TAutoRun,
    TAutoStopReason,
    TAutoStrategy,
    TAutoStrategyParameters,
} from '@deriv/api';

/* -------------------------------------------------------------------------- */
/*  Constants (taken from the Automation API documentation)                     */
/* -------------------------------------------------------------------------- */

export const BARRIER_PATTERN = /^(?=.{1,20}$)[+-]?[0-9]+\.?[0-9]*$/;
export const SYMBOL_PATTERN = /^\w{2,30}$/;
export const CURRENCY_PATTERN = /^[a-zA-Z0-9]{2,20}$/;
export const STRATEGY_ID_PATTERN = /^\w{1,64}$/;
export const MAX_DURATION = 99999999;

export const DURATION_UNITS: { value: TAutoDurationUnit; label: string }[] = [
    { value: 't', label: 'Ticks' },
    { value: 's', label: 'Seconds' },
    { value: 'm', label: 'Minutes' },
    { value: 'h', label: 'Hours' },
    { value: 'd', label: 'Days' },
];

const NO_DURATION_TYPES: TAutoContractType[] = ['ACCU', 'MULTUP', 'MULTDOWN'];
const LIMIT_ORDER_TYPES: TAutoContractType[] = ['ACCU', 'MULTUP', 'MULTDOWN'];
const MULTIPLIER_TYPES: TAutoContractType[] = ['MULTUP', 'MULTDOWN'];
const TICK_SELECTION_TYPES: TAutoContractType[] = ['TICKHIGH', 'TICKLOW'];
const DIGIT_BARRIER_TYPES: TAutoContractType[] = ['DIGITDIFF', 'DIGITMATCH', 'DIGITOVER', 'DIGITUNDER'];
const BARRIER_TYPES: TAutoContractType[] = [
    ...DIGIT_BARRIER_TYPES,
    'HIGHER',
    'LOWER',
    'ONETOUCH',
    'NOTOUCH',
    'VANILLALONGCALL',
    'VANILLALONGPUT',
    'TURBOSLONG',
    'TURBOSSHORT',
];
const TWO_BARRIER_TYPES: TAutoContractType[] = ['EXPIRYMISS', 'EXPIRYMISSE', 'EXPIRYRANGE', 'EXPIRYRANGEE', 'RANGE', 'UPORDOWN'];

/** Human readable names for the contract types the API accepts. */
export const CONTRACT_TYPE_LABELS: Record<TAutoContractType, string> = {
    HIGHER: 'Higher',
    LOWER: 'Lower',
    ACCU: 'Accumulator',
    ASIAND: 'Asian Down',
    ASIANU: 'Asian Up',
    CALL: 'Rise',
    CALLE: 'Rise (or equal)',
    DIGITDIFF: 'Digits Differs',
    DIGITEVEN: 'Digits Even',
    DIGITMATCH: 'Digits Matches',
    DIGITODD: 'Digits Odd',
    DIGITOVER: 'Digits Over',
    DIGITUNDER: 'Digits Under',
    EXPIRYMISS: 'Ends Outside',
    EXPIRYMISSE: 'Ends Outside (or equal)',
    EXPIRYRANGE: 'Ends Between',
    EXPIRYRANGEE: 'Ends Between (or equal)',
    MULTDOWN: 'Multiplier Down',
    MULTUP: 'Multiplier Up',
    NOTOUCH: 'No Touch',
    ONETOUCH: 'Touch',
    PUT: 'Fall',
    PUTE: 'Fall (or equal)',
    RANGE: 'Stays Between',
    RESETCALL: 'Reset Call',
    RESETPUT: 'Reset Put',
    RUNHIGH: 'Only Ups',
    RUNLOW: 'Only Downs',
    TICKHIGH: 'High Tick',
    TICKLOW: 'Low Tick',
    TURBOSLONG: 'Turbo Long',
    TURBOSSHORT: 'Turbo Short',
    UPORDOWN: 'Goes Outside',
    VANILLALONGCALL: 'Vanilla Call',
    VANILLALONGPUT: 'Vanilla Put',
};

/* -------------------------------------------------------------------------- */
/*  Which template fields a contract type needs                                */
/* -------------------------------------------------------------------------- */

export type TTemplateFieldFlags = {
    needs_duration: boolean;
    needs_barrier: boolean;
    barrier_is_required: boolean;
    needs_barrier2: boolean;
    needs_growth_rate: boolean;
    needs_multiplier: boolean;
    needs_selected_tick: boolean;
    needs_limit_order: boolean;
};

export const getTemplateFieldFlags = (contract_type: string): TTemplateFieldFlags => {
    const type = contract_type as TAutoContractType;
    return {
        needs_duration: !NO_DURATION_TYPES.includes(type),
        needs_barrier: BARRIER_TYPES.includes(type) || TWO_BARRIER_TYPES.includes(type),
        barrier_is_required: DIGIT_BARRIER_TYPES.includes(type),
        needs_barrier2: TWO_BARRIER_TYPES.includes(type),
        needs_growth_rate: type === 'ACCU',
        needs_multiplier: MULTIPLIER_TYPES.includes(type),
        needs_selected_tick: TICK_SELECTION_TYPES.includes(type),
        needs_limit_order: LIMIT_ORDER_TYPES.includes(type),
    };
};

/* -------------------------------------------------------------------------- */
/*  Form state -> API payload                                                  */
/* -------------------------------------------------------------------------- */

/** Everything the form keeps as raw strings (inputs are strings). */
export type TTemplateFormValues = {
    underlying_symbol: string;
    contract_type: string;
    currency: string;
    basis: 'stake' | 'payout';
    amount: string;
    duration: string;
    duration_unit: TAutoDurationUnit;
    barrier: string;
    barrier2: string;
    growth_rate: string;
    multiplier: string;
    selected_tick: string;
    take_profit: string;
    stop_loss: string;
};

export const EMPTY_TEMPLATE_FORM: TTemplateFormValues = {
    underlying_symbol: '',
    contract_type: '',
    currency: '',
    basis: 'stake',
    amount: '',
    duration: '',
    duration_unit: 't',
    barrier: '',
    barrier2: '',
    growth_rate: '',
    multiplier: '',
    selected_tick: '',
    take_profit: '',
    stop_loss: '',
};

const isBlank = (value: string | undefined) => value === undefined || value.trim() === '';
const toNumber = (value: string) => Number(value.trim());

export type TFormErrors = Record<string, string>;

/**
 * Validates the form against the rules in the documentation and, when valid,
 * returns the `contract_template` object for `auto_start`.
 */
export const buildContractTemplate = (
    values: TTemplateFormValues
): { template?: TAutoContractTemplate; errors: TFormErrors } => {
    const errors: TFormErrors = {};
    const flags = getTemplateFieldFlags(values.contract_type);

    if (!SYMBOL_PATTERN.test(values.underlying_symbol.trim())) errors.underlying_symbol = 'Enter a valid market symbol.';
    if (isBlank(values.contract_type)) errors.contract_type = 'Select a contract type.';
    if (!CURRENCY_PATTERN.test(values.currency.trim())) errors.currency = 'Currency is missing for this account.';

    const amount = toNumber(values.amount);
    if (isBlank(values.amount) || !Number.isFinite(amount) || amount <= 0) {
        errors.amount = 'Enter an amount greater than 0.';
    }

    let duration: number | undefined;
    if (flags.needs_duration) {
        duration = toNumber(values.duration);
        if (isBlank(values.duration) || !Number.isInteger(duration) || duration < 0 || duration > MAX_DURATION) {
            errors.duration = `Enter a whole number between 0 and ${MAX_DURATION}.`;
        }
    }

    if (flags.needs_barrier && !isBlank(values.barrier) && !BARRIER_PATTERN.test(values.barrier.trim())) {
        errors.barrier = 'Enter a valid barrier (for example 0.5, +0.5 or -10).';
    }
    if (flags.barrier_is_required && isBlank(values.barrier)) errors.barrier = 'This contract type needs a barrier.';

    if (flags.needs_barrier2 && !isBlank(values.barrier2) && !BARRIER_PATTERN.test(values.barrier2.trim())) {
        errors.barrier2 = 'Enter a valid low barrier.';
    }
    if (flags.needs_barrier2 && isBlank(values.barrier2)) errors.barrier2 = 'This contract type needs a low barrier.';

    if (flags.needs_growth_rate) {
        const growth_rate = toNumber(values.growth_rate);
        if (isBlank(values.growth_rate) || !Number.isFinite(growth_rate) || growth_rate <= 0) {
            errors.growth_rate = 'Enter a growth rate greater than 0 (for example 0.01).';
        }
    }

    if (flags.needs_multiplier) {
        const multiplier = toNumber(values.multiplier);
        if (isBlank(values.multiplier) || !Number.isFinite(multiplier) || multiplier <= 0) {
            errors.multiplier = 'Enter a multiplier greater than 0.';
        }
    }

    if (flags.needs_selected_tick) {
        const tick = toNumber(values.selected_tick);
        if (isBlank(values.selected_tick) || !Number.isInteger(tick) || tick < 1) {
            errors.selected_tick = 'Enter the tick number you are predicting (1 or more).';
        }
    }

    const limit_order: { take_profit?: number; stop_loss?: number } = {};
    if (flags.needs_limit_order) {
        if (!isBlank(values.take_profit)) {
            const tp = toNumber(values.take_profit);
            if (!Number.isFinite(tp) || tp <= 0) errors.take_profit = 'Take profit must be greater than 0.';
            else limit_order.take_profit = tp;
        }
        if (!isBlank(values.stop_loss) && values.contract_type !== 'ACCU') {
            const sl = toNumber(values.stop_loss);
            if (!Number.isFinite(sl) || sl <= 0) errors.stop_loss = 'Stop loss must be greater than 0.';
            else limit_order.stop_loss = sl;
        }
    }

    if (Object.keys(errors).length) return { errors };

    const template: TAutoContractTemplate = {
        amount,
        basis: values.basis,
        contract_type: values.contract_type as TAutoContractType,
        currency: values.currency.trim(),
        underlying_symbol: values.underlying_symbol.trim(),
    };

    if (flags.needs_duration && duration !== undefined) {
        template.duration = duration;
        template.duration_unit = values.duration_unit;
    }
    if (flags.needs_barrier && !isBlank(values.barrier)) template.barrier = values.barrier.trim();
    if (flags.needs_barrier2) template.barrier2 = values.barrier2.trim();
    if (flags.needs_growth_rate) template.growth_rate = toNumber(values.growth_rate);
    if (flags.needs_multiplier) template.multiplier = toNumber(values.multiplier);
    if (flags.needs_selected_tick) template.selected_tick = toNumber(values.selected_tick);
    if (Object.keys(limit_order).length) template.limit_order = limit_order;

    return { template, errors };
};

/* -------------------------------------------------------------------------- */
/*  Strategy parameters (schema driven)                                        */
/* -------------------------------------------------------------------------- */

export type TStrategyParamInputType = 'number' | 'integer' | 'boolean' | 'string';

export const getParamInputType = (schema?: { type?: string }): TStrategyParamInputType => {
    switch (schema?.type) {
        case 'number':
            return 'number';
        case 'integer':
            return 'integer';
        case 'boolean':
            return 'boolean';
        default:
            return 'string';
    }
};

/** "max_stake" -> "Max stake" */
export const humanizeKey = (key: string) => {
    const text = key.replace(/_/g, ' ').trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
};

/**
 * Optional run level limits. The `auto_start` example in the documentation sends
 * `stop_loss` and `take_profit` inside `strategy_parameters`, even though the
 * `auto_list_strategies` example schema does not list them. We expose them as
 * optional inputs and only send them when the user fills them in.
 */
export const RUN_LIMIT_KEYS = ['stop_loss', 'take_profit'] as const;

export const buildStrategyParameters = (
    strategy: TAutoStrategy | undefined,
    raw: Record<string, string>
): { parameters?: TAutoStrategyParameters; errors: TFormErrors } => {
    const errors: TFormErrors = {};
    const parameters: TAutoStrategyParameters = {};
    if (!strategy) return { errors: { strategy_id: 'Select a strategy.' } };

    const schema_entries = Object.entries(strategy.parameters ?? {});
    const run_limits = RUN_LIMIT_KEYS.filter(key => !(key in (strategy.parameters ?? {})));

    const entries: [string, { type?: string }][] = [
        ...schema_entries,
        ...run_limits.map(key => [key, { type: 'number' }] as [string, { type?: string }]),
    ];

    entries.forEach(([key, schema]) => {
        const value = raw[key];
        const type = getParamInputType(schema);

        if (type === 'boolean') {
            if (value === 'true') parameters[key] = true;
            else if (value === 'false') parameters[key] = false;
            return;
        }
        if (isBlank(value)) return;

        if (type === 'string') {
            parameters[key] = value.trim();
            return;
        }

        const num = toNumber(value);
        if (!Number.isFinite(num) || (type === 'integer' && !Number.isInteger(num))) {
            errors[key] = type === 'integer' ? 'Enter a whole number.' : 'Enter a valid number.';
            return;
        }
        if (num < 0) {
            errors[key] = 'Value cannot be negative.';
            return;
        }
        parameters[key] = num;
    });

    return { parameters, errors };
};

/* -------------------------------------------------------------------------- */
/*  Run statistics                                                             */
/* -------------------------------------------------------------------------- */

export const isRunActive = (run?: Pick<TAutoRun, 'status'> | null) =>
    !!run && (run.status === 'running' || run.status === 'paused');

export const getRunStats = (run?: TAutoRun | null) => {
    const contracts: TAutoContract[] = run?.contracts ?? [];
    const settled = contracts.filter(c => c.contract_status === 'won' || c.contract_status === 'lost');
    const open = contracts.filter(c => !c.contract_status || c.contract_status === 'open');
    const wins = settled.filter(c => c.contract_status === 'won').length;
    const losses = settled.length - wins;

    // Profit is calculated from settled contracts only, otherwise the stake of a
    // contract that is still open would look like an instant loss.
    const profit = settled.reduce((sum, c) => sum + ((c.sell_price ?? 0) - c.buy_price), 0);

    return {
        total: contracts.length,
        open: open.length,
        wins,
        losses,
        win_rate: settled.length ? (wins / settled.length) * 100 : 0,
        profit,
        total_stake: run?.total_stake ?? contracts.reduce((sum, c) => sum + c.buy_price, 0),
        total_payout: run?.total_payout ?? settled.reduce((sum, c) => sum + (c.sell_price ?? 0), 0),
    };
};

export const getStopReasonText = (reason?: TAutoStopReason) => {
    switch (reason) {
        case 'user_stopped':
            return 'Stopped by you';
        case 'condition_triggered':
            return 'Stopped: a strategy limit was reached';
        case 'error':
            return 'Stopped because of an error';
        default:
            return '';
    }
};

/** Extracts the run object from any auto_* response / stream message. */
export const extractRun = (data: unknown): TAutoRun | undefined => {
    if (!data || typeof data !== 'object') return undefined;
    const record = data as Record<string, unknown>;
    const key = ['auto_start', 'auto_get', 'auto_pause', 'auto_resume', 'auto_stop'].find(
        k => record[k] && typeof record[k] === 'object'
    );
    return key ? (record[key] as TAutoRun) : undefined;
};

export const formatMoney = (value: number, currency?: string) =>
    `${value >= 0 ? '' : '-'}${Math.abs(value).toFixed(2)}${currency ? ` ${currency}` : ''}`;

export const formatEpoch = (epoch?: number) => (epoch ? new Date(epoch * 1000).toLocaleString() : '-');
