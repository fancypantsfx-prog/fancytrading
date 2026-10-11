import fancyApiAdapter from '../adapter/FancyApiAdapter';
import automatedContractService from '../services/automated-contract.service';
import automatedProposalService from '../services/automated-proposal.service';
import automatedTicksService from '../services/automated-ticks.service';
import {
    automatedCapabilitiesService,
} from '../services/automated-capabilities.service';

import {
    createAutomatedStrategy,
    type AutomatedStrategy,
} from '../strategies/strategy-factory';

import type {
    AutomatedSignal,
    AutomatedTick,
    AutomatedTradeConfig,
    AutomatedTradeResult,
    ManualTradeSelection,
    ManualAutomationConfig,
} from '../types/automated-trading.types';

export type AutomationState =
    | 'idle'
    | 'starting'
    | 'running'
    | 'trading'
    | 'stopped'
    | 'error';

export type AutomationActivity =
    | 'idle'
    | 'checking_market'
    | 'loading_history'
    | 'watching_market'
    | 'analysing'
    | 'signal_found'
    | 'requesting_proposal'
    | 'proposal_received'
    | 'buying'
    | 'monitoring_contract'
    | 'trade_won'
    | 'trade_lost'
    | 'stopped'
    | 'error';

type EngineListeners = {
    state?: (
        state: AutomationState
    ) => void;

    activity?: (
        activity: AutomationActivity,
        message: string
    ) => void;

    signal?: (
        signal: AutomatedSignal
    ) => void;

    trade?: (
        trade: AutomatedTradeResult
    ) => void;

    error?: (
        error: Error
    ) => void;
};

const STRATEGY_LABELS: Partial<
    Record<string, string>
> = {
    RISE_FALL:
        'Rise / Fall',

    RISE_FALL_EQUAL:
        'Rise / Fall Equal',

    HIGHER_LOWER:
        'Higher / Lower',

    TOUCH_NO_TOUCH:
        'Touch / No Touch',

    ENDS_IN_OUT:
        'Ends In / Ends Out',

    STAYS_IN_OUT:
        'Stays In / Goes Out',

    ASIAN:
        'Asian Up / Asian Down',

    MATCHES_DIFFERS:
        'Matches / Differs',

    EVEN_ODD:
        'Even / Odd',

    OVER_UNDER:
        'Over / Under',

    LOOKBACK:
        'Lookbacks',

    TICK_HIGH_LOW:
        'High Tick / Low Tick',

    RUN_HIGH_LOW:
        'Only Ups / Only Downs',

    RESET:
        'Reset Up / Reset Down',

    CALL_PUT_SPREAD:
        'Spread Up / Spread Down',

    ACCUMULATOR:
        'Accumulators',

    MULTIPLIER:
        'Multipliers',

    TURBOS:
        'Turbos',

    VANILLA:
        'Call / Put',
};

const getStrategyLabel = (
    strategy:
        | AutomatedTradeConfig['strategy']
        | undefined
) =>
    strategy
        ? STRATEGY_LABELS[strategy] ??
          strategy
        : 'Automation';

export class AutomatedTradingEngine {
    private state: AutomationState =
        'idle';

    private activity: AutomationActivity =
        'idle';

    private message =
        'Automation is ready.';

    private config:
        | AutomatedTradeConfig
        | null = null;

    private strategy:
        | AutomatedStrategy
        | null = null;

    private subscriptionKey:
        | string
        | null = null;

    private history: AutomatedTick[] =
        [];

    private tradeCount = 0;

    private totalProfit = 0;

    private lastTradeAt = 0;

    private lastTickAt = 0;

    private tickCount = 0;

    private listeners: EngineListeners =
        {};

    private tradeInProgress = false;

    /** Manual automation uses an immutable snapshot of the manual UI. */
    private manualConfig: ManualAutomationConfig | null = null;

    private manualTimer: ReturnType<typeof setTimeout> | null = null;

    private manualCurrentStake = 0;

    private manualMartingaleLevel = 0;

    private manualConsecutiveLosses = 0;

    private manualStakeListIndex = 0;

    private manualDiffersCompleted = false;

    getState() {
        return this.state;
    }

    getActivity() {
        return this.activity;
    }

    getMessage() {
        return this.message;
    }

    getStats() {
        return {
            state: this.state,

            activity:
                this.activity,

            message:
                this.message,

            tradeCount:
                this.tradeCount,

            totalProfit:
                this.totalProfit,

            lastTradeAt:
                this.lastTradeAt,

            lastTickAt:
                this.lastTickAt,

            tradeInProgress:
                this.tradeInProgress,

            tickCount:
                this.tickCount,

            historyLength:
                this.history.length,

            strategy:
                this.config?.strategy ??
                (this.manualConfig ? 'MANUAL_SELECTION' : null),

            mode: this.manualConfig ? 'manual_selection' : 'strategy',

            manualSelection: this.manualConfig?.selection ?? null,
        };
    }

    on(
        listeners: EngineListeners
    ) {
        const registeredListeners = {
            ...listeners,
        };

        this.listeners = {
            ...this.listeners,
            ...registeredListeners,
        };

        return () => {
            Object.keys(
                registeredListeners
            ).forEach(key => {
                const listenerKey =
                    key as keyof EngineListeners;

                if (
                    this.listeners[
                        listenerKey
                    ] ===
                    registeredListeners[
                        listenerKey
                    ]
                ) {
                    delete this.listeners[
                        listenerKey
                    ];
                }
            });
        };
    }

    async start(
        config: AutomatedTradeConfig
    ) {
        /*
         * Prevent multiple automation sessions
         * from running at the same time.
         */
        if (
            this.state === 'running' ||
            this.state === 'starting' ||
            this.state === 'trading'
        ) {
            throw new Error(
                'Automated trading is already running'
            );
        }

        /*
         * Basic configuration validation.
         */
        if (!config.symbol) {
            throw new Error(
                'A trading symbol is required'
            );
        }

        if (
            !Number.isFinite(
                config.amount
            ) ||
            config.amount <= 0
        ) {
            throw new Error(
                'Amount must be greater than 0'
            );
        }

        if (
            config.maxStake != null &&
            config.amount >
                config.maxStake
        ) {
            throw new Error(
                'Stake exceeds maxStake'
            );
        }

        if (!config.strategy) {
            throw new Error(
                'No automation strategy selected.'
            );
        }

        /*
         * Copy the supplied configuration.
         */
        const normalizedConfig:
            AutomatedTradeConfig = {
            ...config,
        };

        this.config =
            normalizedConfig;

        this.history = [];

        this.tradeCount = 0;

        this.totalProfit = 0;

        this.tradeInProgress =
            false;

        this.tickCount = 0;

        this.lastTickAt = 0;

        this.lastTradeAt = 0;

        this.setState(
            'starting'
        );

        try {
            const strategyLabel =
                getStrategyLabel(
                    normalizedConfig.strategy
                );

            this.setActivity(
                'checking_market',
                `Checking ${config.symbol}...`
            );

            /*
             * Confirm that the selected symbol is
             * an active Deriv symbol.
             */
            const active =
                await fancyApiAdapter.getActiveSymbol(
                    config.symbol
                );

            if (!active) {
                throw new Error(
                    `Symbol ${config.symbol} is not an active Deriv symbol`
                );
            }

            if (
                active.tradingSuspended
            ) {
                throw new Error(
                    `Trading is suspended for ${config.symbol}`
                );
            }

            /*
             * Ask Deriv which contract families are
             * actually available for this symbol.
             */
            const capabilities =
                await automatedCapabilitiesService.getCapabilities(
                    config.symbol
                );

            const strategyCapability =
                capabilities.find(
                    capability =>
                        capability.strategy ===
                        normalizedConfig.strategy
                );

            if (!strategyCapability) {
                throw new Error(
                    `${normalizedConfig.strategy} is not available for ${config.symbol}.`
                );
            }

            if (
                strategyCapability
                    .contractTypes.length ===
                0
            ) {
                throw new Error(
                    `No contracts are available for ${normalizedConfig.strategy} on ${config.symbol}.`
                );
            }

            /*
             * Duration is required only for contract
             * families that use duration.
             *
             * Durationless families such as
             * Accumulators and Multipliers can
             * omit duration.
             */
            if (
                !strategyCapability.hideDuration
            ) {
                const duration =
                    config.duration;

                /*
                 * Explicitly narrow duration to a
                 * number before using it.
                 *
                 * Number.isInteger() alone does not
                 * narrow an optional TypeScript value.
                 */
                if (
                    typeof duration !==
                        'number' ||
                    !Number.isInteger(
                        duration
                    ) ||
                    duration <= 0
                ) {
                    throw new Error(
                        'Duration must be a positive integer'
                    );
                }

                const durationUnit =
                    config.durationUnit;

                if (
                    !durationUnit
                ) {
                    throw new Error(
                        'Duration unit is required'
                    );
                }

                /*
                 * Store the validated values in the
                 * normalized configuration.
                 */
                normalizedConfig.duration =
                    duration;

                normalizedConfig.durationUnit =
                    durationUnit;
            } else {
                /*
                 * Durationless contracts should not
                 * receive an artificial duration.
                 */
                delete normalizedConfig.duration;

                delete normalizedConfig.durationUnit;
            }

            /*
             * Only create the strategy after the
             * symbol/capability checks succeed.
             */
            this.strategy =
                createAutomatedStrategy(
                    normalizedConfig.strategy,
                    normalizedConfig
                );

            this.setActivity(
                'loading_history',
                `Loading recent ticks for ${config.symbol}...`
            );

            /*
             * Load historical ticks for strategy
             * analysis.
             */
            this.history =
                await automatedTicksService.getHistory(
                    config.symbol,
                    Math.max(
                        100,
                        config.lookback ??
                            20
                    )
                );

            this.tickCount =
                this.history.length;

            this.setActivity(
                'watching_market',
                `Loaded ${this.history.length} ticks. Waiting for a ${strategyLabel} signal...`
            );

            /*
             * Start live tick monitoring.
             */
            this.subscriptionKey =
                await automatedTicksService.start(
                    config.symbol,
                    tick =>
                        this.onTick(
                            tick
                        )
                );

            this.setState(
                'running'
            );

            this.setActivity(
                'watching_market',
                `Watching ${config.symbol} for ${strategyLabel} signals...`
            );
        } catch (error) {
            this.setState(
                'error'
            );

            const err =
                error instanceof Error
                    ? error
                    : new Error(
                          String(
                              error
                          )
                      );

            this.setActivity(
                'error',
                err.message
            );

            this.listeners.error?.(
                err
            );

            throw err;
        }
    }

    /**
     * Starts automation from the exact manual trade selection currently
     * configured in Fancy's trading form. The selection is snapshotted once
     * so later changes in the manual UI do not silently change a running bot.
     */
    async startManual(
        selection: ManualTradeSelection,
        options: Omit<ManualAutomationConfig, 'selection'>
    ) {
        if (
            this.state === 'running' ||
            this.state === 'starting' ||
            this.state === 'trading'
        ) {
            throw new Error('Automated trading is already running');
        }

        if (!selection?.symbol) {
            throw new Error('A manual trading selection is required');
        }

        if (!selection.contractType) {
            throw new Error('The manual selection has no contract type');
        }

        if (!selection.proposalKey || !selection.proposalRequest) {
            throw new Error(
                'The selected manual trade does not have a valid proposal request'
            );
        }

        if (!Number.isFinite(selection.amount) || selection.amount <= 0) {
            throw new Error('Manual stake must be greater than 0');
        }

        const active = await fancyApiAdapter.getActiveSymbol(selection.symbol);

        if (!active) {
            throw new Error(
                `Symbol ${selection.symbol} is not an active Deriv symbol`
            );
        }

        if (active.tradingSuspended) {
            throw new Error(
                `Trading is suspended for ${selection.symbol}`
            );
        }

        const proposalRequest = JSON.parse(
            JSON.stringify(selection.proposalRequest)
        ) as Record<string, unknown>;

        // Keep the proposal's required fields aligned with the selected manual
        // trade. This avoids sending a stale/incomplete request whose
        // contract_type differs from the contract the engine is about to buy.
        proposalRequest.contract_type = selection.contractType;
        proposalRequest.symbol = selection.symbol;
        proposalRequest.currency = selection.currency;
        proposalRequest.amount = selection.amount;
        proposalRequest.basis = selection.basis;

        const normalizedSelection: ManualTradeSelection = {
            ...selection,
            proposalRequest,
        };

        const takeProfit =
            options.takeProfit ?? options.stopOnProfit;

        const stopLoss =
            options.stopLoss ?? options.stopOnLoss;

        if (takeProfit != null && (!Number.isFinite(takeProfit) || takeProfit <= 0)) {
            throw new Error('Take profit must be greater than 0');
        }

        if (stopLoss != null && (!Number.isFinite(stopLoss) || stopLoss <= 0)) {
            throw new Error('Stop loss must be greater than 0');
        }

        const tradingMethod = options.tradingMethod ?? 'FIXED';
        const martingaleMultiplier =
            options.martingaleMultiplier == null
                ? 2
                : Number(options.martingaleMultiplier);
        const startMartingaleAfter =
            options.startMartingaleAfter == null
                ? 1
                : Math.floor(Number(options.startMartingaleAfter));
        const maxMartingaleLevel =
            options.maxMartingaleLevel == null
                ? 10
                : Math.floor(Number(options.maxMartingaleLevel));

        if (
            tradingMethod === 'MARTINGALE' &&
            (!Number.isFinite(martingaleMultiplier) || martingaleMultiplier < 1)
        ) {
            throw new Error('Martingale multiplier must be at least 1');
        }

        if (
            tradingMethod === 'MARTINGALE' &&
            (!Number.isFinite(startMartingaleAfter) || startMartingaleAfter < 1)
        ) {
            throw new Error('Start Martingale After must be at least 1');
        }

        if (
            tradingMethod === 'MARTINGALE' &&
            (!Number.isFinite(maxMartingaleLevel) || maxMartingaleLevel < 1)
        ) {
            throw new Error('Maximum Martingale Level must be at least 1');
        }

        const stakeList =
            Array.isArray(options.stakeList)
                ? options.stakeList
                      .map(Number)
                      .filter(
                          value => Number.isFinite(value) && value > 0
                      )
                : undefined;

        if (tradingMethod === 'STAKE_LIST' && (!stakeList || stakeList.length === 0)) {
            throw new Error('Stake List must contain at least one positive stake');
        }

        const manualConfig: ManualAutomationConfig = {
            ...options,
            selection: normalizedSelection,
            takeProfit,
            stopLoss,
            stopOnProfit: takeProfit,
            stopOnLoss: stopLoss,
            repeat: options.repeat !== false,
            maxTrades:
                options.maxTrades == null
                    ? undefined
                    : Math.max(1, Math.floor(options.maxTrades)),
            cooldownMs:
                options.cooldownMs == null
                    ? 0
                    : Math.max(0, Math.floor(options.cooldownMs)),
            tradingMethod,
            martingaleMultiplier,
            startMartingaleAfter,
            maxMartingaleLevel,
            stopAfterMaxMartingale: options.stopAfterMaxMartingale !== false,
            stakeList,
            stopAfterStakeList: options.stopAfterStakeList !== false,
            tradeDiffers: options.tradeDiffers === true,
            executionSpeed: options.executionSpeed ?? 'NORMAL',
        };

        this.manualConfig = manualConfig;
        this.config = null;
        this.strategy = null;
        this.history = [];
        this.tradeCount = 0;
        this.totalProfit = 0;
        this.tradeInProgress = false;
        this.tickCount = 0;
        this.lastTickAt = 0;
        this.lastTradeAt = 0;

        this.manualCurrentStake = normalizedSelection.amount;
        this.manualMartingaleLevel = 0;
        this.manualConsecutiveLosses = 0;
        this.manualStakeListIndex = 0;
        this.manualDiffersCompleted = false;

        this.setState('starting');
        this.setActivity(
            'checking_market',
            `Preparing ${selection.tradeType || selection.contractType} on ${selection.symbol}...`
        );

        try {
            this.setState('running');
            this.setActivity(
                'watching_market',
                `Manual selection locked: ${selection.tradeType || selection.contractType}. Automation will repeat this exact selection.`
            );

            void this.executeManualTrade();
        } catch (error) {
            const err =
                error instanceof Error
                    ? error
                    : new Error(String(error));

            this.setState('error');
            this.setActivity('error', err.message);
            this.listeners.error?.(err);
            this.manualConfig = null;
            throw err;
        }
    }

    private getManualContractType(): string {
        const config = this.manualConfig;

        if (!config) {
            return '';
        }

        if (config.tradeDiffers && !this.manualDiffersCompleted) {
            return 'DIGITDIFF';
        }

        return config.selection.contractType;
    }

    private getManualNextStake(): number {
        const config = this.manualConfig;

        if (!config) {
            return this.manualCurrentStake;
        }

        if (config.tradingMethod === 'STAKE_LIST') {
            const list = config.stakeList ?? [];

            if (list.length === 0) {
                return config.selection.amount;
            }

            return list[Math.min(this.manualStakeListIndex, list.length - 1)];
        }

        if (config.tradingMethod === 'MARTINGALE') {
            return this.manualCurrentStake;
        }

        return config.selection.amount;
    }

    private updateManualRiskAfterTrade(
        profit: number
    ): { shouldStop: boolean; reason?: string } {
        const config = this.manualConfig;

        if (!config) {
            return {
                shouldStop: true,
                reason: 'Automation configuration is missing.',
            };
        }

        if (profit >= 0) {
            this.manualConsecutiveLosses = 0;

            if (config.tradingMethod === 'MARTINGALE') {
                this.manualMartingaleLevel = 0;
                this.manualCurrentStake = config.selection.amount;
            }

            if (config.tradingMethod === 'STAKE_LIST') {
                this.manualStakeListIndex = 0;
            }

            return { shouldStop: false };
        }

        this.manualConsecutiveLosses += 1;

        if (config.tradingMethod === 'STAKE_LIST') {
            const list = config.stakeList ?? [];

            if (list.length > 0) {
                const nextIndex = this.manualStakeListIndex + 1;

                if (nextIndex >= list.length) {
                    if (config.stopAfterStakeList !== false) {
                        return {
                            shouldStop: true,
                            reason: 'Maximum stake-list level reached.',
                        };
                    }

                    this.manualStakeListIndex = 0;
                } else {
                    this.manualStakeListIndex = nextIndex;
                }
            }
        }

        if (config.tradingMethod === 'MARTINGALE') {
            const startAfter = config.startMartingaleAfter ?? 1;

            if (this.manualConsecutiveLosses >= startAfter) {
                const maxLevel = config.maxMartingaleLevel ?? 10;

                if (this.manualMartingaleLevel >= maxLevel) {
                    if (config.stopAfterMaxMartingale !== false) {
                        return {
                            shouldStop: true,
                            reason: 'Maximum Martingale level reached.',
                        };
                    }

                    this.manualMartingaleLevel = 0;
                    this.manualCurrentStake = config.selection.amount;
                } else {
                    this.manualMartingaleLevel += 1;

                    const multiplier =
                        config.martingaleMultiplier ?? 2;

                    this.manualCurrentStake =
                        config.selection.amount *
                        Math.pow(multiplier, this.manualMartingaleLevel);
                }
            }
        }

        return { shouldStop: false };
    }

    private getManualExecutionCooldown(): number {
        const config = this.manualConfig;

        if (!config) {
            return 0;
        }

        if (config.cooldownMs != null && config.cooldownMs > 0) {
            return config.cooldownMs;
        }

        switch (config.executionSpeed) {
            case 'ULTRA':
                return 0;
            case 'FAST':
                return 100;
            case 'NORMAL':
            default:
                return 500;
        }
    }

    private async executeManualTrade() {
        const manualConfig = this.manualConfig;

        if (
            !manualConfig ||
            this.state === 'stopped' ||
            this.state === 'error' ||
            this.tradeInProgress
        ) {
            return;
        }

        const takeProfit = manualConfig.takeProfit;
        const stopLoss = manualConfig.stopLoss;

        if (
            manualConfig.maxTrades != null &&
            this.tradeCount >= manualConfig.maxTrades
        ) {
            await this.stop();
            return;
        }

        if (takeProfit != null && this.totalProfit >= takeProfit) {
            this.setActivity(
                'stopped',
                `Take profit of ${takeProfit.toFixed(2)} reached.`
            );
            await this.stop();
            return;
        }

        if (stopLoss != null && this.totalProfit <= -Math.abs(stopLoss)) {
            this.setActivity(
                'stopped',
                `Stop loss of ${Math.abs(stopLoss).toFixed(2)} reached.`
            );
            await this.stop();
            return;
        }

        this.tradeInProgress = true;
        this.setState('trading');

        const selection = manualConfig.selection;
        const contractType = this.getManualContractType();
        const stake = this.getManualNextStake();

        if (!Number.isFinite(stake) || stake <= 0) {
            this.tradeInProgress = false;
            this.setState('error');
            this.setActivity('error', 'Automation calculated an invalid stake.');
            return;
        }

        const signal: AutomatedSignal = {
            strategy: 'MANUAL_SELECTION',
            contractType,
            direction: selection.tradeType,
            confidence: 1,
            reason: 'Copied from the manual trading selection.',
            sourceEpoch: Math.floor(Date.now() / 1000),
        };

        this.listeners.signal?.(signal);

        this.setActivity(
            'requesting_proposal',
            `Requesting ${contractType} with stake ${stake.toFixed(2)} ${selection.currency}...`
        );

        try {
            const proposal =
                await automatedProposalService.createFromManualSelection(
                    selection,
                    {
                        amount: stake,
                        contractType,
                    }
                );

            if (
                proposal.contractType &&
                proposal.contractType !== contractType
            ) {
                throw new Error(
                    `Deriv returned contract ${proposal.contractType} instead of ${contractType}.`
                );
            }

            this.setActivity(
                'proposal_received',
                `Fresh proposal received. Price: ${proposal.askPrice.toFixed(2)} ${selection.currency}.`
            );

            this.setActivity(
                'buying',
                `Buying ${contractType} with ${stake.toFixed(2)} ${selection.currency}...`
            );

            const buy = await automatedContractService.buy(proposal);

            if (!buy?.contract_id) {
                throw new Error('Deriv returned no contract ID after purchase');
            }

            const contractId = String(buy.contract_id);

            this.setActivity(
                'monitoring_contract',
                `Contract ${contractId} is open. Waiting for settlement...`
            );

            const result =
                await automatedContractService.waitForResult(contractId);

            const trade: AutomatedTradeResult = {
                ...result,
                signal,
                proposal,
            };

            this.tradeCount += 1;
            this.totalProfit += result.profit;
            this.lastTradeAt = Date.now();
            this.listeners.trade?.(trade);

            if (
                manualConfig.tradeDiffers &&
                !this.manualDiffersCompleted &&
                result.profit < 0
            ) {
                this.manualDiffersCompleted = true;

                this.setActivity(
                    'trade_lost',
                    `DIFFERS lost. Switching to ${selection.contractType}.`
                );
            } else if (result.profit >= 0) {
                this.setActivity(
                    'trade_won',
                    `Trade won: +${result.profit.toFixed(2)} ${selection.currency}.`
                );
            } else {
                this.setActivity(
                    'trade_lost',
                    `Trade lost: ${result.profit.toFixed(2)} ${selection.currency}.`
                );
            }

            const riskResult =
                this.updateManualRiskAfterTrade(result.profit);

            if (riskResult.shouldStop) {
                this.setActivity(
                    'stopped',
                    riskResult.reason ??
                        'Risk-management limit reached.'
                );
                await this.stop();
                return;
            }

            if (
                takeProfit != null &&
                this.totalProfit >= takeProfit
            ) {
                await this.stop();
                return;
            }

            if (
                stopLoss != null &&
                this.totalProfit <= -Math.abs(stopLoss)
            ) {
                await this.stop();
                return;
            }

            if (
                manualConfig.maxTrades != null &&
                this.tradeCount >= manualConfig.maxTrades
            ) {
                await this.stop();
                return;
            }

            if (!manualConfig.repeat) {
                await this.stop();
                return;
            }

            this.setState('running');
            this.setActivity(
                'watching_market',
                `Trade complete. Repeating ${contractType} after the cooldown.`
            );

            const cooldown = this.getManualExecutionCooldown();

            if (cooldown > 0) {
                await new Promise<void>(resolve => {
                    this.manualTimer = setTimeout(() => {
                        this.manualTimer = null;
                        resolve();
                    }, cooldown);
                });
            }

            if (
                this.manualConfig === manualConfig &&
                !['stopped', 'error'].includes(this.getState())
            ) {
                void this.executeManualTrade();
            }
        } catch (error) {
            const err =
                error instanceof Error
                    ? error
                    : new Error(String(error));

            this.listeners.error?.(err);
            this.setActivity('error', err.message);
            this.setState('error');
        } finally {
            this.tradeInProgress = false;
        }
    }

    async stop() {
        if (this.manualTimer) {
            clearTimeout(this.manualTimer);
            this.manualTimer = null;
        }

        /*
         * Stop live tick subscription.
         */
        if (this.subscriptionKey) {
            automatedTicksService.stop(
                this.subscriptionKey
            );

            this.subscriptionKey =
                null;
        }

        this.tradeInProgress =
            false;

        this.manualCurrentStake = 0;
        this.manualMartingaleLevel = 0;
        this.manualConsecutiveLosses = 0;
        this.manualStakeListIndex = 0;
        this.manualDiffersCompleted = false;

        this.manualConfig = null;

        this.setActivity(
            'stopped',
            'Automated trading has been stopped.'
        );

        this.setState(
            'stopped'
        );
    }

    reset() {
        if (this.manualTimer) {
            clearTimeout(this.manualTimer);
            this.manualTimer = null;
        }

        if (
            this.state === 'running' ||
            this.state === 'starting' ||
            this.state === 'trading'
        ) {
            throw new Error(
                'Stop automated trading before resetting'
            );
        }

        this.history = [];

        this.tradeCount = 0;

        this.totalProfit = 0;

        this.lastTradeAt = 0;

        this.lastTickAt = 0;

        this.tickCount = 0;

        this.config = null;

        this.manualConfig = null;

        this.strategy = null;

        this.tradeInProgress =
            false;

        this.manualCurrentStake = 0;
        this.manualMartingaleLevel = 0;
        this.manualConsecutiveLosses = 0;
        this.manualStakeListIndex = 0;
        this.manualDiffersCompleted = false;

        this.setActivity(
            'idle',
            'Automation is ready.'
        );

        this.setState(
            'idle'
        );
    }

    private onTick(
        tick: AutomatedTick
    ) {
        if (
            !this.config ||
            !this.strategy ||
            this.state ===
                'stopped' ||
            this.state === 'error'
        ) {
            return;
        }

        this.lastTickAt =
            tick.epoch;

        this.tickCount += 1;

        /*
         * Keep the most recent 1000 ticks.
         */
        this.history = [
            ...this.history.slice(
                -999
            ),
            tick,
        ];

        /*
         * Only one trade may currently be
         * executing.
         */
        if (
            this.tradeInProgress
        ) {
            return;
        }

        /*
         * Maximum completed trades.
         */
        if (
            this.config.maxTrades !=
                null &&
            this.tradeCount >=
                this.config.maxTrades
        ) {
            void this.stop();

            return;
        }

        /*
         * Profit target.
         */
        if (
            this.config.stopOnProfit !=
                null &&
            this.totalProfit >=
                this.config.stopOnProfit
        ) {
            void this.stop();

            return;
        }

        /*
         * Loss limit.
         */
        if (
            this.config.stopOnLoss !=
                null &&
            this.totalProfit <=
                -Math.abs(
                    this.config.stopOnLoss
                )
        ) {
            void this.stop();

            return;
        }

        /*
         * Optional cooldown between trades.
         */
        if (
            this.config.cooldownMs &&
            Date.now() -
                this.lastTradeAt <
                this.config.cooldownMs
        ) {
            return;
        }

        this.setActivity(
            'analysing',
            `Analysing tick ${this.tickCount}...`
        );

        /*
         * Evaluate the selected strategy.
         */
        const signal =
            this.strategy.evaluate(
                this.history
            );

        if (!signal) {
            this.setActivity(
                'watching_market',
                `Watching ${this.config.symbol} — no qualifying signal yet.`
            );

            return;
        }

        this.listeners.signal?.(
            signal
        );

        const barrierText =
            signal.barrier !=
            null
                ? ` ${signal.barrier}`
                : '';

        this.setActivity(
            'signal_found',
            `${signal.direction ?? signal.contractType}${barrierText} signal detected — ${(signal.confidence * 100).toFixed(1)}% confidence.`
        );

        /*
         * Execute asynchronously so the tick
         * subscription remains responsive.
         */
        void this.execute(
            signal
        );
    }

    private async execute(
        signal: AutomatedSignal
    ) {
        if (
            !this.config ||
            this.tradeInProgress
        ) {
            return;
        }

        /*
         * Lock the engine while this trade is
         * being processed.
         */
        this.tradeInProgress =
            true;

        this.setState(
            'trading'
        );

        try {
            /*
             * Re-check the actual contract
             * capabilities immediately before
             * requesting a proposal.
             */
            const capabilities =
                await automatedCapabilitiesService.getCapabilities(
                    this.config.symbol
                );

            const strategyCapability =
                capabilities.find(
                    capability =>
                        capability.strategy ===
                        signal.strategy
                );

            if (!strategyCapability) {
                throw new Error(
                    `${signal.strategy} is no longer available for ${this.config.symbol}.`
                );
            }

            const contractStillAvailable =
                strategyCapability.contractTypes.includes(
                    signal.contractType
                );

            if (
                !contractStillAvailable
            ) {
                throw new Error(
                    `Contract ${signal.contractType} is not available for ${this.config.symbol}.`
                );
            }

            const barrierText =
                signal.barrier !=
                null
                    ? ` ${signal.barrier}`
                    : '';

            this.setActivity(
                'requesting_proposal',
                `Requesting ${signal.direction ?? signal.contractType}${barrierText} proposal...`
            );

            /*
             * Build the real Deriv proposal.
             */
            const proposal =
                await automatedProposalService.create(
                    this.config,
                    signal
                );

            /*
             * Verify the returned proposal still
             * corresponds to the signal.
             */
            if (
                proposal.contractType &&
                proposal.contractType !==
                    signal.contractType
            ) {
                throw new Error(
                    `Deriv returned contract ${proposal.contractType} instead of ${signal.contractType}.`
                );
            }

            this.setActivity(
                'proposal_received',
                `Proposal received. Stake: ${proposal.askPrice.toFixed(2)} ${this.config.currency}.`
            );

            this.setActivity(
                'buying',
                `Buying ${signal.direction ?? signal.contractType}${barrierText} contract...`
            );

            /*
             * Use Fancy's real purchase pipeline.
             */
            const buy =
                await automatedContractService.buy(
                    proposal
                );

            if (
                !buy?.contract_id
            ) {
                throw new Error(
                    'Deriv returned no contract ID after purchase'
                );
            }

            const contractId =
                String(
                    buy.contract_id
                );

            this.setActivity(
                'monitoring_contract',
                `Contract ${contractId} purchased. Waiting for result...`
            );

            /*
             * Wait for the real Deriv contract
             * result.
             */
            const result =
                await automatedContractService.waitForResult(
                    contractId
                );

            const trade:
                AutomatedTradeResult = {
                ...result,
                signal,
                proposal,
            };

            this.tradeCount += 1;

            this.totalProfit +=
                result.profit;

            this.lastTradeAt =
                Date.now();

            this.listeners.trade?.(
                trade
            );

            /*
             * Report the completed trade.
             */
            if (
                result.profit >= 0
            ) {
                this.setActivity(
                    'trade_won',
                    `Trade completed with profit of ${result.profit.toFixed(2)} ${this.config.currency}.`
                );
            } else {
                this.setActivity(
                    'trade_lost',
                    `Trade completed with loss of ${Math.abs(result.profit).toFixed(2)} ${this.config.currency}.`
                );
            }

            /*
             * Apply session stopping conditions.
             */
            if (
                (
                    this.config
                        .maxTrades !=
                    null &&
                    this.tradeCount >=
                        this.config
                            .maxTrades
                ) ||
                (
                    this.config
                        .stopOnProfit !=
                    null &&
                    this.totalProfit >=
                        this.config
                            .stopOnProfit
                ) ||
                (
                    this.config
                        .stopOnLoss !=
                    null &&
                    this.totalProfit <=
                        -Math.abs(
                            this.config
                                .stopOnLoss
                        )
                )
            ) {
                await this.stop();

                return;
            }

            /*
             * Resume market monitoring.
             */
            this.setState(
                'running'
            );

            this.setActivity(
                'watching_market',
                'Trade complete. Watching for the next signal...'
            );
        } catch (error) {
            const err =
                error instanceof Error
                    ? error
                    : new Error(
                          String(
                              error
                          )
                      );

            this.listeners.error?.(
                err
            );

            this.setActivity(
                'error',
                err.message
            );

            /*
             * A failed proposal/trade attempt does
             * not permanently terminate automation.
             */
            this.setState(
                'running'
            );

            this.setActivity(
                'watching_market',
                `Trade attempt failed: ${err.message}`
            );
        } finally {
            this.tradeInProgress =
                false;
        }
    }

    private setState(
        state: AutomationState
    ) {
        this.state = state;

        this.listeners.state?.(
            state
        );
    }

    private setActivity(
        activity: AutomationActivity,
        message: string
    ) {
        this.activity =
            activity;

        this.message =
            message;

        this.listeners.activity?.(
            activity,
            message
        );
    }
}

export const automatedTradingEngine =
    new AutomatedTradingEngine();

export default automatedTradingEngine;