// The Automation API is server-managed. Only read requests may be retried.
export type ParameterSchema = {
    type?: string;
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
type Response = Record<string, unknown> & { error?: { message?: string; code?: string } };
export type Send = (request: Record<string, unknown>) => Promise<Response>;
export const messageOf = (error: unknown) =>
    error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);

export const getParameterSchema = (strategy: Strategy): ParameterSchema => {
    const schema = strategy.parameters as ParameterSchema;
    return schema.type === 'object' || schema.properties
        ? schema
        : { type: 'object', properties: strategy.parameters as Record<string, ParameterSchema> };
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
                validateParameter(item, schema.items!, path + '[' + index + ']'),
            );
    }
};
export const parseParameters = (strategy: Strategy, values: Record<string, string>) => {
    const schema = getParameterSchema(strategy);
    const parameters: Record<string, unknown> = {};
    for (const [key, definition] of Object.entries(schema.properties ?? {})) {
        const text = values[key];
        if (text === undefined || text.trim() === '') continue;
        try {
            parameters[key] = definition.type === 'string' && !definition.enum ? text : JSON.parse(text);
        } catch {
            throw new Error(key + ': enter a valid ' + (definition.type ?? 'JSON value'));
        }
    }
    validateParameter(parameters, { ...schema, type: 'object' });
    return parameters;
};

// Allowlist the documented template fields; proposal-only flags must never leak into auto_start.
export const buildTemplate = (proposal: Record<string, unknown>): ContractTemplate => {
    for (const field of ['date_expiry', 'date_start', 'cancellation', 'payout_per_point']) {
        if (proposal[field] !== undefined && proposal[field] !== null && proposal[field] !== '') {
            throw new Error(
                'Automatic trading does not support ' + field.replace(/_/g, ' ') + '. Change the contract settings.',
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
                                new Error('Request timed out. Refresh runs to check the server before trying again.'),
                            ),
                        15000,
                    );
                }),
            ]);
            if (response?.error)
                throw new Error(response.error.message ?? response.error.code ?? 'Automation request failed.');
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
        validateParameter(strategy_parameters, getParameterSchema(strategy));
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
            // A lost response may still mean the server executed the command. Never replay it.
            this.update({ error: messageOf(error), uncertain: true });
        } finally {
            this.update({ busy: false });
        }
    }
    dispose() {
        this.active = false;
        ++this.revision;
    }
}
