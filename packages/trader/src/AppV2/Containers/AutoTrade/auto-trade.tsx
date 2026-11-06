import React from 'react';
import { useHistory } from 'react-router-dom';
import { observer } from 'mobx-react-lite';

import type { TAutoContractTemplate, TAutoDurationUnit, TAutoStrategyParameters } from '@deriv/api';
import { getSymbolDisplayName, routes } from '@deriv/shared';
import { useStore } from '@deriv/stores';
import { Localize } from '@deriv-com/translations';

import useAutoStrategies from 'AppV2/Hooks/useAutoStrategies';
import useAutoTrade from 'AppV2/Hooks/useAutoTrade';
import { DURATION_UNITS, isRunActive, TTemplateFormValues } from 'AppV2/Utils/auto-trade-utils';
import { useTraderStore } from 'Stores/useTraderStores';

import AutoTradeForm from './auto-trade-form';
import AutoTradeHistory from './auto-trade-history';
import AutoTradeRunPanel from './auto-trade-run-panel';

export type TStartRunArgs = {
    contract_template: TAutoContractTemplate;
    strategy_id: string;
    strategy_parameters: TAutoStrategyParameters;
};

const AutoTrade = observer(() => {
    const history = useHistory();
    const { client } = useStore();
    const { is_logged_in, is_virtual, currency } = client;
    const trade_store = useTraderStore();

    const { strategies, is_loading: is_loading_strategies, error: strategies_error } = useAutoStrategies();
    const {
        active_run,
        runs,
        is_loading_runs,
        is_starting,
        is_busy,
        error_message,
        dismissError,
        startRun,
        pauseRun,
        resumeRun,
        stopRun,
        clearActiveRun,
    } = useAutoTrade({ is_enabled: is_logged_in });

    const has_active_run = isRunActive(active_run);

    // Pre-fill the form with whatever the user last had on the trade page (best effort).
    const default_values = React.useMemo<Partial<TTemplateFormValues>>(() => {
        const duration_unit = DURATION_UNITS.find(({ value }) => value === trade_store?.duration_unit)?.value as
            | TAutoDurationUnit
            | undefined;
        return {
            underlying_symbol: trade_store?.symbol || 'R_100',
            amount: trade_store?.amount ? String(trade_store.amount) : '10',
            duration: trade_store?.duration ? String(trade_store.duration) : '1',
            duration_unit: duration_unit ?? 't',
        };
        // Only read the trade store when the page opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const symbols = React.useMemo(
        () =>
            (trade_store?.active_symbols ?? [])
                .filter(({ underlying_symbol }) => !!underlying_symbol)
                .map(({ underlying_symbol }) => ({
                    value: underlying_symbol as string,
                    text: getSymbolDisplayName(underlying_symbol as string),
                })),
        [trade_store?.active_symbols]
    );

    return (
        <div className='auto-trade' data-testid='dt_auto_trade'>
            <header className='auto-trade__header'>
                <button
                    type='button'
                    className='auto-trade__button auto-trade__button--ghost'
                    onClick={() => history.push(routes.index)}
                    data-testid='dt_auto_trade_back'
                >
                    ← <Localize i18n_default_text='Back to trade' />
                </button>
                <h1 className='auto-trade__page-title'>
                    <Localize i18n_default_text='Auto trading' />
                </h1>
                {is_logged_in && (
                    <span className={`auto-trade__pill ${is_virtual ? 'auto-trade__pill--demo' : 'auto-trade__pill--real'}`}>
                        {is_virtual ? <Localize i18n_default_text='Demo account' /> : <Localize i18n_default_text='Real account' />}
                    </span>
                )}
            </header>

            {!is_logged_in && (
                <p className='auto-trade__muted'>
                    <Localize i18n_default_text='Log in to start automated trading.' />
                </p>
            )}

            {error_message && (
                <div className='auto-trade__alert' role='alert' data-testid='dt_auto_trade_error'>
                    <span>{error_message}</span>
                    <button type='button' className='auto-trade__button auto-trade__button--ghost' onClick={dismissError}>
                        <Localize i18n_default_text='Dismiss' />
                    </button>
                </div>
            )}

            {is_logged_in && active_run && (
                <AutoTradeRunPanel
                    run={active_run}
                    currency={currency}
                    is_busy={is_busy}
                    onPause={pauseRun}
                    onResume={resumeRun}
                    onStop={stopRun}
                    onDismiss={clearActiveRun}
                />
            )}

            {is_logged_in && !active_run && (
                <section className='auto-trade__card'>
                    <h2 className='auto-trade__title'>
                        <Localize i18n_default_text='New automated run' />
                    </h2>
                    <AutoTradeForm
                        strategies={strategies}
                        is_loading_strategies={is_loading_strategies}
                        strategies_error={strategies_error?.message}
                        is_disabled={has_active_run}
                        is_starting={is_starting}
                        is_virtual={is_virtual}
                        currency={currency}
                        default_values={default_values}
                        symbols={symbols}
                        onStart={startRun}
                    />
                </section>
            )}

            {is_logged_in && <AutoTradeHistory runs={runs} currency={currency} is_loading={is_loading_runs} />}
        </div>
    );
});

export default AutoTrade;
