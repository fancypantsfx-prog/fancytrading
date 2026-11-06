import React from 'react';

import type { TAutoStrategy } from '@deriv/api';
import { Localize, localize } from '@deriv-com/translations';

import {
    buildContractTemplate,
    buildStrategyParameters,
    CONTRACT_TYPE_LABELS,
    DURATION_UNITS,
    EMPTY_TEMPLATE_FORM,
    getParamInputType,
    getTemplateFieldFlags,
    humanizeKey,
    RUN_LIMIT_KEYS,
    TFormErrors,
    TTemplateFormValues,
} from 'AppV2/Utils/auto-trade-utils';

import type { TStartRunArgs } from './auto-trade';

type TProps = {
    strategies: TAutoStrategy[];
    is_loading_strategies: boolean;
    strategies_error?: string | null;
    is_disabled: boolean;
    is_starting: boolean;
    is_virtual: boolean;
    currency: string;
    default_values?: Partial<TTemplateFormValues>;
    symbols: { value: string; text: string }[];
    onStart: (args: TStartRunArgs) => void;
};

const Field = ({
    id,
    label,
    error,
    hint,
    children,
}: {
    id: string;
    label: React.ReactNode;
    error?: string;
    hint?: React.ReactNode;
    children: React.ReactNode;
}) => (
    <div className='auto-trade__field'>
        <label className='auto-trade__label' htmlFor={id}>
            {label}
        </label>
        {children}
        {hint && !error && <span className='auto-trade__hint'>{hint}</span>}
        {error && (
            <span className='auto-trade__error-text' role='alert'>
                {localize(error)}
            </span>
        )}
    </div>
);

const AutoTradeForm = ({
    strategies,
    is_loading_strategies,
    strategies_error,
    is_disabled,
    is_starting,
    is_virtual,
    currency,
    default_values,
    symbols,
    onStart,
}: TProps) => {
    const [strategy_id, setStrategyId] = React.useState('');
    const [template, setTemplate] = React.useState<TTemplateFormValues>({
        ...EMPTY_TEMPLATE_FORM,
        currency,
        ...default_values,
    });
    const [param_values, setParamValues] = React.useState<Record<string, string>>({});
    const [errors, setErrors] = React.useState<TFormErrors>({});
    const [has_confirmed, setHasConfirmed] = React.useState(false);

    const strategy = React.useMemo(() => strategies.find(s => s.strategy_id === strategy_id), [strategies, strategy_id]);
    const flags = getTemplateFieldFlags(template.contract_type);

    // Select the first strategy once the list has loaded.
    React.useEffect(() => {
        if (!strategy_id && strategies.length) setStrategyId(strategies[0].strategy_id);
    }, [strategies, strategy_id]);

    // Keep the currency in sync with the active account.
    React.useEffect(() => {
        setTemplate(previous => ({ ...previous, currency }));
    }, [currency]);

    // Contract type must be one the selected strategy supports.
    React.useEffect(() => {
        if (!strategy) return;
        setTemplate(previous => {
            if (strategy.supported_contract_types.includes(previous.contract_type)) return previous;
            return { ...previous, contract_type: strategy.supported_contract_types[0] ?? '' };
        });
    }, [strategy]);

    const setTemplateValue = (key: keyof TTemplateFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
        setTemplate(previous => ({ ...previous, [key]: e.target.value }));

    const setParam = (key: string, value: string) => setParamValues(previous => ({ ...previous, [key]: value }));

    const schema_keys = Object.keys(strategy?.parameters ?? {});
    const run_limit_keys = RUN_LIMIT_KEYS.filter(key => !schema_keys.includes(key));

    const max_stake = Number(param_values.max_stake);
    const has_max_stake = Number.isFinite(max_stake) && max_stake > 0;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const { template: contract_template, errors: template_errors } = buildContractTemplate(template);
        const { parameters, errors: param_errors } = buildStrategyParameters(strategy, param_values);
        const all_errors = { ...template_errors, ...param_errors };
        setErrors(all_errors);

        if (!strategy || !contract_template || !parameters || Object.keys(all_errors).length) return;

        onStart({
            contract_template,
            strategy_id: strategy.strategy_id,
            strategy_parameters: parameters,
        });
    };

    const renderParam = (key: string, schema: { type?: string }, is_run_limit = false) => {
        const type = getParamInputType(schema);
        const id = `auto-trade-param-${key}`;
        const label = humanizeKey(key);

        if (type === 'boolean') {
            return (
                <label key={key} className='auto-trade__checkbox' htmlFor={id}>
                    <input
                        id={id}
                        type='checkbox'
                        checked={param_values[key] === 'true'}
                        onChange={e => setParam(key, e.target.checked ? 'true' : 'false')}
                        disabled={is_disabled}
                    />
                    <span>{label}</span>
                </label>
            );
        }

        return (
            <Field
                key={key}
                id={id}
                label={label}
                error={errors[key]}
                hint={is_run_limit ? <Localize i18n_default_text='Optional' /> : undefined}
            >
                <input
                    id={id}
                    className='auto-trade__input'
                    type={type === 'string' ? 'text' : 'number'}
                    inputMode={type === 'string' ? 'text' : 'decimal'}
                    min={type === 'string' ? undefined : 0}
                    step={type === 'integer' ? 1 : 'any'}
                    value={param_values[key] ?? ''}
                    onChange={e => setParam(key, e.target.value)}
                    disabled={is_disabled}
                />
            </Field>
        );
    };

    if (is_loading_strategies) {
        return (
            <p className='auto-trade__muted'>
                <Localize i18n_default_text='Loading strategies…' />
            </p>
        );
    }

    if (strategies_error || !strategies.length) {
        return (
            <p className='auto-trade__error-text' role='alert'>
                {strategies_error || <Localize i18n_default_text='No automated strategies are available right now.' />}
            </p>
        );
    }

    return (
        <form className='auto-trade__form' onSubmit={handleSubmit} noValidate data-testid='dt_auto_trade_form'>
            {/* ---------------- Strategy ---------------- */}
            <Field id='auto-trade-strategy' label={<Localize i18n_default_text='Strategy' />} error={errors.strategy_id}>
                <select
                    id='auto-trade-strategy'
                    className='auto-trade__input'
                    value={strategy_id}
                    onChange={e => {
                        setStrategyId(e.target.value);
                        setParamValues({});
                        setErrors({});
                    }}
                    disabled={is_disabled}
                >
                    {strategies.map(s => (
                        <option key={s.strategy_id} value={s.strategy_id}>
                            {s.display_name}
                        </option>
                    ))}
                </select>
            </Field>
            {strategy?.description && <p className='auto-trade__muted'>{strategy.description}</p>}

            {/* ---------------- Contract template ---------------- */}
            <h3 className='auto-trade__subtitle'>
                <Localize i18n_default_text='Contract for every trade' />
            </h3>
            <div className='auto-trade__grid'>
                <Field id='auto-trade-symbol' label={<Localize i18n_default_text='Market' />} error={errors.underlying_symbol}>
                    <input
                        id='auto-trade-symbol'
                        className='auto-trade__input'
                        list='auto-trade-symbols'
                        value={template.underlying_symbol}
                        onChange={setTemplateValue('underlying_symbol')}
                        placeholder='R_100'
                        autoComplete='off'
                        disabled={is_disabled}
                    />
                    <datalist id='auto-trade-symbols'>
                        {symbols.map(({ value, text }) => (
                            <option key={value} value={value}>
                                {text}
                            </option>
                        ))}
                    </datalist>
                </Field>

                <Field id='auto-trade-contract-type' label={<Localize i18n_default_text='Contract type' />} error={errors.contract_type}>
                    <select
                        id='auto-trade-contract-type'
                        className='auto-trade__input'
                        value={template.contract_type}
                        onChange={setTemplateValue('contract_type')}
                        disabled={is_disabled}
                    >
                        {(strategy?.supported_contract_types ?? []).map(type => (
                            <option key={type} value={type}>
                                {CONTRACT_TYPE_LABELS[type as keyof typeof CONTRACT_TYPE_LABELS] ?? type}
                            </option>
                        ))}
                    </select>
                </Field>

                <Field id='auto-trade-basis' label={<Localize i18n_default_text='Basis' />}>
                    <select
                        id='auto-trade-basis'
                        className='auto-trade__input'
                        value={template.basis}
                        onChange={setTemplateValue('basis')}
                        disabled={is_disabled}
                    >
                        <option value='stake'>{localize('Stake')}</option>
                        <option value='payout'>{localize('Payout')}</option>
                    </select>
                </Field>

                <Field
                    id='auto-trade-amount'
                    label={<Localize i18n_default_text='Initial amount ({{currency}})' values={{ currency }} />}
                    error={errors.amount}
                >
                    <input
                        id='auto-trade-amount'
                        className='auto-trade__input'
                        type='number'
                        inputMode='decimal'
                        min={0}
                        step='any'
                        value={template.amount}
                        onChange={setTemplateValue('amount')}
                        disabled={is_disabled}
                    />
                </Field>

                {flags.needs_duration && (
                    <React.Fragment>
                        <Field id='auto-trade-duration' label={<Localize i18n_default_text='Duration' />} error={errors.duration}>
                            <input
                                id='auto-trade-duration'
                                className='auto-trade__input'
                                type='number'
                                inputMode='numeric'
                                min={0}
                                step={1}
                                value={template.duration}
                                onChange={setTemplateValue('duration')}
                                disabled={is_disabled}
                            />
                        </Field>
                        <Field id='auto-trade-duration-unit' label={<Localize i18n_default_text='Duration unit' />}>
                            <select
                                id='auto-trade-duration-unit'
                                className='auto-trade__input'
                                value={template.duration_unit}
                                onChange={setTemplateValue('duration_unit')}
                                disabled={is_disabled}
                            >
                                {DURATION_UNITS.map(({ value, label }) => (
                                    <option key={value} value={value}>
                                        {localize(label)}
                                    </option>
                                ))}
                            </select>
                        </Field>
                    </React.Fragment>
                )}

                {flags.needs_barrier && (
                    <Field
                        id='auto-trade-barrier'
                        label={
                            flags.barrier_is_required ? (
                                <Localize i18n_default_text='Last digit prediction / barrier' />
                            ) : (
                                <Localize i18n_default_text='Barrier' />
                            )
                        }
                        error={errors.barrier}
                        hint={flags.barrier_is_required ? undefined : <Localize i18n_default_text='Optional' />}
                    >
                        <input
                            id='auto-trade-barrier'
                            className='auto-trade__input'
                            value={template.barrier}
                            onChange={setTemplateValue('barrier')}
                            disabled={is_disabled}
                        />
                    </Field>
                )}

                {flags.needs_barrier2 && (
                    <Field id='auto-trade-barrier2' label={<Localize i18n_default_text='Low barrier' />} error={errors.barrier2}>
                        <input
                            id='auto-trade-barrier2'
                            className='auto-trade__input'
                            value={template.barrier2}
                            onChange={setTemplateValue('barrier2')}
                            disabled={is_disabled}
                        />
                    </Field>
                )}

                {flags.needs_growth_rate && (
                    <Field id='auto-trade-growth' label={<Localize i18n_default_text='Growth rate' />} error={errors.growth_rate} hint='0.01 = 1%'>
                        <input
                            id='auto-trade-growth'
                            className='auto-trade__input'
                            type='number'
                            inputMode='decimal'
                            step='any'
                            value={template.growth_rate}
                            onChange={setTemplateValue('growth_rate')}
                            disabled={is_disabled}
                        />
                    </Field>
                )}

                {flags.needs_multiplier && (
                    <Field id='auto-trade-multiplier' label={<Localize i18n_default_text='Multiplier' />} error={errors.multiplier}>
                        <input
                            id='auto-trade-multiplier'
                            className='auto-trade__input'
                            type='number'
                            inputMode='decimal'
                            min={0}
                            step='any'
                            value={template.multiplier}
                            onChange={setTemplateValue('multiplier')}
                            disabled={is_disabled}
                        />
                    </Field>
                )}

                {flags.needs_selected_tick && (
                    <Field id='auto-trade-tick' label={<Localize i18n_default_text='Selected tick' />} error={errors.selected_tick}>
                        <input
                            id='auto-trade-tick'
                            className='auto-trade__input'
                            type='number'
                            inputMode='numeric'
                            min={1}
                            step={1}
                            value={template.selected_tick}
                            onChange={setTemplateValue('selected_tick')}
                            disabled={is_disabled}
                        />
                    </Field>
                )}

                {flags.needs_limit_order && (
                    <React.Fragment>
                        <Field
                            id='auto-trade-contract-tp'
                            label={<Localize i18n_default_text='Contract take profit' />}
                            error={errors.take_profit}
                            hint={<Localize i18n_default_text='Optional' />}
                        >
                            <input
                                id='auto-trade-contract-tp'
                                className='auto-trade__input'
                                type='number'
                                inputMode='decimal'
                                min={0}
                                step='any'
                                value={template.take_profit}
                                onChange={setTemplateValue('take_profit')}
                                disabled={is_disabled}
                            />
                        </Field>
                        {template.contract_type !== 'ACCU' && (
                            <Field
                                id='auto-trade-contract-sl'
                                label={<Localize i18n_default_text='Contract stop loss' />}
                                error={errors.stop_loss}
                                hint={<Localize i18n_default_text='Optional' />}
                            >
                                <input
                                    id='auto-trade-contract-sl'
                                    className='auto-trade__input'
                                    type='number'
                                    inputMode='decimal'
                                    min={0}
                                    step='any'
                                    value={template.stop_loss}
                                    onChange={setTemplateValue('stop_loss')}
                                    disabled={is_disabled}
                                />
                            </Field>
                        )}
                    </React.Fragment>
                )}
            </div>

            {/* ---------------- Strategy parameters ---------------- */}
            {(schema_keys.length > 0 || run_limit_keys.length > 0) && (
                <React.Fragment>
                    <h3 className='auto-trade__subtitle'>
                        <Localize i18n_default_text='Strategy settings' />
                    </h3>
                    <div className='auto-trade__grid'>
                        {schema_keys.map(key => renderParam(key, strategy?.parameters[key] ?? {}))}
                        {run_limit_keys.map(key => renderParam(key, { type: 'number' }, true))}
                    </div>
                    <p className='auto-trade__muted'>
                        <Localize i18n_default_text='Run stop loss / take profit end the whole run when your total loss or profit reaches that amount.' />
                    </p>
                </React.Fragment>
            )}

            {/* ---------------- Confirmation ---------------- */}
            <div className={`auto-trade__confirm${is_virtual ? '' : ' auto-trade__confirm--real'}`}>
                <label className='auto-trade__checkbox' htmlFor='auto-trade-confirm'>
                    <input
                        id='auto-trade-confirm'
                        type='checkbox'
                        checked={has_confirmed}
                        onChange={e => setHasConfirmed(e.target.checked)}
                        disabled={is_disabled}
                    />
                    <span>
                        {is_virtual ? (
                            <Localize i18n_default_text='I understand this run will place trades automatically on my demo account until it is stopped.' />
                        ) : (
                            <Localize i18n_default_text='I understand this run will place trades automatically with REAL money until it is stopped, and that I can lose my entire stake.' />
                        )}
                    </span>
                </label>
                {has_max_stake && (
                    <p className='auto-trade__muted'>
                        <Localize
                            i18n_default_text='Largest single stake allowed by this setup: {{amount}} {{currency}}.'
                            values={{ amount: max_stake.toFixed(2), currency }}
                        />
                    </p>
                )}
            </div>

            <button
                type='submit'
                className='auto-trade__button auto-trade__button--primary'
                disabled={is_disabled || is_starting || !has_confirmed}
                data-testid='dt_auto_trade_start'
            >
                {is_starting ? <Localize i18n_default_text='Starting…' /> : <Localize i18n_default_text='Start auto trading' />}
            </button>
        </form>
    );
};

export default AutoTradeForm;
