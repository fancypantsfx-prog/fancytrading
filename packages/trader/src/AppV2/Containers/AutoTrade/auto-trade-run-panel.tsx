import React from 'react';

import type { TAutoRun } from '@deriv/api';
import { getSymbolDisplayName } from '@deriv/shared';
import { Localize, localize } from '@deriv-com/translations';

import {
    CONTRACT_TYPE_LABELS,
    formatEpoch,
    formatMoney,
    getRunStats,
    getStopReasonText,
    humanizeKey,
} from 'AppV2/Utils/auto-trade-utils';

type TProps = {
    run: TAutoRun;
    currency: string;
    is_busy: boolean;
    onPause: () => void;
    onResume: () => void;
    onStop: () => void;
    onDismiss: () => void;
};

const MAX_CONTRACT_ROWS = 20;

const STATUS_LABEL: Record<TAutoRun['status'], () => string> = {
    running: () => localize('Running'),
    paused: () => localize('Paused'),
    stopped: () => localize('Stopped'),
};

const AutoTradeRunPanel = ({ run, currency, is_busy, onPause, onResume, onStop, onDismiss }: TProps) => {
    const [is_confirming_stop, setIsConfirmingStop] = React.useState(false);
    const stats = getRunStats(run);
    const { contract_template: template } = run;
    const is_stopped = run.status === 'stopped';
    const contracts = [...(run.contracts ?? [])].sort((a, b) => b.purchase_time - a.purchase_time);
    const stop_text = getStopReasonText(run.stop_reason);

    React.useEffect(() => {
        if (is_stopped) setIsConfirmingStop(false);
    }, [is_stopped]);

    const params = Object.entries(run.strategy_parameters ?? {});

    return (
        <section className='auto-trade__card' data-testid='dt_auto_trade_run_panel'>
            <div className='auto-trade__card-header'>
                <div>
                    <h2 className='auto-trade__title'>
                        {run.strategy_id ? humanizeKey(run.strategy_id) : <Localize i18n_default_text='Auto run' />}
                    </h2>
                    <p className='auto-trade__muted'>
                        {template.underlying_symbol ? getSymbolDisplayName(template.underlying_symbol) : '-'} ·{' '}
                        {template.contract_type
                            ? CONTRACT_TYPE_LABELS[template.contract_type] ?? template.contract_type
                            : '-'}
                        {template.amount !== undefined && ` · ${formatMoney(template.amount, template.currency ?? currency)}`}
                    </p>
                </div>
                <span className={`auto-trade__pill auto-trade__pill--${run.status}`} data-testid='dt_auto_trade_status'>
                    {STATUS_LABEL[run.status]()}
                </span>
            </div>

            <div className='auto-trade__stats'>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Profit / loss' />
                    </span>
                    <span
                        className={`auto-trade__stat-value ${
                            stats.profit > 0 ? 'auto-trade__stat-value--profit' : stats.profit < 0 ? 'auto-trade__stat-value--loss' : ''
                        }`}
                        data-testid='dt_auto_trade_profit'
                    >
                        {formatMoney(stats.profit, currency)}
                    </span>
                </div>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Trades' />
                    </span>
                    <span className='auto-trade__stat-value'>{stats.total}</span>
                </div>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Won / lost' />
                    </span>
                    <span className='auto-trade__stat-value'>
                        {stats.wins} / {stats.losses}
                    </span>
                </div>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Open' />
                    </span>
                    <span className='auto-trade__stat-value'>{stats.open}</span>
                </div>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Total stake' />
                    </span>
                    <span className='auto-trade__stat-value'>{formatMoney(stats.total_stake)}</span>
                </div>
                <div className='auto-trade__stat'>
                    <span className='auto-trade__stat-label'>
                        <Localize i18n_default_text='Total payout' />
                    </span>
                    <span className='auto-trade__stat-value'>{formatMoney(stats.total_payout)}</span>
                </div>
            </div>

            {params.length > 0 && (
                <p className='auto-trade__muted'>
                    {params.map(([key, value]) => `${humanizeKey(key)}: ${String(value)}`).join(' · ')}
                </p>
            )}
            <p className='auto-trade__muted'>
                <Localize i18n_default_text='Started {{time}}' values={{ time: formatEpoch(run.start_time) }} />
                {is_stopped && run.stop_time ? ` · ${localize('Stopped {{time}}', { time: formatEpoch(run.stop_time) })}` : ''}
            </p>
            {is_stopped && (stop_text || run.stop_reason_code) && (
                <p className='auto-trade__muted' data-testid='dt_auto_trade_stop_reason'>
                    {stop_text ? localize(stop_text) : ''}
                    {run.stop_reason_code ? ` (${run.stop_reason_code})` : ''}
                </p>
            )}

            {/* ---------------- Controls ---------------- */}
            <div className='auto-trade__actions'>
                {!is_stopped && !is_confirming_stop && (
                    <React.Fragment>
                        {run.status === 'running' ? (
                            <button
                                type='button'
                                className='auto-trade__button'
                                onClick={onPause}
                                disabled={is_busy}
                                data-testid='dt_auto_trade_pause'
                            >
                                <Localize i18n_default_text='Pause' />
                            </button>
                        ) : (
                            <button
                                type='button'
                                className='auto-trade__button auto-trade__button--primary'
                                onClick={onResume}
                                disabled={is_busy}
                                data-testid='dt_auto_trade_resume'
                            >
                                <Localize i18n_default_text='Resume' />
                            </button>
                        )}
                        <button
                            type='button'
                            className='auto-trade__button auto-trade__button--danger'
                            onClick={() => setIsConfirmingStop(true)}
                            disabled={is_busy}
                            data-testid='dt_auto_trade_stop'
                        >
                            <Localize i18n_default_text='Stop' />
                        </button>
                    </React.Fragment>
                )}

                {!is_stopped && is_confirming_stop && (
                    <React.Fragment>
                        <span className='auto-trade__muted'>
                            <Localize i18n_default_text='Stop this run? Trades already open will keep running until they finish.' />
                        </span>
                        <button
                            type='button'
                            className='auto-trade__button auto-trade__button--danger'
                            onClick={onStop}
                            disabled={is_busy}
                            data-testid='dt_auto_trade_stop_confirm'
                        >
                            <Localize i18n_default_text='Yes, stop' />
                        </button>
                        <button type='button' className='auto-trade__button' onClick={() => setIsConfirmingStop(false)}>
                            <Localize i18n_default_text='Keep running' />
                        </button>
                    </React.Fragment>
                )}

                {is_stopped && (
                    <button type='button' className='auto-trade__button auto-trade__button--primary' onClick={onDismiss}>
                        <Localize i18n_default_text='Set up a new run' />
                    </button>
                )}
            </div>

            {/* ---------------- Contracts ---------------- */}
            {contracts.length > 0 && (
                <div className='auto-trade__table-wrapper'>
                    <table className='auto-trade__table'>
                        <thead>
                            <tr>
                                <th>
                                    <Localize i18n_default_text='Contract' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Bought' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Stake' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Payout' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Result' />
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {contracts.slice(0, MAX_CONTRACT_ROWS).map(contract => {
                                const status = contract.contract_status ?? 'open';
                                return (
                                    <tr key={contract.contract_id}>
                                        <td>{contract.contract_id}</td>
                                        <td>{formatEpoch(contract.purchase_time)}</td>
                                        <td>{formatMoney(contract.buy_price)}</td>
                                        <td>{contract.sell_price !== undefined ? formatMoney(contract.sell_price) : '-'}</td>
                                        <td>
                                            <span className={`auto-trade__result auto-trade__result--${status}`}>
                                                {status === 'won'
                                                    ? localize('Won')
                                                    : status === 'lost'
                                                      ? localize('Lost')
                                                      : localize('Open')}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                    {contracts.length > MAX_CONTRACT_ROWS && (
                        <p className='auto-trade__muted'>
                            <Localize
                                i18n_default_text='Showing the latest {{count}} of {{total}} trades.'
                                values={{ count: MAX_CONTRACT_ROWS, total: contracts.length }}
                            />
                        </p>
                    )}
                </div>
            )}
        </section>
    );
};

export default AutoTradeRunPanel;
