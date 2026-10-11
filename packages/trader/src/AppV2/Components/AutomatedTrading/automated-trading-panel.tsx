import React, { useEffect, useMemo, useState } from 'react';
import { observer } from 'mobx-react-lite';
import { toJS } from 'mobx';

import { Button, Text } from '@deriv/components';

import { useTraderStore } from 'Stores/useTraderStores';
import { getDisplayedContractTypes } from 'AppV2/Utils/trade-types-utils';
import { getProposalInfoKey } from 'AppV2/Utils/trade-params-utils';

import {
    automatedTradingEngine,
    type AutomationActivity,
    type AutomationState,
    type AutomatedTradeResult,
    type ManualTradeSelection,
} from '../../../AutomatedTrading';

import './automated-trading-panel.scss';

const formatActivity = (activity: AutomationActivity) =>
    activity.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());

const formatNumber = (value: unknown, fallback = '-') => {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(2) : fallback;
};

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

type TradingMethod = 'FIXED' | 'MARTINGALE' | 'STAKE_LIST';
type ExecutionSpeed = 'NORMAL' | 'FAST' | 'ULTRA';

const AutomatedTradingPanel = observer(() => {
    const store = useTraderStore();
    const {
        symbol,
        currency,
        amount,
        basis,
        contract_type,
        trade_type_tab,
        trade_types,
        proposal_info,
        proposal_requests,
        duration,
        duration_unit,
        is_market_closed,
    } = store;

    const [state, setState] = useState<AutomationState>(automatedTradingEngine.getState());
    const [activity, setActivity] = useState<AutomationActivity>(automatedTradingEngine.getActivity());
    const [activityMessage, setActivityMessage] = useState(automatedTradingEngine.getMessage());
    const [lastTrade, setLastTrade] = useState<AutomatedTradeResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const [settingsOpen, setSettingsOpen] = useState(false);

    // DT Nexus-style risk-management defaults.
    const [takeProfit, setTakeProfit] = useState('10');
    const [stopLoss, setStopLoss] = useState('100');

    const [repeat, setRepeat] = useState(true);
    const [maxTrades, setMaxTrades] = useState('100');

    const [tradingMethod, setTradingMethod] =
        useState<TradingMethod>('MARTINGALE');

    const [martingaleMultiplier, setMartingaleMultiplier] =
        useState('3');

    const [startMartingaleAfter, setStartMartingaleAfter] =
        useState('1');

    const [maxMartingaleLevel, setMaxMartingaleLevel] =
        useState('10');

    const [stopAfterMaxMartingale, setStopAfterMaxMartingale] =
        useState(true);

    const [stakeList, setStakeList] =
        useState('1,2,5,10');

    const [stopAfterStakeList, setStopAfterStakeList] =
        useState(true);

    const [tradeDiffers, setTradeDiffers] =
        useState(false);

    const [executionSpeed, setExecutionSpeed] =
        useState<ExecutionSpeed>('NORMAL');

    const [cooldownMs, setCooldownMs] = useState('0');

    useEffect(() => {
        return automatedTradingEngine.on({
            state: nextState => setState(nextState),
            activity: (nextActivity, message) => {
                setActivity(nextActivity);
                setActivityMessage(message);
            },
            trade: trade => setLastTrade(trade),
            error: nextError => setError(nextError.message),
        });
    }, []);

    const displayedTradeTypes = useMemo(
        () => getDisplayedContractTypes(trade_types, contract_type, trade_type_tab),
        [trade_types, contract_type, trade_type_tab]
    );

    const manualTradeType = trade_type_tab || displayedTradeTypes[0] || contract_type;

    const proposalKey = useMemo(
        () => getProposalInfoKey(proposal_info, manualTradeType, contract_type),
        [proposal_info, manualTradeType, contract_type]
    );

    const proposalInfo = proposal_info?.[proposalKey] || proposal_info?.[manualTradeType];
    const proposalRequest = proposal_requests?.[proposalKey] || proposal_requests?.[manualTradeType];

    const hasManualSelection = Boolean(
        symbol &&
            contract_type &&
            proposalRequest &&
            proposalInfo?.id &&
            !proposalInfo?.has_error
    );

    const isRunning = state === 'starting' || state === 'running' || state === 'trading';
    const canStart = Boolean(symbol) && !is_market_closed && hasManualSelection && !isRunning;

    const selectionSummary = `${symbol || '-'} • ${manualTradeType || contract_type || '-'}`;

    const buildSelection = (): ManualTradeSelection => {
        if (!hasManualSelection || !proposalRequest || !proposalInfo) {
            throw new Error(
                'Finish configuring the manual trade and wait for a valid proposal before starting automation.'
            );
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            throw new Error('Enter a valid stake or payout amount before starting automation.');
        }

        // Snapshot the live manual request, but explicitly synchronize the core
        // proposal fields with the current trading form. Some proposal request
        // entries can be stale or omit contract_type while the UI is changing.
        const rawRequest = clone(toJS(proposalRequest)) as Record<string, unknown>;
        rawRequest.contract_type = contract_type;
        rawRequest.symbol = symbol;
        rawRequest.currency = currency;
        rawRequest.amount = numericAmount;
        rawRequest.basis = basis === 'payout' ? 'payout' : 'stake';

        return {
            symbol,
            currency,
            amount: numericAmount,
            basis: basis === 'payout' ? 'payout' : 'stake',
            contractType: String(contract_type),
            tradeType: String(manualTradeType || contract_type),
            proposalKey,
            proposalId: String(proposalInfo.id),
            proposalRequest: rawRequest,
        };
    };

    const startTrading = async () => {
        setError(null);
        setLastTrade(null);

        try {
            const selection = buildSelection();

            const tp = takeProfit.trim() === '' ? undefined : Number(takeProfit);
            const sl = stopLoss.trim() === '' ? undefined : Number(stopLoss);
            const max = maxTrades.trim() === '' ? undefined : Number(maxTrades);
            const cooldown = cooldownMs.trim() === '' ? 0 : Number(cooldownMs);
            const multiplier = Number(martingaleMultiplier);
            const startAfter = Number(startMartingaleAfter);
            const maxLevel = Number(maxMartingaleLevel);

            const parsedStakeList = stakeList
                .split(',')
                .map(value => Number(value.trim()))
                .filter(value => Number.isFinite(value) && value > 0);

            if (tp !== undefined && (!Number.isFinite(tp) || tp <= 0)) {
                throw new Error('Take profit must be greater than 0.');
            }

            if (sl !== undefined && (!Number.isFinite(sl) || sl <= 0)) {
                throw new Error('Stop loss must be greater than 0.');
            }

            if (max !== undefined && (!Number.isFinite(max) || max < 1)) {
                throw new Error('Maximum trades must be at least 1.');
            }

            if (!Number.isFinite(cooldown) || cooldown < 0) {
                throw new Error('Cooldown must be zero or greater.');
            }

            if (
                tradingMethod === 'MARTINGALE' &&
                (!Number.isFinite(multiplier) || multiplier < 1)
            ) {
                throw new Error('Martingale multiplier must be at least 1.');
            }

            if (
                tradingMethod === 'MARTINGALE' &&
                (!Number.isFinite(startAfter) || startAfter < 1)
            ) {
                throw new Error('Start Martingale After must be at least 1.');
            }

            if (
                tradingMethod === 'MARTINGALE' &&
                (!Number.isFinite(maxLevel) || maxLevel < 1)
            ) {
                throw new Error('Maximum Martingale Level must be at least 1.');
            }

            if (tradingMethod === 'STAKE_LIST' && parsedStakeList.length === 0) {
                throw new Error('Enter at least one valid stake in the Stake List.');
            }

            await automatedTradingEngine.startManual(selection, {
                takeProfit: tp,
                stopLoss: sl,
                repeat,
                maxTrades: max,
                cooldownMs: cooldown,
                tradingMethod,
                martingaleMultiplier: multiplier,
                startMartingaleAfter: startAfter,
                maxMartingaleLevel: maxLevel,
                stopAfterMaxMartingale,
                stakeList: parsedStakeList,
                stopAfterStakeList,
                tradeDiffers,
                executionSpeed,
            });

            setSettingsOpen(false);
        } catch (startError) {
            setError(startError instanceof Error ? startError.message : String(startError));
        }
    };

    const stopTrading = async () => {
        try {
            await automatedTradingEngine.stop();
        } catch (stopError) {
            setError(stopError instanceof Error ? stopError.message : String(stopError));
        }
    };

    const resetTrading = () => {
        try {
            automatedTradingEngine.reset();
            setLastTrade(null);
            setError(null);
        } catch (resetError) {
            setError(resetError instanceof Error ? resetError.message : String(resetError));
        }
    };

    return (
        <div className='automated-trading-panel'>
            <div className='automated-trading-panel__header'>
                <div className='automated-trading-panel__title'>
                    <Text weight='bold' size='md'>Automated Trading</Text>
                    <Text size='xs'>Repeat the current manual trade automatically</Text>
                </div>
                <div className={`automated-trading-panel__status automated-trading-panel__status--${state}`}>
                    <span className='automated-trading-panel__status-dot' />
                    <Text size='xs'>{state === 'idle' ? 'Ready' : state}</Text>
                </div>
            </div>

            <div className='automated-trading-panel__content'>
                <div className='automated-trading-panel__summary'>
                    <div className='automated-trading-panel__row'>
                        <Text size='xs'>Manual selection</Text>
                        <Text weight='bold'>{selectionSummary}</Text>
                    </div>
                    <div className='automated-trading-panel__row'>
                        <Text size='xs'>Stake</Text>
                        <Text weight='bold'>{formatNumber(amount)} {currency}</Text>
                    </div>
                    <div className='automated-trading-panel__row'>
                        <Text size='xs'>Duration</Text>
                        <Text weight='bold'>{duration} {duration_unit || ''}</Text>
                    </div>
                </div>

                <div className='automated-trading-panel__activity'>
                    <div className='automated-trading-panel__activity-indicator' />
                    <div className='automated-trading-panel__activity-content'>
                        <Text weight='bold' size='xs'>{formatActivity(activity)}</Text>
                        <Text size='xs'>{activityMessage}</Text>
                    </div>
                </div>

                {!symbol && (
                    <div className='automated-trading-panel__error'>
                        <Text size='xs'>Select a market first.</Text>
                    </div>
                )}

                {symbol && !hasManualSelection && (
                    <div className='automated-trading-panel__error'>
                        <Text size='xs'>
                            Complete the manual trade parameters and wait for a valid proposal before starting automation.
                        </Text>
                    </div>
                )}

                {symbol && is_market_closed && (
                    <div className='automated-trading-panel__error'>
                        <Text size='xs'>The selected market is currently closed.</Text>
                    </div>
                )}

                {lastTrade && (
                    <div className='automated-trading-panel__info'>
                        <Text weight='bold'>Last automated trade: {lastTrade.status}</Text>
                        <Text size='xs'>Profit: {lastTrade.profit.toFixed(2)} {currency}</Text>
                    </div>
                )}

                {error && (
                    <div className='automated-trading-panel__error'>
                        <Text size='xs'>{error}</Text>
                    </div>
                )}
            </div>

            <div className='automated-trading-panel__footer'>
                <Button secondary large onClick={() => setSettingsOpen(true)} disabled={isRunning}>
                    Automation Settings
                </Button>

                {!isRunning ? (
                    <Button primary large disabled={!canStart} onClick={startTrading}>
                        Start Automation
                    </Button>
                ) : (
                    <Button secondary large onClick={stopTrading}>
                        Stop Automation
                    </Button>
                )}
            </div>

            {settingsOpen && (
                <div
                    className='automated-trading-modal'
                    role='dialog'
                    aria-modal='true'
                    aria-label='Automated trading settings'
                >
                    <div className='automated-trading-modal__content'>
                        <div className='automated-trading-modal__header'>
                            <div className='automated-trading-modal__title'>
                                <Text weight='bold' size='lg'>Automation Settings</Text>
                                <Text size='xs'>The manual selection is copied exactly when you start.</Text>
                            </div>

                            <button
                                type='button'
                                className='automated-trading-modal__close'
                                onClick={() => setSettingsOpen(false)}
                                aria-label='Close settings'
                            >
                                ×
                            </button>
                        </div>

                        <div className='automated-trading-modal__activity'>
                            <div className='automated-trading-modal__activity-dot' />
                            <div className='automated-trading-modal__activity-content'>
                                <Text weight='bold' size='xs'>{formatActivity(activity)}</Text>
                                <Text size='xs'>{activityMessage}</Text>
                            </div>
                        </div>

                        <div className='automated-trading-modal__body'>
                            <div className='automated-trading-modal__section'>
                                <div className='automated-trading-modal__section-title'>
                                    <Text weight='bold' size='xs'>LOCKED MANUAL TRADE</Text>
                                </div>

                                <div className='automated-trading-account'>
                                    <div>
                                        <Text size='xs'>Market</Text>
                                        <Text weight='bold'>{symbol || '-'}</Text>
                                    </div>
                                    <div>
                                        <Text size='xs'>Contract</Text>
                                        <Text weight='bold'>{manualTradeType || contract_type || '-'}</Text>
                                    </div>
                                    <div>
                                        <Text size='xs'>Stake</Text>
                                        <Text weight='bold'>{formatNumber(amount)} {currency}</Text>
                                    </div>
                                    <div>
                                        <Text size='xs'>Duration</Text>
                                        <Text weight='bold'>{duration} {duration_unit || ''}</Text>
                                    </div>
                                </div>
                            </div>

                            <div className='automated-trading-modal__section'>
                                <div className='automated-trading-modal__section-title'>
                                    <Text weight='bold' size='xs'>RISK MANAGEMENT</Text>
                                </div>

                                <div className='automated-trading-settings-grid'>
                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Trade Differs</Text>
                                        <select
                                            value={tradeDiffers ? 'yes' : 'no'}
                                            onChange={event => setTradeDiffers(event.target.value === 'yes')}
                                        >
                                            <option value='no'>No</option>
                                            <option value='yes'>Yes</option>
                                        </select>
                                        <Text size='xs'>Start with DIGITDIFF and switch to the selected manual contract after a loss.</Text>
                                    </div>

                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Take Profit ({currency})</Text>
                                        <input
                                            type='number'
                                            min='0'
                                            step='0.01'
                                            value={takeProfit}
                                            onChange={event => setTakeProfit(event.target.value)}
                                            placeholder='Optional'
                                        />
                                        <Text size='xs'>Stop automation after cumulative session profit reaches this amount.</Text>
                                    </div>

                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Stop Loss ({currency})</Text>
                                        <input
                                            type='number'
                                            min='0'
                                            step='0.01'
                                            value={stopLoss}
                                            onChange={event => setStopLoss(event.target.value)}
                                            placeholder='Optional'
                                        />
                                        <Text size='xs'>Stop automation after cumulative session loss reaches this amount.</Text>
                                    </div>
                                </div>
                            </div>

                            <div className='automated-trading-modal__section'>
                                <div className='automated-trading-modal__section-title'>
                                    <Text weight='bold' size='xs'>TRADING METHOD</Text>
                                </div>

                                <div className='automated-trading-method-tabs'>
                                    <button
                                        type='button'
                                        className={tradingMethod === 'FIXED' ? 'active' : ''}
                                        onClick={() => setTradingMethod('FIXED')}
                                    >
                                        Fixed
                                    </button>
                                    <button
                                        type='button'
                                        className={tradingMethod === 'MARTINGALE' ? 'active' : ''}
                                        onClick={() => setTradingMethod('MARTINGALE')}
                                    >
                                        Martingale
                                    </button>
                                    <button
                                        type='button'
                                        className={tradingMethod === 'STAKE_LIST' ? 'active' : ''}
                                        onClick={() => setTradingMethod('STAKE_LIST')}
                                    >
                                        Stake List
                                    </button>
                                </div>
                            </div>

                            {tradingMethod === 'MARTINGALE' && (
                                <div className='automated-trading-modal__section'>
                                    <div className='automated-trading-modal__section-title'>
                                        <Text weight='bold' size='xs'>MARTINGALE SETTINGS</Text>
                                    </div>

                                    <div className='automated-trading-settings-grid'>
                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Multiplier</Text>
                                            <input
                                                type='number'
                                                min='1'
                                                step='0.1'
                                                value={martingaleMultiplier}
                                                onChange={event => setMartingaleMultiplier(event.target.value)}
                                            />
                                            <Text size='xs'>Example: 3 = 1 → 3 → 9 → 27.</Text>
                                        </div>

                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Start Martingale After</Text>
                                            <input
                                                type='number'
                                                min='1'
                                                step='1'
                                                value={startMartingaleAfter}
                                                onChange={event => setStartMartingaleAfter(event.target.value)}
                                            />
                                            <Text size='xs'>Number of consecutive losses before increasing the stake.</Text>
                                        </div>

                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Max Martingale Level</Text>
                                            <input
                                                type='number'
                                                min='1'
                                                step='1'
                                                value={maxMartingaleLevel}
                                                onChange={event => setMaxMartingaleLevel(event.target.value)}
                                            />
                                            <Text size='xs'>Maximum number of consecutive stake increases.</Text>
                                        </div>

                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Stop After Max Martingale Level</Text>
                                            <select
                                                value={stopAfterMaxMartingale ? 'yes' : 'no'}
                                                onChange={event => setStopAfterMaxMartingale(event.target.value === 'yes')}
                                            >
                                                <option value='yes'>Yes</option>
                                                <option value='no'>No — reset and continue</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {tradingMethod === 'STAKE_LIST' && (
                                <div className='automated-trading-modal__section'>
                                    <div className='automated-trading-modal__section-title'>
                                        <Text weight='bold' size='xs'>STAKE LIST</Text>
                                    </div>

                                    <div className='automated-trading-settings-grid'>
                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Stakes</Text>
                                            <input
                                                type='text'
                                                value={stakeList}
                                                onChange={event => setStakeList(event.target.value)}
                                                placeholder='1,2,5,10'
                                            />
                                            <Text size='xs'>Comma-separated values, for example 1,2,5,10.</Text>
                                        </div>

                                        <div className='automated-trading-setting'>
                                            <Text size='xs'>Stop After Stake List</Text>
                                            <select
                                                value={stopAfterStakeList ? 'yes' : 'no'}
                                                onChange={event => setStopAfterStakeList(event.target.value === 'yes')}
                                            >
                                                <option value='yes'>Yes</option>
                                                <option value='no'>No — reset to first stake</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className='automated-trading-modal__section'>
                                <div className='automated-trading-modal__section-title'>
                                    <Text weight='bold' size='xs'>EXECUTION SPEED</Text>
                                </div>

                                <div className='automated-trading-method-tabs'>
                                    <button
                                        type='button'
                                        className={executionSpeed === 'NORMAL' ? 'active' : ''}
                                        onClick={() => setExecutionSpeed('NORMAL')}
                                    >
                                        Normal
                                    </button>
                                    <button
                                        type='button'
                                        className={executionSpeed === 'FAST' ? 'active' : ''}
                                        onClick={() => setExecutionSpeed('FAST')}
                                    >
                                        Fast
                                    </button>
                                    <button
                                        type='button'
                                        className={executionSpeed === 'ULTRA' ? 'active' : ''}
                                        onClick={() => setExecutionSpeed('ULTRA')}
                                    >
                                        Ultra
                                    </button>
                                </div>
                            </div>

                            <div className='automated-trading-modal__section'>
                                <div className='automated-trading-modal__section-title'>
                                    <Text weight='bold' size='xs'>AUTOMATION</Text>
                                </div>

                                <div className='automated-trading-settings-grid'>
                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Repeat Trade</Text>
                                        <select
                                            value={repeat ? 'yes' : 'no'}
                                            onChange={event => setRepeat(event.target.value === 'yes')}
                                        >
                                            <option value='yes'>Yes</option>
                                            <option value='no'>One trade only</option>
                                        </select>
                                    </div>

                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Maximum Trades</Text>
                                        <input
                                            type='number'
                                            min='1'
                                            step='1'
                                            value={maxTrades}
                                            onChange={event => setMaxTrades(event.target.value)}
                                        />
                                    </div>

                                    <div className='automated-trading-setting'>
                                        <Text size='xs'>Cooldown (ms)</Text>
                                        <input
                                            type='number'
                                            min='0'
                                            step='100'
                                            value={cooldownMs}
                                            onChange={event => setCooldownMs(event.target.value)}
                                        />
                                        <Text size='xs'>Leave at 0 to use the selected execution speed.</Text>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className='automated-trading-modal__footer'>
                            <Button secondary large onClick={() => setSettingsOpen(false)}>
                                Done
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});

export default AutomatedTradingPanel;
