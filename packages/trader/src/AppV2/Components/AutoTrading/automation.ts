// The Automation API is server-managed. Only read requests may be retried.
export type ParameterSchema = {
    type?: string;
    multipleOf?: number;
    title?: string;
    description?: string;
    default?: unknown;
    enum?: unknown[];
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    required?: string[];
    properties?: Record<string, ParameterSchema>;
    items?: ParameterSchema;
    additionalProperties?: boolean;
};
export type Strategy = {
    strategy_id: string;
    display_name: string;
    description?: string;
    parameters: ParameterSchema | Record<string, ParameterSchema>;
    supported_contract_types: string[];
};
export type ContractTemplate = {
    contract_type: string;
    currency: string;
    underlying_symbol: string;
    amount?: number;
    basis?: 'stake' | 'payout';
    barrier?: string;
    barrier2?: string;
    duration?: number;
    duration_unit?: string;
    growth_rate?: number;
    multiplier?: number;
    selected_tick?: number;
    limit_order?: { stop_loss?: number; take_profit?: number };
};
export type Run = {
    run_id: string;
    status: 'running' | 'paused' | 'stopped';
    start_time: number;
    strategy_id: string;
    strategy_parameters: Record<string, unknown>;
    contract_template: ContractTemplate;
    contracts?: {
        contract_id: number;
        buy_price: number;
        contract_status?: 'open' | 'won' | 'lost';
        purchase_time: number;
        sell_price?: number;
        sell_time?: number;
    }[];
    total_payout?: number;
    total_stake?: number;
    stop_reason?: string;
    stop_reason_code?: string;
    stop_time?: number;
};
export type AutomationState = {
    strategies: Strategy[];
    runs: Run[];
    selected_id: string;
    ready: boolean;
    busy: boolean;
    error: string;
    uncertain: boolean;
    updated_at?: number;
};
type Response = Record<string, unknown> & {
    error?: { message?: string; code?: string; field?: string; details?: { field?: string } };
};
class AutomationRejection extends Error {}
export type Send = (request: Record<string, unknown>) => Promise<Response>;
export const messageOf = (error: unknown) =>
    error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export const getParameterSchema = (strategy: Strategy): ParameterSchema => {
    const schema = strategy.parameters as ParameterSchema;
    return schema.type === 'object' || schema.properties
        ? schema
        : { type: 'object', properties: strategy.parameters as Record<string, ParameterSchema> };
};
// Run limits are documented common strategy parameters. A closed advertised schema wins.
export const getRunParameterSchema = (strategy: Strategy): ParameterSchema => {
    const schema = getParameterSchema(strategy);
    const common: Record<string, ParameterSchema> =
        schema.additionalProperties === false
            ? {}
            : {
                  take_profit: {
                      type: 'number',
                      title: 'Take profit',
                      exclusiveMinimum: 0,
                      description: 'Stop the run after reaching this profit in your account currency.',
                  },
                  stop_loss: {
                      type: 'number',
                      title: 'Stop loss',
                      exclusiveMinimum: 0,
                      description: 'Stop the run after reaching this loss in your account currency.',
                  },
              };
    return {
        ...schema,
        required: schema.required,
        properties: { ...common, ...schema.properties },
    };
};
export const validateAutomaticStake = (text: string): number => {
    const stake = text.trim() ? Number(text) : NaN;
    if (!Number.isFinite(stake) || stake <= 0) throw new Error('Automatic stake must be greater than 0.');
    return stake;
};
export const hasRunStopLoss = (parameters: Record<string, unknown>): boolean => {
    const value = parameters.stop_loss;
    if (typeof value !== 'number' && typeof value !== 'string') return false;
    const number = Number(value);
    return Number.isFinite(number) && number > 0;
};
export const SHARED_STAKE_PARAMETERS = ['initial_stake', 'starting_stake', 'base_stake', 'initial_amount', 'stake'];
export const isSharedStakeParameter = (key: string): boolean => SHARED_STAKE_PARAMETERS.includes(key);
export const validateEnabledLimits = (values: Record<string, string>) => {
    for (const key of ['take_profit', 'stop_loss'])
        if (!values[key]?.trim() || !Number.isFinite(Number(values[key])) || Number(values[key]) <= 0)
            throw new Error('Enter ' + riskFieldInfo(key).label.toLowerCase() + ' greater than 0.');
};
export const numericStep = (name: string, schema: ParameterSchema): number => {
    if (schema.type === 'integer') return Math.max(1, schema.multipleOf ?? 1);
    if (schema.multipleOf && schema.multipleOf > 0) return schema.multipleOf;
    return name === 'multiplier' ? 0.1 : 0.01;
};
export const stepNumber = (
    value: string,
    direction: number,
    step: number,
    minimum?: number,
    maximum?: number
): string => {
    const parsed = value.trim() ? Number(value) : NaN;
    const starting = Number.isFinite(parsed) ? parsed : (minimum ?? 0);
    const next = !Number.isFinite(parsed) ? starting : starting + Math.sign(direction) * step;
    const bounded = Math.max(minimum ?? -Infinity, Math.min(maximum ?? Infinity, next));
    return String(Number(bounded.toFixed(12)));
};
export const getSharedContractType = (available: string[], selected: string): string =>
    available.includes(selected) ? selected : available.length === 1 ? available[0] : '';

export const riskFieldInfo = (
    key: string
): { label: string; group: 'protection' | 'recovery' | 'cooldown' | 'advanced' } => {
    const fields: Record<string, { label: string; group: 'protection' | 'recovery' | 'cooldown' }> = {
        take_profit: { label: 'Take profit', group: 'protection' },
        stop_loss: { label: 'Stop loss', group: 'protection' },
        max_stake: { label: 'Maximum stake', group: 'protection' },
        max_trades: { label: 'Maximum trades', group: 'protection' },
        max_rounds: { label: 'Maximum rounds', group: 'protection' },
        multiplier: { label: 'Martingale multiplier', group: 'recovery' },
        max_martingale_level: { label: 'Maximum martingale levels', group: 'recovery' },
        max_martingale_levels: { label: 'Maximum martingale levels', group: 'recovery' },
        max_levels: { label: 'Maximum recovery levels', group: 'recovery' },
        max_recovery_levels: { label: 'Maximum recovery levels', group: 'recovery' },
        stop_after_max_martingale: { label: 'Stop after maximum martingale level', group: 'recovery' },
        stop_after_max_martingale_level: { label: 'Stop after maximum martingale level', group: 'recovery' },
        stop_after_max_level: { label: 'Stop after maximum recovery level', group: 'recovery' },
        stop_after_max_recovery_levels: { label: 'Stop after maximum recovery level', group: 'recovery' },
        martingale_after: { label: 'Start martingale after this many losses', group: 'recovery' },
        start_after_losses: { label: 'Start martingale after this many losses', group: 'recovery' },
        do_martingale_after: { label: 'Start martingale after this many losses', group: 'recovery' },
        stake_list: { label: 'Stake list', group: 'recovery' },
        stakes: { label: 'Stake list', group: 'recovery' },
        stop_after_stake_list: { label: 'Stop at the end of the stake list', group: 'recovery' },
        stop_after_max_stake_list: { label: 'Stop at the end of the stake list', group: 'recovery' },
        target_profit: { label: 'Profit per winning trade', group: 'recovery' },
        profit_per_trade: { label: 'Profit per winning trade', group: 'recovery' },
        cooldown_trigger: { label: 'Cooldown after a streak', group: 'cooldown' },
        cooldown_after: { label: 'Streak length', group: 'cooldown' },
        cooldown_duration: { label: 'Cooldown duration', group: 'cooldown' },
        cooldown_seconds: { label: 'Cooldown in seconds', group: 'cooldown' },
        cooldown_after_losses: { label: 'Cooldown after consecutive losses', group: 'cooldown' },
        cooldown_after_wins: { label: 'Cooldown after consecutive wins', group: 'cooldown' },
    };
    return (
        fields[key] ?? {
            label: key.replace(/_/g, ' ').replace(/^./, (value) => value.toUpperCase()),
            group: 'advanced',
        }
    );
};
export const isFixedStakeStrategy = (strategy: Strategy): boolean =>
    ['fixed', 'fixedstake', 'flat', 'flatstake', 'constant', 'constantstake'].includes(
        strategy.strategy_id.toLowerCase().replace(/[^a-z0-9]/g, '')
    );
export const supportsFixedMultiplier = (strategy: Strategy): boolean => {
    if (!/martingale/i.test(strategy.strategy_id)) return false;
    const schema = getRunParameterSchema(strategy);
    const multiplier = schema.properties?.multiplier;
    if (!multiplier || !['number', 'integer'].includes(multiplier.type ?? '')) return false;
    if ((schema.required ?? []).some((key) => key !== 'multiplier' && riskFieldInfo(key).group === 'recovery'))
        return false;
    try {
        validateParameter(1, multiplier);
        return true;
    } catch {
        return false;
    }
};
export const getFixedStakeStrategy = (strategies: Strategy[]): Strategy | undefined =>
    strategies.find(isFixedStakeStrategy) ?? strategies.find(supportsFixedMultiplier);
export const getMethodValues = (
    strategy: Strategy,
    values: Record<string, string>,
    fixed: boolean
): Record<string, string> => {
    if (!fixed || isFixedStakeStrategy(strategy)) return values;
    if (!supportsFixedMultiplier(strategy)) throw new Error('Fixed stake is not available with this strategy.');
    return {
        ...Object.fromEntries(Object.entries(values).filter(([key]) => riskFieldInfo(key).group !== 'recovery')),
        multiplier: '1',
    };
};
export const validateRunParameters = (
    strategy: Strategy,
    template: ContractTemplate,
    parameters: Record<string, unknown>
) => {
    validateParameter(parameters, getRunParameterSchema(strategy));
    for (const key of ['take_profit', 'stop_loss', 'max_stake']) {
        const value = parameters[key];
        const number =
            typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
        if (value !== undefined && (!Number.isFinite(number) || number <= 0))
            throw new Error(riskFieldInfo(key).label + ' must be greater than zero.');
    }
    const maximum_stake = parameters.max_stake === undefined ? undefined : Number(parameters.max_stake);
    if (
        template.basis === 'stake' &&
        maximum_stake !== undefined &&
        template.amount !== undefined &&
        maximum_stake < template.amount
    )
        throw new Error('Maximum stake must cover the initial stake configured for Automatic.');
    if (
        /martingale/i.test(strategy.strategy_id) &&
        parameters.multiplier !== undefined &&
        (typeof parameters.multiplier !== 'number' ||
            parameters.multiplier < 1 ||
            (parameters.multiplier === 1 && !supportsFixedMultiplier(strategy)))
    )
        throw new Error('Use 1 for fixed stake, or a multiplier greater than 1 for martingale.');
    for (const key of ['stake_list', 'stakes']) {
        const list = parameters[key];
        if (list !== undefined) {
            if (
                !Array.isArray(list) ||
                !list.length ||
                list.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
            )
                throw new Error('Enter positive amounts in the stake list.');
            if (template.basis === 'stake' && list[0] !== template.amount)
                throw new Error('The first stake in the list must match the stake in the trading form.');
            if (maximum_stake !== undefined && list.some((value) => value > maximum_stake))
                throw new Error('The stake list exceeds the maximum stake.');
        }
    }
};
export const validateParameter = (value: unknown, schema: ParameterSchema, path = 'Parameters'): void => {
    const fail = (reason: string): never => {
        throw new Error(path + ': ' + reason);
    };
    if (schema.enum && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value)))
        fail('choose an allowed value');
    if (schema.type === 'number' || schema.type === 'integer') {
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('enter a finite number');
        const number = value as number;
        if (schema.type === 'integer' && !Number.isInteger(number)) fail('enter an integer');
        if (schema.minimum !== undefined && number < schema.minimum) fail('below minimum ' + schema.minimum);
        if (schema.maximum !== undefined && number > schema.maximum) fail('above maximum ' + schema.maximum);
        if (schema.exclusiveMinimum !== undefined && number <= schema.exclusiveMinimum)
            fail('must exceed ' + schema.exclusiveMinimum);
        if (schema.exclusiveMaximum !== undefined && number >= schema.exclusiveMaximum)
            fail('must be below ' + schema.exclusiveMaximum);
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') fail('enter true or false');
    if (schema.type === 'string') {
        if (typeof value !== 'string') fail('enter text');
        const text = value as string;
        if (schema.minLength !== undefined && text.length < schema.minLength) fail('text is too short');
        if (schema.maxLength !== undefined && text.length > schema.maxLength) fail('text is too long');
        if (schema.pattern && !new RegExp(schema.pattern).test(text)) fail('text does not match the required format');
    }
    if (schema.type === 'object' || schema.properties) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('enter a JSON object');
        const object = value as Record<string, unknown>;
        for (const key of schema.required ?? []) if (object[key] === undefined) fail('missing ' + key);
        for (const [key, item] of Object.entries(object)) {
            if (schema.properties?.[key]) validateParameter(item, schema.properties[key], path + '.' + key);
            else if (schema.additionalProperties === false) fail('unknown parameter ' + key);
        }
    }
    if (schema.type === 'array') {
        if (!Array.isArray(value)) fail('enter an array');
        if (schema.items)
            (value as unknown[]).forEach((item, index) =>
                validateParameter(item, schema.items!, path + '[' + index + ']')
            );
    }
};
export const parseParameters = (strategy: Strategy, values: Record<string, string>, shared?: ContractTemplate) => {
    const schema = getRunParameterSchema(strategy);
    const parameters: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(schema.properties ?? {})) {
        if (shared && isSharedStakeParameter(key)) continue;
        const text = values[key];
        if (text === undefined || text.trim() === '') continue;
        try {
            parameters[key] =
                definition.type === 'array' &&
                (key === 'stake_list' || key === 'stakes') &&
                !text.trim().startsWith('[')
                    ? text
                          .trim()
                          .split(/[,\s]+/)
                          .map(Number)
                    : definition.type === 'string' && !definition.enum
                      ? text
                      : JSON.parse(text);
        } catch {
            throw new Error(key + ': enter a valid ' + (definition.type ?? 'JSON value'));
        }
    }
    if (shared) {
        const properties = schema.properties ?? {};
        const stake_keys = Object.keys(properties).filter(isSharedStakeParameter);
        const list_keys = ['stake_list', 'stakes'].filter((key) => !!properties[key]);
        if (stake_keys.length || list_keys.length) {
            if (
                shared.basis !== 'stake' ||
                typeof shared.amount !== 'number' ||
                !Number.isFinite(shared.amount) ||
                shared.amount <= 0
            )
                throw new Error('Choose a valid stake in the manual trading form.');
            // Money fields may be decimal strings in the live strategy schema.
            // Preserve the manual amount; only adapt its wire representation.
            for (const key of stake_keys) {
                parameters[key] = properties[key].type === 'string' ? String(shared.amount) : shared.amount;
            }
            for (const key of list_keys) {
                const recovery = parameters[key] ?? [];
                if (!Array.isArray(recovery)) throw new Error('Enter a valid recovery stake list.');
                parameters[key] = [shared.amount, ...recovery];
            }
        }
    }
    for (const key of ['take_profit', 'stop_loss']) {
        if (schema.required?.includes(key) && parameters[key] === undefined)
            throw new Error(riskFieldInfo(key).label + ' is required. Enter an amount greater than 0 in Automatic settings.');
    }
    validateParameter(parameters, { ...schema, type: 'object' });
    return parameters;
};

// Allowlist the documented template fields; proposal-only flags must never leak into auto_start.
export const buildTemplate = (proposal: Record<string, unknown>): ContractTemplate => {
    for (const field of ['date_expiry', 'date_start', 'cancellation', 'payout_per_point']) {
        if (proposal[field] !== undefined && proposal[field] !== null && proposal[field] !== '') {
            throw new Error(
                'Automatic trading does not support ' + field.replace(/_/g, ' ') + '. Change the contract settings.'
            );
        }
    }
    const template: Record<string, unknown> = {};
    for (const key of [
        'contract_type',
        'currency',
        'underlying_symbol',
        'amount',
        'basis',
        'barrier',
        'barrier2',
        'duration',
        'duration_unit',
        'growth_rate',
        'multiplier',
        'selected_tick',
    ]) {
        const value = proposal[key];
        if (value !== undefined && value !== null && value !== '')
            template[key] = key.startsWith('barrier') ? String(value) : value;
    }
    if (!/^\w{2,30}$/.test(String(template.underlying_symbol ?? ''))) throw new Error('Select a market.');
    if (!/^[a-zA-Z0-9]{2,20}$/.test(String(template.currency ?? ''))) throw new Error('Select an account currency.');
    if (typeof template.contract_type !== 'string' || !template.contract_type) throw new Error('Select a contract.');
    for (const key of ['amount', 'growth_rate', 'multiplier']) {
        if (
            template[key] !== undefined &&
            (typeof template[key] !== 'number' || !Number.isFinite(template[key]) || (template[key] as number) <= 0)
        )
            throw new Error('Enter a positive ' + key + '.');
    }
    if (template.selected_tick !== undefined && !Number.isInteger(template.selected_tick))
        throw new Error('Select a valid tick.');
    if (template.basis !== undefined && !['stake', 'payout'].includes(String(template.basis)))
        throw new Error('Select stake or payout.');
    if (
        template.duration !== undefined &&
        (!Number.isInteger(template.duration) ||
            (template.duration as number) <= 0 ||
            (template.duration as number) > 99999999)
    )
        throw new Error('Enter a valid duration.');
    if (template.duration !== undefined && !['d', 'm', 's', 'h', 't'].includes(String(template.duration_unit)))
        throw new Error('Select a duration unit.');
    for (const key of ['barrier', 'barrier2'])
        if (template[key] !== undefined && !/^(?=.{1,20}$)[+-]?[0-9]+\.?[0-9]*$/.test(String(template[key])))
            throw new Error('Enter a valid barrier.');
    if (proposal.limit_order && typeof proposal.limit_order === 'object') {
        const order = proposal.limit_order as Record<string, unknown>;
        const limits: Record<string, number> = {};
        for (const key of ['stop_loss', 'take_profit']) {
            if (order[key] === undefined) continue;
            if (typeof order[key] !== 'number' || !Number.isFinite(order[key]) || (order[key] as number) <= 0)
                throw new Error('Enter a positive ' + key + '.');
            limits[key] = order[key] as number;
        }
        if (Object.keys(limits).length) {
            if (!['MULTUP', 'MULTDOWN', 'ACCU'].includes(String(template.contract_type)))
                throw new Error('This contract does not support automatic limit orders.');
            template.limit_order = limits;
        }
    }
    return template as ContractTemplate;
};

export class AutomationController {
    state: AutomationState = {
        strategies: [],
        runs: [],
        selected_id: '',
        ready: false,
        busy: false,
        error: '',
        uncertain: false,
    };
    private send: Send;
    private listener: (state: AutomationState) => void;
    private active = true;
    private revision = 0;
    private polling = false;
    constructor(send: Send, listener: (state: AutomationState) => void) {
        this.send = send;
        this.listener = listener;
    }
    private update(patch: Partial<AutomationState>) {
        if (!this.active) return;
        this.state = { ...this.state, ...patch };
        this.listener(this.state);
    }
    private async request(endpoint: string, payload: Record<string, unknown> = {}) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const response = await Promise.race([
                this.send({ [endpoint]: 1, ...payload }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error('Request timed out. Refresh runs to check the server before trying again.')
                            ),
                        15000
                    );
                }),
            ]);
            if (response?.error) {
                const field = response.error.details?.field ?? response.error.field;
                const message = response.error.message ?? response.error.code ?? 'Automation request failed.';
                throw new AutomationRejection(field ? field + ': ' + message : message);
            }
            if (!response || !response[endpoint])
                throw new Error('Missing ' + endpoint + ' response. Refresh runs to check the server.');
            return response[endpoint];
        } finally {
            clearTimeout(timer);
        }
    }
    async refresh() {
        if (this.state.busy || this.polling || !this.active) return;
        this.update({ busy: true, error: '' });
        const revision = ++this.revision;
        try {
            const [strategies, list] = (await Promise.all([
                this.request('auto_list_strategies'),
                this.request('auto_list'),
            ])) as [{ strategies: Strategy[] }, { runs: Run[] }];
            if (!Array.isArray(strategies.strategies) || !Array.isArray(list.runs))
                throw new Error('Invalid automation response.');
            if (!this.active || revision !== this.revision) return;
            const selected_id = list.runs.some((run) => run.run_id === this.state.selected_id)
                ? this.state.selected_id
                : ((list.runs.find((run) => run.status !== 'stopped') ?? list.runs[0])?.run_id ?? '');
            this.update({
                strategies: strategies.strategies,
                runs: list.runs,
                selected_id,
                ready: true,
                uncertain: false,
                updated_at: Date.now(),
            });
        } catch (error) {
            this.update({ error: messageOf(error), ready: false });
        } finally {
            this.update({ busy: false });
        }
    }
    select(run_id: string) {
        this.update({ selected_id: run_id });
        ++this.revision;
    }
    async poll() {
        if (!this.active || this.state.busy || this.polling || !this.state.ready) return;
        this.polling = true;
        const revision = this.revision;
        const id = this.state.selected_id;
        try {
            const list = (await this.request('auto_list')) as { runs: Run[] };
            if (!Array.isArray(list.runs)) throw new Error('Invalid run list.');
            // auto_get includes the current run's contract history and settled totals.
            const detail = id ? ((await this.request('auto_get', { run_id: id })) as Run) : undefined;
            if (this.active && revision === this.revision) {
                const runs = detail
                    ? list.runs.map((run) => (run.run_id === id ? { ...run, ...detail } : run))
                    : list.runs;
                this.update({ runs, updated_at: Date.now(), error: this.state.uncertain ? this.state.error : '' });
            }
        } catch (error) {
            if (revision === this.revision) this.update({ error: messageOf(error), ready: false });
        } finally {
            this.polling = false;
        }
    }
    async start(strategy: Strategy, contract_template: ContractTemplate, strategy_parameters: Record<string, unknown>) {
        if (!this.state.ready || this.state.uncertain || this.state.runs.some((run) => run.status !== 'stopped'))
            throw new Error('Refresh runs and stop any active run before starting another.');
        if (!strategy.supported_contract_types.includes(contract_template.contract_type))
            throw new Error('Strategy does not support this contract.');
        validateRunParameters(strategy, contract_template, strategy_parameters);
        if (!/^\w{1,64}$/.test(strategy.strategy_id)) throw new Error('Invalid strategy identifier.');
        return this.command('auto_start', {
            strategy_id: strategy.strategy_id,
            contract_template,
            strategy_parameters,
        });
    }
    async control(action: 'pause' | 'resume' | 'stop', run_id: string) {
        const run = this.state.runs.find((item) => item.run_id === run_id);
        if (!run || !/^[\w-]{1,128}$/.test(run_id)) throw new Error('Select a valid run.');
        if (
            run.status === 'stopped' ||
            (action === 'pause' && run.status !== 'running') ||
            (action === 'resume' && run.status !== 'paused')
        )
            throw new Error('Refresh runs to check the current status.');
        return this.command('auto_' + action, { run_id });
    }
    private async command(endpoint: string, payload: Record<string, unknown>) {
        if (!this.active || this.state.busy) return;
        ++this.revision; // Ignore an older polling response after a user action.
        this.update({ busy: true, error: '' });
        try {
            const run = (await this.request(endpoint, payload)) as Run;
            if (!run.run_id || !['running', 'paused', 'stopped'].includes(run.status))
                throw new Error('Invalid run response. Refresh runs to check the server.');
            const previous = this.state.runs.find((item) => item.run_id === run.run_id);
            this.update({
                runs: [{ ...previous, ...run }, ...this.state.runs.filter((item) => item.run_id !== run.run_id)],
                selected_id: run.run_id,
                updated_at: Date.now(),
            });
        } catch (error) {
            // An explicit API rejection is safe to correct and retry manually.
            // A lost or malformed response may still mean the server executed the command. Never replay it.
            this.update({ error: messageOf(error), uncertain: !(error instanceof AutomationRejection) });
        } finally {
            this.update({ busy: false });
        }
    }
    dispose() {
        this.active = false;
        ++this.revision;
    }
}
