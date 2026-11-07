import React from 'react';
import { createPortal } from 'react-dom';
import { observer } from 'mobx-react-lite';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import { useStore } from '@deriv/stores';
import { localize } from '@deriv-com/translations';
import PurchaseButton from 'AppV2/Components/PurchaseButton';
import { getProposalRequestObject } from 'AppV2/Utils/trade-params-utils';
import { getDisplayedContractTypes } from 'AppV2/Utils/trade-types-utils';
import { useTraderStore } from 'Stores/useTraderStores';
import {
    AutomationController,
    AutomationState,
    buildTemplate,
    ContractTemplate,
    getRunParameterSchema,
    getFixedStakeStrategy,
    getMethodValues,
    isFixedStakeStrategy,
    getSharedContractType,
    messageOf,
    ParameterSchema,
    parseParameters,
    riskFieldInfo,
    Run,
    Strategy,
    validateRunParameters,
    validateAutomaticStake,
    hasRunStopLoss,
    validateEnabledLimits,
    isSharedStakeParameter,
    numericStep,
    stepNumber,
} from './automation';
import './auto-trading.scss';

const EMPTY: AutomationState = {
    strategies: [],
    runs: [],
    selected_id: '',
    ready: false,
    busy: false,
    error: '',
    uncertain: false,
};

const RunDetails = ({
    run,
    busy,
    onControl,
}: {
    run: Run;
    busy: boolean;
    onControl: (action: 'pause' | 'resume' | 'stop') => void;
}) => {
    const money = (value?: number) =>
        value === undefined ? '—' : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return (
        <div className='auto-trading__run'>
            <p role='status'>
                {localize('Status')}: <strong>{run.status}</strong>
            </p>
            <p>
                {run.strategy_id} · {run.contract_template?.underlying_symbol} · {run.contract_template?.contract_type}
            </p>
            <p>
                {localize('Total stake')}: {money(run.total_stake)} {run.contract_template?.currency}
            </p>
            <p>
                {localize('Total payout')}: {money(run.total_payout)} {run.contract_template?.currency}
            </p>
            {run.total_stake !== undefined && run.total_payout !== undefined && (
                <p>
                    {localize('Payout minus stake')}: {money(run.total_payout - run.total_stake)}{' '}
                    {run.contract_template?.currency}
                </p>
            )}
            {run.stop_reason && (
                <p>
                    {localize('Stop reason')}: {run.stop_reason} {run.stop_reason_code}
                </p>
            )}
            <div className='auto-trading__actions'>
                {run.status === 'running' && (
                    <button type='button' disabled={busy} onClick={() => onControl('pause')}>
                        {localize('Pause')}
                    </button>
                )}
                {run.status === 'paused' && (
                    <button type='button' disabled={busy} onClick={() => onControl('resume')}>
                        {localize('Resume')}
                    </button>
                )}
                {run.status !== 'stopped' && (
                    <button
                        type='button'
                        className='auto-trading__stop'
                        disabled={busy}
                        onClick={() => onControl('stop')}
                    >
                        {localize('Stop')}
                    </button>
                )}
            </div>
            <details>
                <summary>{localize('Run settings')}</summary>
                <pre>
                    {JSON.stringify({ contract: run.contract_template, parameters: run.strategy_parameters }, null, 2)}
                </pre>
            </details>
            <details>
                <summary>
                    {localize('Contracts')} ({run.contracts?.length ?? 0})
                </summary>
                <div className='auto-trading__table'>
                    <table>
                        <thead>
                            <tr>
                                <th>{localize('Contract')}</th>
                                <th>{localize('Status')}</th>
                                <th>{localize('Buy')}</th>
                                <th>{localize('Sell')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {run.contracts?.map((contract) => (
                                <tr key={contract.contract_id}>
                                    <td>
                                        <a href={'/contract/' + contract.contract_id}>{contract.contract_id}</a>
                                    </td>
                                    <td>{contract.contract_status ?? 'open'}</td>
                                    <td>{money(contract.buy_price)}</td>
                                    <td>{money(contract.sell_price)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </details>
        </div>
    );
};

const NumberInput = ({
    id,
    name,
    definition,
    value,
    disabled,
    onChange,
}: {
    id: string;
    name: string;
    definition: ParameterSchema;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
}) => {
    const input = React.useRef<HTMLInputElement>(null);
    const step = numericStep(name, definition);
    const lower = Math.max(
        definition.minimum ?? -Infinity,
        definition.exclusiveMinimum === undefined ? -Infinity : definition.exclusiveMinimum + step,
        ['take_profit', 'stop_loss', 'max_stake'].includes(name) ? step : name === 'multiplier' ? 1 : -Infinity
    );
    const upper = Math.min(
        definition.maximum ?? Infinity,
        definition.exclusiveMaximum === undefined ? Infinity : definition.exclusiveMaximum - step
    );
    const minimum = Number.isFinite(lower) ? lower : undefined;
    const maximum = Number.isFinite(upper) ? upper : undefined;
    const move = React.useCallback(
        (direction: number) => onChange(stepNumber(value, direction, step, minimum, maximum)),
        [value, step, minimum, maximum, onChange]
    );
    React.useEffect(() => {
        const element = input.current;
        if (!element) return;
        const wheel = (event: WheelEvent) => {
            if (disabled || document.activeElement !== element || !event.deltaY) return;
            event.preventDefault();
            move(event.deltaY < 0 ? 1 : -1);
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
    }, [disabled, move]);
    const label = definition.title ?? riskFieldInfo(name).label;
    return (
        <div className='auto-trading__number'>
            <button
                type='button'
                aria-label={localize('Decrease') + ' ' + localize(label).toLowerCase()}
                disabled={disabled || (!!value && minimum !== undefined && Number(value) <= minimum)}
                onClick={() => move(-1)}
            >
                −
            </button>
            <input
                ref={input}
                id={id}
                type='number'
                inputMode={definition.type === 'integer' ? 'numeric' : 'decimal'}
                step={step}
                min={minimum}
                max={maximum}
                value={value}
                disabled={disabled}
                aria-describedby={id + '-hint'}
                placeholder={localize('Enter value')}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                        event.preventDefault();
                        move(event.key === 'ArrowUp' ? 1 : -1);
                    }
                }}
            />
            <button
                type='button'
                aria-label={localize('Increase') + ' ' + localize(label).toLowerCase()}
                disabled={disabled || (!!value && maximum !== undefined && Number(value) >= maximum)}
                onClick={() => move(1)}
            >
                +
            </button>
        </div>
    );
};

const ParameterField = ({
    name,
    definition,
    value,
    required,
    disabled,
    onChange,
}: {
    name: string;
    definition: ParameterSchema;
    value?: string;
    required: boolean;
    disabled: boolean;
    onChange: (value: string | undefined) => void;
}) => {
    const id = React.useId();
    const is_limit = name === 'take_profit' || name === 'stop_loss';
    const is_stakes = name === 'stake_list' || name === 'stakes';
    const is_numeric =
        ['number', 'integer'].includes(definition.type ?? '') ||
        (definition.type === 'string' && ['take_profit', 'stop_loss', 'max_stake'].includes(name));
    const label = is_stakes ? localize('Recovery stakes') : (definition.title ?? riskFieldInfo(name).label);
    const enabled = !is_limit || value !== undefined;
    const field_disabled = disabled || !enabled;
    return (
        <div className='auto-trading__field'>
            <div className='auto-trading__field-heading'>
                <label htmlFor={id}>
                    {localize(label)}
                    {required && !is_limit && !is_stakes ? ' *' : ''}
                </label>
                {is_limit && (
                    <>
                        <small className='auto-trading__optional'>{localize('Optional')}</small>
                        <button
                            type='button'
                            role='switch'
                            aria-checked={enabled}
                            aria-label={
                                name === 'take_profit' ? localize('Enable take profit') : localize('Enable stop loss')
                            }
                            disabled={disabled}
                            className={'auto-trading__toggle' + (enabled ? ' auto-trading__toggle--on' : '')}
                            onClick={() => onChange(enabled ? undefined : '')}
                        >
                            <span aria-hidden='true'>{enabled ? localize('On') : localize('Off')}</span>
                        </button>
                    </>
                )}
            </div>
            {is_numeric && !definition.enum ? (
                <NumberInput
                    id={id}
                    name={name}
                    definition={definition}
                    value={value ?? ''}
                    disabled={field_disabled}
                    onChange={onChange}
                />
            ) : definition.enum || definition.type === 'boolean' ? (
                <select
                    id={id}
                    value={value ?? ''}
                    disabled={field_disabled}
                    aria-describedby={id + '-hint'}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value=''>{required ? localize('Select a value') : localize('Not set')}</option>
                    {(definition.enum ?? [true, false]).map((item) => (
                        <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
                            {typeof item === 'boolean' ? (item ? localize('Yes') : localize('No')) : String(item)}
                        </option>
                    ))}
                </select>
            ) : is_stakes || definition.type === 'object' || definition.type === 'array' || !definition.type ? (
                <textarea
                    id={id}
                    value={value ?? ''}
                    disabled={field_disabled}
                    aria-describedby={id + '-hint'}
                    placeholder={is_stakes ? localize('Later stakes, separated by commas') : undefined}
                    onChange={(e) => onChange(e.target.value)}
                />
            ) : (
                <input
                    id={id}
                    type='text'
                    value={value ?? ''}
                    disabled={field_disabled}
                    aria-describedby={id + '-hint'}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
            <small id={id + '-hint'}>
                {is_limit && !enabled
                    ? localize('Off — no run limit set.')
                    : is_stakes
                      ? localize('The first stake is your Automatic stake. Enter only the later recovery stakes.')
                      : (definition.description ??
                        (name === 'max_stake'
                            ? localize('Caps later stakes; it must cover your Automatic stake.')
                            : !required
                              ? localize('Optional')
                              : ''))}
            </small>
        </div>
    );
};

type PendingStart = {
    signature: string;
    strategy: Strategy;
    template: ContractTemplate;
    parameters: Record<string, unknown>;
};

const AutoTrading = observer(
    ({ is_market_closed, onPurchaseSuccess }: { is_market_closed?: boolean; onPurchaseSuccess?: () => void }) => {
        const store = useTraderStore();
        const { client, common, ui } = useStore();
        const ws = useWS();
        const [mode, setMode] = React.useState<'manual' | 'automatic'>('manual');
        const [menu_open, setMenuOpen] = React.useState(false);
        const [state, setState] = React.useState<AutomationState>(EMPTY);
        const [strategy_id, setStrategyId] = React.useState('');
        const [values, setValues] = React.useState<Record<string, string>>({});
        const [form_error, setFormError] = React.useState('');
        const [automatic_stake, setAutomaticStake] = React.useState<string>();
        const [pending_start, setPendingStart] = React.useState<PendingStart>();
        const starting = React.useRef(false);
        const warning_dialog = React.useRef<HTMLDialogElement>(null);
        const warning_title = React.useId();
        const controller = React.useRef<AutomationController>();
        const owner = React.useRef('');
        const risk_account = React.useRef('');
        const dialog = React.useRef<HTMLDialogElement>(null);
        const title_id = React.useId();
        const method_id = React.useId();
        const connected = !!common.is_socket_opened;
        const authenticated = !!client.is_logged_in && !!client.is_authorize && !ui.is_switching_account;
        const account_id = client.loginid;
        const eligible = connected && authenticated;

        React.useEffect(() => {
            setState(EMPTY);
            setFormError('');
            if (!eligible || !account_id || !ws) return;
            const current = new AutomationController((request) => ws.send(request), setState);
            controller.current = current;
            owner.current = account_id;
            void current.refresh();
            const timer = setInterval(() => {
                void current.poll();
            }, 3000);
            return () => {
                clearInterval(timer);
                current.dispose();
                if (controller.current === current) {
                    controller.current = undefined;
                    owner.current = '';
                }
            };
        }, [account_id, eligible, ws]);

        React.useEffect(() => {
            const element = dialog.current;
            if (!element) return;
            if (menu_open && !element.open) element.showModal();
            if (!menu_open && element.open) element.close();
            if (!menu_open) return;
            const previous = document.body.style.overflow;
            document.body.style.overflow = 'hidden';
            return () => {
                document.body.style.overflow = previous;
                if (element.open) element.close();
            };
        }, [menu_open]);

        React.useEffect(() => {
            setAutomaticStake(undefined);
            setPendingStart(undefined);
        }, [account_id]);
        React.useEffect(() => {
            if (!eligible) setPendingStart(undefined);
        }, [eligible]);
        React.useEffect(() => {
            const element = warning_dialog.current;
            if (!element) return;
            if (pending_start && !element.open) element.showModal();
            if (!pending_start && element.open) element.close();
            return () => {
                if (element.open) element.close();
            };
        }, [pending_start]);
        const automatic_stake_text = automatic_stake ?? (store.basis === 'payout' ? '' : String(store.amount ?? ''));
        const contract_types = getDisplayedContractTypes(store.trade_types, store.contract_type, store.trade_type_tab);
        const contract = getSharedContractType(contract_types, store.trade_type_tab);
        const strategies = state.strategies.filter((item) => item.supported_contract_types.includes(contract));
        const fixed_strategy = getFixedStakeStrategy(strategies);
        const requested_fixed = strategy_id === '__fixed_stake__';
        const strategy = requested_fixed
            ? fixed_strategy
            : (strategies.find((item) => item.strategy_id === strategy_id) ?? strategies[0]);
        const fixed_stake = requested_fixed || !!(strategy && isFixedStakeStrategy(strategy));
        const schema = strategy ? getRunParameterSchema(strategy) : undefined;
        // Reset only when the strategy changes, not when run refreshes replace objects.
        const defaults_key = strategy ? strategy.strategy_id + String(fixed_stake) + JSON.stringify(schema) : '';
        React.useEffect(() => {
            const defaults: Record<string, string> = {};
            for (const [key, definition] of Object.entries(schema?.properties ?? {})) {
                if (key === 'take_profit' || key === 'stop_loss' || isSharedStakeParameter(key)) continue;
                if (
                    key.startsWith('max_') &&
                    !schema?.required?.includes(key) &&
                    (typeof definition.default === 'number' || typeof definition.default === 'string') &&
                    String(definition.default).trim() !== '' &&
                    Number(definition.default) === 0
                )
                    continue;
                if ((key === 'stake_list' || key === 'stakes') && Array.isArray(definition.default)) {
                    defaults[key] = JSON.stringify(definition.default.slice(1));
                    continue;
                }
                if (definition.default !== undefined)
                    defaults[key] =
                        definition.type === 'string' && !definition.enum
                            ? String(definition.default)
                            : JSON.stringify(definition.default);
            }
            const same_account = risk_account.current === account_id;
            risk_account.current = account_id ?? '';
            setValues((previous) => ({
                ...defaults,
                ...Object.fromEntries(
                    Object.entries(previous).filter(
                        ([key]) =>
                            same_account && !!schema?.properties?.[key] && riskFieldInfo(key).group === 'protection'
                    )
                ),
            }));
            setFormError('');
            // schema is represented by defaults_key so an unchanged refresh preserves edits.
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [defaults_key, account_id]);

        let template: ContractTemplate | undefined;
        let template_error = '';
        if (contract) {
            try {
                template = buildTemplate(
                    getProposalRequestObject({
                        new_values: { amount: validateAutomaticStake(automatic_stake_text), basis: 'stake' },
                        trade_store: store,
                        trade_type: contract,
                    }) as Record<string, unknown>
                );
            } catch (error) {
                template_error = messageOf(error);
            }
        } else template_error = localize('Choose a contract direction in the trading form above.');
        const run = state.runs.find((item) => item.run_id === state.selected_id);
        const active_run = state.runs.find((item) => item.status !== 'stopped');
        const proposal_error = !!store.proposal_info?.[contract]?.has_error;
        let parameters: Record<string, unknown> | undefined;
        let parameters_error = '';
        if (strategy && template) {
            try {
                validateEnabledLimits(values);
                parameters = parseParameters(strategy, getMethodValues(strategy, values, fixed_stake), template);
                validateRunParameters(strategy, template, parameters);
            } catch (error) {
                parameters = undefined;
                parameters_error = messageOf(error);
            }
        }
        const can_start =
            owner.current === account_id &&
            eligible &&
            state.ready &&
            !state.busy &&
            !state.uncertain &&
            !active_run &&
            !is_market_closed &&
            !!template &&
            !!parameters &&
            !proposal_error &&
            store.is_trade_enabled_v2;
        const start_signature = JSON.stringify({
            account_id,
            strategy_id: strategy?.strategy_id,
            template,
            parameters,
        });
        const executeStart = async (snapshot: PendingStart) => {
            if (starting.current) return;
            setPendingStart(undefined);
            if (!can_start || snapshot.signature !== start_signature || !controller.current) {
                setFormError(localize('Trade settings changed. Review them and press Start again.'));
                return;
            }
            starting.current = true;
            setFormError('');
            try {
                await controller.current.start(snapshot.strategy, snapshot.template, snapshot.parameters);
            } catch (error) {
                setFormError(messageOf(error));
            } finally {
                starting.current = false;
            }
        };
        const start = async () => {
            if (
                !can_start ||
                !strategy ||
                !template ||
                !parameters ||
                !controller.current ||
                starting.current ||
                pending_start
            )
                return;
            setFormError('');
            const snapshot: PendingStart = {
                signature: start_signature,
                strategy: JSON.parse(JSON.stringify(strategy)),
                template: JSON.parse(JSON.stringify(template)),
                parameters: JSON.parse(JSON.stringify(parameters)),
            };
            if (!hasRunStopLoss(parameters)) {
                setPendingStart(snapshot);
                return;
            }
            await executeStart(snapshot);
        };
        const control = async (action: 'pause' | 'resume' | 'stop', target = run) => {
            if (!eligible || owner.current !== account_id || !target || !controller.current) return;
            setFormError('');
            try {
                await controller.current.control(action, target.run_id);
            } catch (error) {
                setFormError(messageOf(error));
            }
        };
        const stake_input = (
            <ParameterField
                name='automatic_stake'
                definition={{
                    type: 'number',
                    title: localize('Automatic stake') + ' (' + store.currency + ')',
                    exclusiveMinimum: 0,
                    multipleOf: 10 ** -getDecimalPlaces(store.currency),
                    description: localize(
                        'Initial stake for Automatic. Prefilled from Manual; edit it here for this run.'
                    ),
                }}
                value={automatic_stake_text}
                required
                disabled={state.busy || !!active_run}
                onChange={(value) => {
                    setAutomaticStake(value ?? '');
                    setFormError('');
                }}
            />
        );
        const fields = Object.entries(schema?.properties ?? {}).filter(([key]) => !isSharedStakeParameter(key));
        const has_recovery = !fixed_stake && fields.some(([key]) => riskFieldInfo(key).group === 'recovery');
        const has_cooldown = fields.some(([key]) => riskFieldInfo(key).group === 'cooldown');
        const renderFields = (group: string) =>
            fields
                .filter(([key]) => riskFieldInfo(key).group === group)
                .map(([key, definition]) => (
                    <ParameterField
                        key={strategy?.strategy_id + key}
                        name={key}
                        definition={definition}
                        value={values[key]}
                        required={schema?.required?.includes(key) ?? false}
                        disabled={state.busy}
                        onChange={(value) =>
                            setValues((previous) => {
                                const next = { ...previous };
                                if (value === undefined) delete next[key];
                                else next[key] = value;
                                return next;
                            })
                        }
                    />
                ));
        const errors = (
            <>
                {(form_error || state.error) && (
                    <p role='alert' className='auto-trading__error'>
                        {form_error || state.error}
                    </p>
                )}
                {state.uncertain && (
                    <p role='alert'>
                        {localize(
                            'The last command may have reached the server. Refresh and review your runs before starting another.'
                        )}
                    </p>
                )}
            </>
        );
        const menu = (
            <dialog
                ref={dialog}
                className='auto-trading-menu'
                onTouchStart={(event) => event.stopPropagation()}
                onTouchEnd={(event) => event.stopPropagation()}
                aria-labelledby={title_id}
                onClose={() => setMenuOpen(false)}
                onClick={(event) => {
                    if (event.target !== event.currentTarget) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (
                        event.clientX < rect.left ||
                        event.clientX > rect.right ||
                        event.clientY < rect.top ||
                        event.clientY > rect.bottom
                    )
                        setMenuOpen(false);
                }}
            >
                <div className='auto-trading auto-trading--menu'>
                    <header className='auto-trading__menu-header'>
                        <div>
                            <small>{localize('AUTOMATIC TRADING')}</small>
                            <h2 id={title_id}>{localize('Risk management')}</h2>
                        </div>
                        <button
                            type='button'
                            className='auto-trading__close'
                            aria-label={localize('Close automatic settings')}
                            onClick={() => setMenuOpen(false)}
                        >
                            ×
                        </button>
                    </header>
                    <div
                        className='auto-trading__menu-body'
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                    >
                        {menu_open && (
                            <section className='auto-trading__card'>
                                {stake_input}
                                {template_error && (
                                    <p role='alert' className='auto-trading__error'>
                                        {template_error}
                                    </p>
                                )}
                            </section>
                        )}
                        <div className='auto-trading__account'>
                            <span>
                                {localize('Account')}: {account_id || '—'}
                            </span>
                            <button
                                type='button'
                                disabled={!eligible || state.busy}
                                onClick={() => {
                                    void controller.current?.refresh();
                                }}
                            >
                                {state.busy ? localize('Loading…') : localize('Refresh')}
                            </button>
                        </div>
                        {!authenticated && (
                            <p role='status'>
                                {localize('Sign in and wait for your account to connect to use automatic trading.')}
                            </p>
                        )}
                        {!connected && (
                            <p role='status'>{localize('Connection lost. Reconnect to manage your runs.')}</p>
                        )}
                        {errors}
                        {state.ready && !strategies.length && (
                            <p role='status'>
                                {localize(
                                    'No automatic strategies support this contract. Choose another contract in the trading form.'
                                )}
                            </p>
                        )}
                        {requested_fixed && !fixed_strategy && (
                            <p role='alert'>
                                {localize('Fixed stake is not available for this contract.')}{' '}
                                <button type='button' onClick={() => setStrategyId('')}>
                                    {localize('Choose another method')}
                                </button>
                            </p>
                        )}
                        {strategy && (
                            <>
                                <section className='auto-trading__card'>
                                    <h3>{localize('Trading method')}</h3>
                                    <div className='auto-trading__field'>
                                        <label htmlFor={method_id}>{localize('Stake method')}</label>
                                        <select
                                            id={method_id}
                                            value={fixed_stake ? '__fixed_stake__' : strategy.strategy_id}
                                            disabled={state.busy}
                                            onChange={(e) => setStrategyId(e.target.value)}
                                        >
                                            <option value='__fixed_stake__' disabled={!fixed_strategy}>
                                                {localize('No martingale — fixed stake')}
                                            </option>
                                            {strategies
                                                .filter((item) => !isFixedStakeStrategy(item))
                                                .map((item) => (
                                                    <option key={item.strategy_id} value={item.strategy_id}>
                                                        {item.display_name}
                                                    </option>
                                                ))}
                                        </select>
                                    </div>
                                    <p>
                                        {fixed_stake
                                            ? localize('Keeps the initial stake unchanged after wins and losses.')
                                            : strategy.description}
                                    </p>
                                    <small>
                                        {localize(
                                            'Available methods depend on the selected contract and supported strategies.'
                                        )}
                                    </small>
                                </section>
                                <section className='auto-trading__card'>
                                    <h3>{localize('Run protection')}</h3>
                                    <p>
                                        {localize(
                                            'Profit and loss limits apply to the whole automatic run. Contract limits in the trading form still apply to each trade.'
                                        )}
                                    </p>
                                    <div className='auto-trading__fields'>{renderFields('protection')}</div>
                                    <small>
                                        {localize(
                                            'Switch take profit or stop loss off to leave that limit unset. A limit can be exceeded by an open trade before it settles.'
                                        )}
                                    </small>
                                </section>
                                {has_recovery && (
                                    <section className='auto-trading__card'>
                                        <h3>{localize('Stake recovery')}</h3>
                                        <div className='auto-trading__fields'>{renderFields('recovery')}</div>
                                        <small>
                                            {localize(
                                                'The first trade uses your Automatic stake. Recovery can increase later stakes after losses.'
                                            )}
                                        </small>
                                    </section>
                                )}
                                <section className='auto-trading__card'>
                                    <h3>{localize('Cooldown after a streak')}</h3>
                                    {has_cooldown ? (
                                        <div className='auto-trading__fields'>{renderFields('cooldown')}</div>
                                    ) : (
                                        <p>{localize('Cooldown is not available with this strategy.')}</p>
                                    )}
                                </section>
                                {fields.some(([key]) => riskFieldInfo(key).group === 'advanced') && (
                                    <details className='auto-trading__card'>
                                        <summary>{localize('More strategy settings')}</summary>
                                        <div className='auto-trading__fields'>{renderFields('advanced')}</div>
                                    </details>
                                )}
                                {parameters_error && (
                                    <p role='alert' className='auto-trading__error'>
                                        {parameters_error}
                                    </p>
                                )}
                            </>
                        )}
                        {!!state.runs.length && (
                            <section className='auto-trading__card'>
                                <h3>{localize('Trading runs')}</h3>
                                <label>
                                    {localize('Select run')}
                                    <select
                                        value={state.selected_id}
                                        disabled={state.busy}
                                        onChange={(e) => controller.current?.select(e.target.value)}
                                    >
                                        {state.runs.map((item) => (
                                            <option key={item.run_id} value={item.run_id}>
                                                {item.run_id} · {item.status}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                {run && (
                                    <RunDetails
                                        run={run}
                                        busy={state.busy || !eligible || owner.current !== account_id}
                                        onControl={(action) => {
                                            void control(action);
                                        }}
                                    />
                                )}
                            </section>
                        )}
                        <p className='auto-trading__notice'>
                            {localize(
                                'Runs continue when you close this menu, leave the page or switch to Manual. Use Stop to end a run; open contracts may still need to settle.'
                            )}
                        </p>
                    </div>
                    <footer className='auto-trading__menu-footer'>
                        <div className='auto-trading__footer-actions'>
                            <button type='button' onClick={() => setMenuOpen(false)}>
                                {localize('Done')}
                            </button>
                            {active_run ? (
                                <button
                                    type='button'
                                    className='auto-trading__stop'
                                    disabled={state.busy || !eligible}
                                    onClick={() => {
                                        void control('stop', active_run);
                                    }}
                                >
                                    {localize('Stop')}
                                </button>
                            ) : (
                                <button
                                    type='button'
                                    className='auto-trading__start'
                                    disabled={!can_start || !!pending_start}
                                    onClick={() => {
                                        setMenuOpen(false);
                                        void start();
                                    }}
                                >
                                    {state.busy ? localize('Please wait…') : localize('Start automatic trading')}
                                </button>
                            )}
                        </div>
                        <small>{localize('Closing settings does not place a trade.')}</small>
                    </footer>
                </div>
            </dialog>
        );
        const warning = (
            <dialog
                ref={warning_dialog}
                role='alertdialog'
                className='auto-trading-confirm'
                aria-labelledby={warning_title}
                aria-describedby={warning_title + '-description'}
                onClose={() => setPendingStart(undefined)}
            >
                <div className='auto-trading auto-trading--confirmation'>
                    <h2 id={warning_title}>{localize('Start without a stop loss?')}</h2>
                    <p id={warning_title + '-description'}>
                        {localize(
                            'No stop loss is set for this automatic run. Trading can continue until you stop it or another run limit is reached.'
                        )}
                    </p>
                    {pending_start && (
                        <p>
                            <strong>
                                {localize('Initial stake')}: {pending_start.template.amount}{' '}
                                {pending_start.template.currency}
                            </strong>
                        </p>
                    )}
                    <div className='auto-trading__actions'>
                        <button type='button' autoFocus onClick={() => setPendingStart(undefined)}>
                            {localize('Cancel')}
                        </button>
                        <button
                            type='button'
                            className='auto-trading__start'
                            disabled={!can_start}
                            onClick={() => {
                                if (pending_start) void executeStart(pending_start);
                            }}
                        >
                            {localize('Start without stop loss')}
                        </button>
                    </div>
                </div>
            </dialog>
        );
        return (
            <section className='auto-trading' aria-label={localize('Trade execution')}>
                <div className='auto-trading__modes' role='group' aria-label={localize('Trading mode')}>
                    <button
                        type='button'
                        aria-pressed={mode === 'manual'}
                        onClick={() => {
                            setMode('manual');
                            setMenuOpen(false);
                        }}
                    >
                        {localize('Manual')}
                    </button>
                    <button type='button' aria-pressed={mode === 'automatic'} onClick={() => setMode('automatic')}>
                        {localize('Automatic')}
                    </button>
                </div>
                {mode === 'manual' ? (
                    <>
                        {active_run && (
                            <p className='auto-trading__notice' role='status'>
                                {localize('An automatic run is active. Open Automatic to manage it.')}
                            </p>
                        )}
                        {!is_market_closed && <PurchaseButton onPurchaseSuccess={onPurchaseSuccess} />}
                    </>
                ) : (
                    <div className='auto-trading__compact'>
                        <button
                            type='button'
                            className='auto-trading__settings'
                            aria-haspopup='dialog'
                            aria-expanded={menu_open}
                            onClick={() => setMenuOpen(true)}
                        >
                            <span>⚙ {localize('Automatic settings')}</span>
                            <span aria-hidden='true'>›</span>
                        </button>
                        <small>{localize('Using your selected market and contract settings')}</small>
                        {strategy && (
                            <p>
                                <strong>{fixed_stake ? localize('No martingale') : strategy.display_name}</strong>
                                {template ? ' · ' + String(template.amount) + ' ' + template.currency : ''}
                            </p>
                        )}
                        {template_error && (
                            <p role='alert' className='auto-trading__error'>
                                {template_error}
                            </p>
                        )}
                        {parameters_error && (
                            <p role='alert' className='auto-trading__error'>
                                {parameters_error}
                            </p>
                        )}
                        {!eligible && (
                            <p role='status'>{localize('Connect your account to start automatic trading.')}</p>
                        )}
                        {is_market_closed && <p role='status'>{localize('The selected market is closed.')}</p>}
                        {proposal_error && (
                            <p role='alert'>{localize('Correct the trade settings before starting.')}</p>
                        )}
                        {errors}
                        <div className='auto-trading__execution'>
                            {active_run ? (
                                <div className='auto-trading__active'>
                                    <p role='status'>
                                        {localize('Run status')}: {active_run.status}
                                    </p>
                                    <div className='auto-trading__actions'>
                                        <button
                                            type='button'
                                            disabled={state.busy || !eligible}
                                            onClick={() => {
                                                void control(
                                                    active_run.status === 'paused' ? 'resume' : 'pause',
                                                    active_run
                                                );
                                            }}
                                        >
                                            {active_run.status === 'paused' ? localize('Resume') : localize('Pause')}
                                        </button>
                                        <button
                                            type='button'
                                            className='auto-trading__stop'
                                            disabled={state.busy || !eligible}
                                            onClick={() => {
                                                void control('stop', active_run);
                                            }}
                                        >
                                            {localize('Stop')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <button
                                    type='button'
                                    className='auto-trading__start'
                                    disabled={!can_start || !!pending_start}
                                    onClick={() => {
                                        void start();
                                    }}
                                >
                                    {state.busy ? localize('Please wait…') : localize('Start automatic trading')}
                                </button>
                            )}
                        </div>
                    </div>
                )}
                {typeof document !== 'undefined' &&
                    createPortal(
                        <>
                            {menu}
                            {warning}
                        </>,
                        document.body
                    )}
            </section>
        );
    }
);
export default AutoTrading;
