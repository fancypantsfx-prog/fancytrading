import React from 'react';
import { observer } from 'mobx-react-lite';

import { useWS } from '@deriv/shared';
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
    getParameterSchema,
    messageOf,
    parseParameters,
    Run,
    Strategy,
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
        <div className="auto-trading__run">
            <p role="status">
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
            <div className="auto-trading__actions">
                {run.status === 'running' && (
                    <button type="button" disabled={busy} onClick={() => onControl('pause')}>
                        {localize('Pause')}
                    </button>
                )}
                {run.status === 'paused' && (
                    <button type="button" disabled={busy} onClick={() => onControl('resume')}>
                        {localize('Resume')}
                    </button>
                )}
                {run.status !== 'stopped' && (
                    <button
                        type="button"
                        className="auto-trading__stop"
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
                <div className="auto-trading__table">
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

// Mounted in both AppV2 layouts. Keep the manual purchase component and its success callback intact.
const AutoTrading = observer(
    ({ is_market_closed, onPurchaseSuccess }: { is_market_closed?: boolean; onPurchaseSuccess?: () => void }) => {
        const store = useTraderStore();
        const { client, common, ui } = useStore();
        const ws = useWS();
        const [mode, setMode] = React.useState<'manual' | 'automatic'>('manual');
        const [state, setState] = React.useState<AutomationState>(EMPTY);
        const [strategy_id, setStrategyId] = React.useState('');
        const [selected_contract, setSelectedContract] = React.useState('');
        const [values, setValues] = React.useState<Record<string, string>>({});
        const [form_error, setFormError] = React.useState('');
        const controller = React.useRef<AutomationController>();
        const owner = React.useRef('');
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

        const contract_types = getDisplayedContractTypes(store.trade_types, store.contract_type, store.trade_type_tab);
        const strategies = state.strategies.filter((strategy) =>
            contract_types.some((type) => strategy.supported_contract_types.includes(type)),
        );
        const strategy = strategies.find((item) => item.strategy_id === strategy_id) ?? strategies[0];
        const supported = contract_types.filter((type) => strategy?.supported_contract_types.includes(type));
        const contract = supported.includes(selected_contract) ? selected_contract : (supported[0] ?? '');
        const schema = strategy ? getParameterSchema(strategy) : undefined;

        React.useEffect(() => {
            const defaults: Record<string, string> = {};
            if (strategy) {
                for (const [key, definition] of Object.entries(getParameterSchema(strategy).properties ?? {})) {
                    if (definition.default !== undefined)
                        defaults[key] =
                            definition.type === 'string' && !definition.enum
                                ? String(definition.default)
                                : JSON.stringify(definition.default);
                }
            }
            setValues(defaults);
            setFormError('');
        }, [strategy]);

        let template: ContractTemplate | undefined;
        let template_error = '';
        if (contract) {
            try {
                template = buildTemplate(
                    getProposalRequestObject({ new_values: {}, trade_store: store, trade_type: contract }) as Record<
                        string,
                        unknown
                    >,
                );
            } catch (error) {
                template_error = messageOf(error);
            }
        }
        const run = state.runs.find((item) => item.run_id === state.selected_id);
        const has_active = state.runs.some((item) => item.status !== 'stopped');
        const proposal_error = !!store.proposal_info?.[contract]?.has_error;
        const can_start =
            owner.current === account_id &&
            eligible &&
            state.ready &&
            !state.busy &&
            !state.uncertain &&
            !has_active &&
            !is_market_closed &&
            !!template &&
            !proposal_error &&
            store.is_trade_enabled_v2;
        const start = async () => {
            setFormError('');
            if (!can_start || !strategy || !template || !controller.current) return;
            try {
                await controller.current.start(strategy, template, parseParameters(strategy, values));
            } catch (error) {
                setFormError(messageOf(error));
            }
        };
        const control = async (action: 'pause' | 'resume' | 'stop') => {
            if (!eligible || owner.current !== account_id || !run || !controller.current) return;
            setFormError('');
            try {
                await controller.current.control(action, run.run_id);
            } catch (error) {
                setFormError(messageOf(error));
            }
        };

        return (
            <section className="auto-trading" aria-label={localize('Trade execution')}>
                <div className="auto-trading__modes" role="group" aria-label={localize('Trading mode')}>
                    <button type="button" aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
                        {localize('Manual')}
                    </button>
                    <button type="button" aria-pressed={mode === 'automatic'} onClick={() => setMode('automatic')}>
                        {localize('Automatic')}
                    </button>
                </div>
                {has_active && mode === 'manual' && (
                    <p role="status">{localize('An automatic run is active. Open Automatic to manage it.')}</p>
                )}
                {mode === 'manual' ? (
                    !is_market_closed && <PurchaseButton onPurchaseSuccess={onPurchaseSuccess} />
                ) : (
                    <div
                        className="auto-trading__panel"
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                    >
                        <p>
                            {localize(
                                'Automatic runs use the contract settings above. Runs continue on the server when you leave this page or switch to Manual. Use Stop to stop a run. Open contracts may still need to settle.',
                            )}
                        </p>
                        <p>
                            {localize('Account')}: {account_id || '—'}
                        </p>
                        {!authenticated && (
                            <p role="status">
                                {localize('Sign in and wait for your account to connect to use automatic trading.')}
                            </p>
                        )}
                        {!connected && (
                            <p role="status">
                                {localize('Connection lost. Run status may be out of date. Reconnect to manage runs.')}
                            </p>
                        )}
                        <button
                            type="button"
                            disabled={!eligible || state.busy}
                            onClick={() => {
                                void controller.current?.refresh();
                            }}
                        >
                            {state.busy ? localize('Loading…') : localize('Refresh runs and strategies')}
                        </button>
                        {(form_error || state.error) && (
                            <p role="alert" className="auto-trading__error">
                                {form_error || state.error}
                            </p>
                        )}
                        {state.uncertain && (
                            <p role="alert">
                                {localize(
                                    'The last command may have reached the server. Refresh runs and review their status before starting another run.',
                                )}
                            </p>
                        )}
                        {state.ready && !strategies.length && (
                            <p>
                                {localize(
                                    'No automatic strategies support the currently selected contract. Choose another contract above.',
                                )}
                            </p>
                        )}
                        {strategy && (
                            <>
                                <label>
                                    {localize('Strategy')}
                                    <select
                                        value={strategy.strategy_id}
                                        disabled={state.busy}
                                        onChange={(e) => setStrategyId(e.target.value)}
                                    >
                                        {strategies.map((item) => (
                                            <option key={item.strategy_id} value={item.strategy_id}>
                                                {item.display_name}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <p>{strategy.description}</p>
                                <label>
                                    {localize('Contract direction')}
                                    <select
                                        value={contract}
                                        disabled={state.busy}
                                        onChange={(e) => setSelectedContract(e.target.value)}
                                    >
                                        {supported.map((type) => (
                                            <option key={type} value={type}>
                                                {type}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                {Object.entries(schema?.properties ?? {}).map(([key, definition]) => (
                                    <label key={strategy.strategy_id + key}>
                                        {definition.title ?? key}
                                        {schema?.required?.includes(key) ? ' *' : ''}
                                        {definition.enum || definition.type === 'boolean' ? (
                                            <select
                                                value={values[key] ?? ''}
                                                disabled={state.busy}
                                                onChange={(e) =>
                                                    setValues((previous) => ({ ...previous, [key]: e.target.value }))
                                                }
                                            >
                                                <option value="">{localize('Select a value')}</option>
                                                {(definition.enum ?? [true, false]).map((item) => (
                                                    <option key={JSON.stringify(item)} value={JSON.stringify(item)}>
                                                        {String(item)}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : definition.type === 'object' ||
                                          definition.type === 'array' ||
                                          !definition.type ? (
                                            <textarea
                                                value={values[key] ?? ''}
                                                disabled={state.busy}
                                                onChange={(e) =>
                                                    setValues((previous) => ({ ...previous, [key]: e.target.value }))
                                                }
                                            />
                                        ) : (
                                            <input
                                                type={
                                                    ['number', 'integer'].includes(definition.type) ? 'number' : 'text'
                                                }
                                                step={definition.type === 'integer' ? 1 : 'any'}
                                                min={definition.minimum}
                                                max={definition.maximum}
                                                value={values[key] ?? ''}
                                                disabled={state.busy}
                                                onChange={(e) =>
                                                    setValues((previous) => ({ ...previous, [key]: e.target.value }))
                                                }
                                            />
                                        )}
                                        {definition.description && <small>{definition.description}</small>}
                                    </label>
                                ))}
                                {template_error && <p role="alert">{template_error}</p>}
                                {proposal_error && (
                                    <p role="alert">
                                        {localize('Correct the contract settings before starting a run.')}
                                    </p>
                                )}
                                {is_market_closed && <p>{localize('The selected market is closed.')}</p>}
                                {template && (
                                    <details>
                                        <summary>{localize('Review contract template')}</summary>
                                        <pre>{JSON.stringify(template, null, 2)}</pre>
                                    </details>
                                )}
                                {has_active && <p>{localize('Stop the active run before starting another.')}</p>}
                                <button
                                    type="button"
                                    className="auto-trading__start"
                                    disabled={!can_start}
                                    onClick={() => {
                                        void start();
                                    }}
                                >
                                    {localize('Start automatic trading')}
                                </button>
                            </>
                        )}
                        {!!state.runs.length && (
                            <label>
                                {localize('Trading runs')}
                                <select
                                    value={state.selected_id}
                                    disabled={state.busy}
                                    onChange={(e) => controller.current?.select(e.target.value)}
                                >
                                    {state.runs.map((item) => (
                                        <option value={item.run_id} key={item.run_id}>
                                            {item.run_id} · {item.status}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {run && (
                            <RunDetails
                                run={run}
                                busy={state.busy || !eligible || owner.current !== account_id}
                                onControl={(action) => {
                                    void control(action);
                                }}
                            />
                        )}
                        {state.updated_at && (
                            <small>
                                {localize('Last updated')}: {new Date(state.updated_at).toLocaleTimeString()}
                            </small>
                        )}
                    </div>
                )}
            </section>
        );
    },
);

export default AutoTrading;
