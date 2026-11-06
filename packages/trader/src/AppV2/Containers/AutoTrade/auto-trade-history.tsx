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
    runs: TAutoRun[];
    currency: string;
    is_loading: boolean;
};

const AutoTradeHistory = ({ runs, currency, is_loading }: TProps) => {
    const finished_runs = [...runs]
        .filter(run => run.status === 'stopped')
        .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0));

    return (
        <section className='auto-trade__card' data-testid='dt_auto_trade_history'>
            <h2 className='auto-trade__title'>
                <Localize i18n_default_text='Previous runs' />
            </h2>
            {is_loading && (
                <p className='auto-trade__muted'>
                    <Localize i18n_default_text='Loading…' />
                </p>
            )}
            {!is_loading && !finished_runs.length && (
                <p className='auto-trade__muted'>
                    <Localize i18n_default_text='Your finished runs will show up here.' />
                </p>
            )}
            {finished_runs.length > 0 && (
                <div className='auto-trade__table-wrapper'>
                    <table className='auto-trade__table'>
                        <thead>
                            <tr>
                                <th>
                                    <Localize i18n_default_text='Started' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Strategy' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Market' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Trades' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Profit / loss' />
                                </th>
                                <th>
                                    <Localize i18n_default_text='Ended because' />
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {finished_runs.map(run => {
                                const stats = getRunStats(run);
                                const { contract_template: template } = run;
                                const reason = getStopReasonText(run.stop_reason);
                                return (
                                    <tr key={run.run_id}>
                                        <td>{formatEpoch(run.start_time)}</td>
                                        <td>{humanizeKey(run.strategy_id)}</td>
                                        <td>
                                            {template.underlying_symbol ? getSymbolDisplayName(template.underlying_symbol) : '-'}
                                            {template.contract_type
                                                ? ` · ${CONTRACT_TYPE_LABELS[template.contract_type] ?? template.contract_type}`
                                                : ''}
                                        </td>
                                        <td>{stats.total}</td>
                                        <td
                                            className={
                                                stats.profit > 0
                                                    ? 'auto-trade__stat-value--profit'
                                                    : stats.profit < 0
                                                      ? 'auto-trade__stat-value--loss'
                                                      : ''
                                            }
                                        >
                                            {formatMoney(stats.profit, template.currency ?? currency)}
                                        </td>
                                        <td>
                                            {reason ? localize(reason) : '-'}
                                            {run.stop_reason_code ? ` (${run.stop_reason_code})` : ''}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
        </section>
    );
};

export default AutoTradeHistory;
