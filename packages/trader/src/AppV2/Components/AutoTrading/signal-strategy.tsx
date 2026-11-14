import React from 'react';
import { localize } from '@deriv-com/translations';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import {
    InsightRateLimitError,
    isInsightRateLimit,
    noteInsightRateLimit,
    waitForInsightRequest,
    waitForInsightRequestSlot,
} from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';
import { evaluateSignalRule, signalContracts, signalDigits } from './signal-rule';
import type {
    TComparison,
    TCondition,
    TDigitChoice,
    TSignalChoice,
    TSignalFamily,
    TSignalSettings,
    TSignalTick,
    TWatch,
} from './signal-rule';
import MenuHelp from './menu-help';
import { candidateLabel } from './insights-compare';

const passthrough = { fancytrading_insights: true };
class StaleSignal extends Error {}
class SettlementPending extends Error {}
type TAfter = 'reset' | 'repeat' | 'once';
type TSubscription = { unsubscribe: () => void };
type TRun = {
    controller: AbortController;
    release: () => void;
    stake: number;
    loss: number;
    goal: number;
    max: number;
    ticks: number;
    settings: TSignalSettings;
    after: TAfter;
    net: number;
    count: number;
    pending: boolean;
    purchaseSent: boolean;
    stopRequested: boolean;
    armed: boolean;
};
type TProps = {
    symbol: string;
    currency: string;
    account?: { id: string; demo: boolean };
    contract: string;
    initialStake: number;
    initialTicks: number;
    block: string;
    buy: (trade: TInsightTrade, signal: AbortSignal, beforePurchase: () => void) => Promise<string>;
};

const watchesByFamily: Record<TSignalFamily, readonly [TWatch, TWatch]> = {
    parity: ['even', 'odd'],
    direction: ['rise', 'fall'],
    match: ['selected', 'different'],
    barrier: ['over', 'under'],
};

const SignalStrategy = ({ symbol, currency, account, contract, initialStake, initialTicks, block, buy }: TProps) => {
    const ws = useWS();
    const family =
        (Object.keys(signalContracts) as TSignalFamily[]).find(key =>
            signalContracts[key].some(type => type === contract)
        ) ?? 'parity';
    const rules = React.useRef<HTMLDialogElement>(null);
    const limits = React.useRef<HTMLDialogElement>(null);
    const [choice, setChoice] = React.useState<TSignalChoice>(
        contract === signalContracts[family][1] ? 'second' : 'first'
    );
    const [digitChoice, setDigitChoice] = React.useState<TDigitChoice>('fixed');
    const [digit, setDigit] = React.useState(5);
    const [condition, setCondition] = React.useState<TCondition>('streak');
    const watchOptions = watchesByFamily[family];
    const [watch, setWatch] = React.useState<TWatch>(watchOptions[Number(contract === signalContracts[family][1])]);
    const [watchDigit, setWatchDigit] = React.useState(5);
    const [pattern, setPattern] = React.useState('7777');
    const [comparison, setComparison] = React.useState<TComparison>('minimum');
    const [upper, setUpper] = React.useState('80');
    const [negate, setNegate] = React.useState(false);
    const [memory, setMemory] = React.useState(1);
    const [target, setTarget] = React.useState('4');
    const [after, setAfter] = React.useState<TAfter>('reset');
    const [stake, setStake] = React.useState(String(initialStake));
    const [ticks, setTicks] = React.useState(String(Math.min(initialTicks, 10)));
    const [loss, setLoss] = React.useState(String(initialStake * 3));
    const [goal, setGoal] = React.useState('');
    const [max, setMax] = React.useState('5');
    const [history, setHistory] = React.useState<TSignalTick[]>([]);
    const [active, setActive] = React.useState(false);
    const [stopping, setStopping] = React.useState(false);
    const [startPending, setStartPending] = React.useState(false);
    const [acknowledged, setAcknowledged] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const [totals, setTotals] = React.useState({ count: 0, net: 0 });
    const run = React.useRef<TRun>();
    const live = React.useRef(false);
    const starting = React.useRef(false);
    const processTick = React.useRef<(ticks: TSignalTick[]) => void>();
    const latestTicks = React.useRef<TSignalTick[]>([]);
    const feedVersion = React.useRef(0);
    const tradeBlock = React.useRef(block);
    tradeBlock.current = block;
    const marker = account && 'fancytrading-rule-purchase:' + account.id;
    const settings = {
        family,
        choice,
        digitChoice,
        digit,
        condition,
        watch:
            family === 'match' && digitChoice === 'random'
                ? watch === 'selected'
                    ? ('digit' as const)
                    : ('different_digit' as const)
                : watch,
        watchDigit: family === 'barrier' ? digit : watchDigit,
        target: Number(target),
        pattern,
        comparison,
        upper: Number(upper),
        negate,
        memory,
    };
    const ruleFor = (current: TRun) =>
        current.after === 'once' && current.count > 0
            ? { ...current.settings, condition: 'always' as const }
            : current.settings;
    const displayedRule = run.current ? ruleFor(run.current) : settings;
    const decision = evaluateSignalRule(history, displayedRule, run.current?.count ?? 0);
    const frequencyTarget =
        comparison === 'range' ? `${target}%–${upper}%` : `${comparison === 'maximum' ? '≤' : '≥'} ${target}%`;
    const watchLabels: Record<TWatch, string> = {
        even: localize('Even digits'),
        odd: localize('Odd digits'),
        rise: localize('Rising prices'),
        fall: localize('Falling prices'),
        digit: localize('A specific digit'),
        different_digit: localize('Digits differing from the watch digit'),
        over: localize('Digits above the barrier'),
        under: localize('Digits below the barrier'),
        selected: localize('Digits matching the selected digit'),
        different: localize('Digits differing from the selected digit'),
    };
    const contractLabel = candidateLabel(
        choice === 'first' || choice === 'second' ? signalContracts[family][Number(choice === 'second')] : contract
    );
    const rulesTitle = localize('{{contract}} rules', { contract: contractLabel });
    const money = (amount: number) => amount.toLocaleString(undefined, { style: 'currency', currency });
    const stop = React.useCallback((message: string) => {
        const current = run.current;
        run.current = undefined;
        current?.controller.abort();
        current?.release();
        if (current) setStartPending(true);
        setActive(false);
        setStopping(false);
        setAcknowledged(false);
        setStatus(message);
    }, []);

    const stopRun = React.useCallback(() => {
        const current = run.current;
        if (!current?.purchaseSent) {
            stop(localize('Run stopped.'));
            return;
        }
        current.stopRequested = true;
        setStopping(true);
        setStatus(localize('New trades stopped. Waiting for the last trade to settle before restarting.'));
    }, [stop]);

    const checkSettlement = async (id: string, signal: AbortSignal) => {
        await waitForInsightRequestSlot(signal);
        let subscription: TSubscription | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: () => void = () => undefined;
        let reconnect: () => void = () => undefined;
        try {
            return await new Promise<number>((resolve, reject) => {
                cancel = () => reject(new Error(localize('Run stopped. Check Positions for any open trade.')));
                if (signal.aborted) return cancel();
                signal.addEventListener('abort', cancel, { once: true });
                reconnect = () => reject(new SettlementPending());
                ws.setOnReconnect?.(reconnect);
                timer = setTimeout(reconnect, 30000);
                subscription = ws.subscribeProposalOpenContract(
                    Number(id),
                    (response: {
                        error?: { message?: string };
                        proposal_open_contract?: {
                            is_sold?: number | boolean;
                            profit?: number | string;
                            contract_id?: number;
                        };
                    }) => {
                        if (isInsightRateLimit(response)) noteInsightRateLimit();
                        if (response.error) return reconnect();
                        const trade = response.proposal_open_contract;
                        if (!trade?.is_sold || Number(trade.contract_id) !== Number(id)) return;
                        const profit = trade.profit;
                        if (profit === undefined || profit === '' || !Number.isFinite(Number(profit)))
                            return reject(
                                new Error(localize('Deriv returned an incomplete settlement. Check Reports.'))
                            );
                        resolve(Number(profit));
                    },
                    passthrough
                );
            });
        } finally {
            signal.removeEventListener('abort', cancel);
            ws.removeOnReconnect?.(reconnect);
            clearTimeout(timer);
            try {
                subscription?.unsubscribe();
            } catch {
                // A disconnected subscription can no longer deliver settlement.
            }
        }
    };

    const settle = async (id: string, signal: AbortSignal) => {
        while (!signal.aborted) {
            try {
                if (ws.hasReadyState && !ws.hasReadyState(1)) throw new SettlementPending();
                return await checkSettlement(id, signal);
            } catch (error) {
                if (signal.aborted || !(error instanceof SettlementPending || error instanceof InsightRateLimitError))
                    throw error;
                setStatus(localize('Run paused. Checking the open trade before continuing�'));
                await new Promise<void>(resolve => {
                    const finish = () => {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', finish);
                        resolve();
                    };
                    const timer = setTimeout(finish, error instanceof InsightRateLimitError ? 60000 : 5000);
                    signal.addEventListener('abort', finish, { once: true });
                });
            }
        }
        throw new SettlementPending();
    };

    processTick.current = nextTicks => {
        const current = run.current;
        if (!current || current.stopRequested || !marker) return;
        if (tradeBlock.current) {
            if (!current.pending) setStatus(localize('Run paused. {{reason}}', { reason: tradeBlock.current }));
            return;
        }
        const rule = ruleFor(current);
        const next = evaluateSignalRule(nextTicks, rule, current.count);
        if (!next.ready) {
            current.armed = true;
            if (!current.pending) setStatus(localize('Waiting for your condition.'));
            return;
        }
        if (current.pending) return;
        if (!current.armed && current.after === 'reset' && rule.condition !== 'always') {
            setStatus(localize('Waiting for the condition to reset.'));
            return;
        }
        const precision = getDecimalPlaces(currency);
        if (Number((current.net - current.stake).toFixed(precision)) < -current.loss) {
            stop(localize('Stopped. Another trade could exceed your loss limit.'));
            return;
        }
        current.pending = true;
        current.armed = false;
        const deadline = performance.now() + 4000;
        const quoteFeedVersion = feedVersion.current;

        const candidate = next.candidates[Math.floor(Math.random() * next.candidates.length)];
        const signal = current.controller.signal;
        setStatus(localize('Requesting a quote for {{contract}}…', { contract: candidateLabel(candidate) }));
        void (async () => {
            try {
                await waitForInsightRequestSlot(signal);
                const id = await buy(
                    {
                        candidate,
                        family: 'digital',
                        symbol,
                        currency,
                        ticks: current.ticks,
                        stake: current.stake,
                        payout: 0,
                    },
                    signal,
                    () => {
                        const latest = evaluateSignalRule(latestTicks.current, rule, current.count);
                        if (
                            signal.aborted ||
                            document.hidden ||
                            tradeBlock.current ||
                            feedVersion.current !== quoteFeedVersion ||
                            performance.now() > deadline ||
                            !latest.ready ||
                            !latest.candidates.includes(candidate)
                        )
                            throw new StaleSignal();
                        if (localStorage.getItem(marker))
                            throw new Error(localize('Check the previous trade in Positions or Reports first.'));
                        localStorage.setItem(marker, 'pending');
                        current.purchaseSent = true;
                    }
                );
                if (signal.aborted) return;
                setStatus(
                    localize('{{contract}} opened ({{id}}). Waiting for settlement.', {
                        contract: candidateLabel(candidate),
                        id,
                    })
                );
                const profit = await settle(id, signal);
                if (signal.aborted) return;
                localStorage.removeItem(marker);
                current.net = Number((current.net + profit).toFixed(precision));
                current.count++;
                current.pending = false;
                current.purchaseSent = false;
                setTotals({ count: current.count, net: current.net });
                if (current.stopRequested) {
                    stop(localize('Run stopped. The last trade has settled.'));
                    return;
                }
                if (
                    current.count >= current.max ||
                    current.net <= -current.loss ||
                    (current.goal > 0 && current.net >= current.goal)
                )
                    stop(localize('Run finished. One of your limits was reached.'));
                else setStatus(localize('Waiting for the next tick.'));
            } catch (error) {
                if (
                    !signal.aborted &&
                    !current.purchaseSent &&
                    (error instanceof StaleSignal ||
                        error instanceof InsightRateLimitError ||
                        tradeBlock.current ||
                        feedVersion.current !== quoteFeedVersion ||
                        (ws.hasReadyState && !ws.hasReadyState(1)))
                ) {
                    current.pending = false;
                    current.armed = true;
                    setStatus(localize('The signal changed before purchase. Waiting for a fresh signal.'));
                    return;
                }
                if (!signal.aborted)
                    stop(
                        error instanceof Error && error.message
                            ? error.message
                            : localize('Run stopped. Check Positions or Reports before restarting.')
                    );
            }
        })();
    };

    React.useEffect(() => {
        live.current = true;
        const controller = new AbortController();
        let subscription: TSubscription | undefined;
        let precision: number | undefined;
        let lastTick = '';
        let lastTickAt = performance.now();
        let ticks: TSignalTick[] = [];
        let generation = 0;
        let retry: ReturnType<typeof setTimeout> | undefined;

        const reconnect = (message?: string, delay = 0) => {
            generation++;
            feedVersion.current++;
            clearTimeout(retry);
            try {
                subscription?.unsubscribe();
            } catch {
                // The old subscription may already be closed.
            }
            subscription = undefined;
            if (run.current) setStatus(localize('Run paused. Waiting for fresh ticks�'));
            else if (message) setStatus(message);
            lastTick = '';
            lastTickAt = performance.now();
            ticks = [];
            latestTicks.current = [];
            setHistory([]);
            retry = setTimeout(() => void subscribe(), delay);
        };

        const subscribe = async () => {
            const attempt = generation;
            const isCurrent = () => !controller.signal.aborted && attempt === generation;
            try {
                if (ws.hasReadyState && !ws.hasReadyState(1)) {
                    reconnect(undefined, 5000);
                    return;
                }
                if (precision === undefined) {
                    await waitForInsightRequestSlot(controller.signal);
                    if (!isCurrent()) return;
                    const response = await waitForInsightRequest(
                        ws.send({ ticks_history: symbol, end: 'latest', count: 1, style: 'ticks', passthrough }),
                        localize('Could not load market precision.')
                    );
                    if (!isCurrent()) return;
                    if (isInsightRateLimit(response)) {
                        noteInsightRateLimit();
                        reconnect(localize('Deriv is limiting requests. Retrying the live feed in a minute.'), 60000);
                        return;
                    }
                    precision = response.pip_size;
                }
                await waitForInsightRequestSlot(controller.signal);
                if (!isCurrent()) return;
                const next = ws.subscribeTicks(
                    symbol,
                    (message: {
                        error?: { message?: string };
                        tick?: {
                            quote: number | string;
                            pip_size?: number;
                            epoch: number;
                            symbol?: string;
                            underlying_symbol?: string;
                        };
                    }) => {
                        if (!isCurrent()) return;
                        if (message.error) {
                            const limited = isInsightRateLimit(message);
                            if (limited) noteInsightRateLimit();
                            reconnect(localize('The tick stream stopped. Reconnecting�'), limited ? 60000 : 5000);
                            return;
                        }
                        const tick = message.tick;
                        const market = tick?.symbol ?? tick?.underlying_symbol;
                        if (!tick || (market && market !== symbol)) return;
                        const decimals = tick.pip_size ?? precision;
                        const price = Number(tick.quote);
                        if (
                            decimals === undefined ||
                            !Number.isInteger(decimals) ||
                            decimals < 0 ||
                            decimals > 10 ||
                            !Number.isFinite(price)
                        )
                            return;
                        const key = tick.epoch + ':' + tick.quote;
                        if (lastTick === key) return;
                        if (!ticks.length && !run.current) setStatus('');
                        lastTick = key;
                        lastTickAt = performance.now();
                        ticks = [...ticks.slice(-24), { price, digit: Number(price.toFixed(decimals).slice(-1)) }];
                        latestTicks.current = ticks;
                        setHistory(ticks);
                        processTick.current?.(ticks);
                    },
                    passthrough
                );
                if (isCurrent()) {
                    subscription = next;
                    lastTickAt = performance.now();
                } else next?.unsubscribe();
            } catch (error) {
                if (!isCurrent()) return;
                const limited = isInsightRateLimit(error) || error instanceof InsightRateLimitError;
                if (isInsightRateLimit(error)) noteInsightRateLimit();
                reconnect(localize('The live tick feed is unavailable. Reconnecting�'), limited ? 60000 : 5000);
            }
        };

        const watchdog = setInterval(() => {
            if (subscription && performance.now() - lastTickAt > 15000)
                reconnect(localize('Live ticks stopped arriving. Reconnecting�'), 1000);
        }, 5000);
        const onSocketReconnect = () => reconnect(localize('Connection restored. Waiting for fresh ticks�'));
        ws.setOnReconnect?.(onSocketReconnect);
        const visibility = () => {
            if (document.hidden && run.current) stopRun();
        };
        document.addEventListener('visibilitychange', visibility);
        void subscribe();
        return () => {
            live.current = false;
            controller.abort();
            run.current?.controller.abort();
            run.current?.release();
            run.current = undefined;
            clearTimeout(retry);
            clearInterval(watchdog);
            ws.removeOnReconnect?.(onSocketReconnect);
            document.removeEventListener('visibilitychange', visibility);
            subscription?.unsubscribe();
        };
    }, [symbol, stopRun, ws]);

    const start = (event: React.FormEvent) => {
        event.preventDefault();
        if (
            !latestTicks.current.length ||
            !marker ||
            !account ||
            block ||
            document.hidden ||
            run.current ||
            starting.current ||
            (!account.demo && !acknowledged)
        )
            return;
        if (!navigator.locks) {
            setStatus(
                localize(
                    'This browser cannot prevent duplicate runs across tabs. Open FancyTrading in a supported browser.'
                )
            );
            return;
        }
        const values = {
            stake: Number(stake),
            loss: Number(loss),
            goal: Number(goal),
            max: Number(max),
            ticks: Number(ticks),
        };
        if (
            !Object.values(values).every(Number.isFinite) ||
            values.stake <= 0 ||
            values.loss < values.stake ||
            values.goal < 0 ||
            !Number.isInteger(values.max) ||
            values.max < 1 ||
            values.max > 20 ||
            !Number.isInteger(values.ticks) ||
            values.ticks < 1 ||
            values.ticks > 10
        ) {
            setStatus(localize('Check the stake, duration, and run limits.'));
            return;
        }
        starting.current = true;
        setStartPending(true);
        void navigator.locks
            .request(marker, { ifAvailable: true }, async lock => {
                if (!live.current) return;
                if (!latestTicks.current.length || document.hidden || tradeBlock.current) {
                    setStatus(localize('Wait for an open connection and fresh ticks, then try Start again.'));
                    return;
                }
                if (!lock) {
                    setStatus(localize('A Signal Strategy run is already open for this account in another tab.'));
                    return;
                }
                if (localStorage.getItem(marker)) {
                    setStatus(
                        localize('A previous purchase may still be open. Check Positions or Reports before restarting.')
                    );
                    return;
                }
                await new Promise<void>(release => {
                    run.current = {
                        ...values,
                        settings,
                        after,
                        release,
                        controller: new AbortController(),
                        net: 0,
                        count: 0,
                        pending: false,
                        purchaseSent: false,
                        stopRequested: false,
                        armed: true,
                    };
                    setTotals({ count: 0, net: 0 });
                    setStartPending(false);
                    setActive(true);
                    setStatus(localize('Waiting for the next tick.'));
                });
            })
            .catch(() => {
                if (live.current)
                    setStatus(localize('The run could not start. Check your browser settings and try again.'));
            })
            .finally(() => {
                starting.current = false;
                if (live.current) setStartPending(false);
            });
    };

    const clearPrevious = async () => {
        if (!marker || !navigator.locks) return;
        try {
            await navigator.locks.request(marker, { ifAvailable: true }, lock => {
                if (!live.current) return;
                if (!lock) {
                    setStatus(localize('Another tab is still checking this trade. Wait and try again.'));
                    return;
                }
                localStorage.removeItem(marker);
                setStatus(localize('Previous purchase acknowledged. You can start a new run.'));
            });
        } catch {
            setStatus(localize('Could not clear the previous purchase.'));
        }
    };

    return (
        <section aria-label={localize('Signal Strategy')}>
            <h2>
                {localize('Signal Strategy')} � {contractLabel}
            </h2>
            <p>
                {localize(
                    'Choose what to buy and when to buy it. Keep this panel open and visible while the rule runs.'
                )}
            </p>
            <p>
                {symbol} ·{' '}
                {account
                    ? (account.demo ? localize('Demo account') : localize('Real account')) + ' · ' + account.id
                    : localize('Sign in to run a rule')}
            </p>
            <form
                onSubmit={start}
                onInvalidCapture={event => {
                    if (event.target instanceof HTMLElement) {
                        const dialog = event.target.closest('dialog');
                        if (dialog && !dialog.open) dialog.showModal();
                    }
                }}
            >
                <div className='tick-insights__actions'>
                    <button
                        type='button'
                        aria-haspopup='dialog'
                        disabled={active}
                        onClick={() => rules.current?.showModal()}
                    >
                        {localize('Rules')}
                    </button>
                    <MenuHelp
                        label={localize('Rules')}
                        description={localize(
                            'Choose which tick movement or digit outcome triggers a trade, and how often it must occur.'
                        )}
                    />
                    <button
                        type='button'
                        aria-haspopup='dialog'
                        disabled={active}
                        onClick={() => limits.current?.showModal()}
                    >
                        {localize('Automatic settings')}
                    </button>
                    <MenuHelp
                        label={localize('Automatic settings')}
                        description={localize(
                            'Set stake, duration, stop loss, take profit and the maximum trades for this run.'
                        )}
                    />
                </div>
                <dialog ref={rules} className='tick-insights tick-insights__dialog' aria-label={rulesTitle}>
                    <fieldset
                        className='tick-insights__fields tick-insights__preset tick-insights__signal-fields'
                        disabled={active}
                    >
                        <legend>{rulesTitle}</legend>
                        <div className='tick-insights__action-help'>
                            <p>
                                {localize('Signal source')} ·{' '}
                                {localize('Live ticks from {{market}}', { market: symbol })}
                            </p>
                            <MenuHelp
                                label={localize('Signal source')}
                                description={localize(
                                    'The rule reads live price updates from this market. One price update is called a tick.'
                                )}
                            />
                        </div>
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Contract side')}
                                <select
                                    value={choice}
                                    onChange={event => {
                                        const next = event.target.value as TSignalChoice;
                                        setChoice(next);
                                        if (next === 'first' || next === 'second')
                                            setWatch(watchOptions[Number(next === 'second')]);
                                        if (!signalDigits(family, next).includes(digit)) setDigit(5);
                                    }}
                                >
                                    <option value='first'>{candidateLabel(signalContracts[family][0])}</option>
                                    <option value='second'>{candidateLabel(signalContracts[family][1])}</option>
                                    <option value='alternate'>{localize('Alternate between both')}</option>
                                    <option value='random'>{localize('Pick either side at random')}</option>
                                    {(family === 'parity' || family === 'direction') && (
                                        <>
                                            <option value='same'>{localize('Follow the latest tick')}</option>
                                            <option value='opposite'>
                                                {localize('Go opposite to the latest tick')}
                                            </option>
                                        </>
                                    )}
                                </select>
                            </label>
                            <MenuHelp
                                label={localize('Contract side')}
                                description={localize(
                                    'Choose what to buy when the rule triggers. You can use one side or choose how to switch between both sides.'
                                )}
                            />
                        </div>
                        {family === 'match' && (
                            <label>
                                {localize('How to choose the digit')}
                                <select
                                    value={digitChoice}
                                    onChange={event => {
                                        setDigitChoice(event.target.value as TDigitChoice);
                                    }}
                                >
                                    <option value='fixed'>{localize('Use a digit I choose')}</option>
                                    <option value='rarest'>{localize('Least frequent in the last 20 ticks')}</option>
                                    <option value='frequent'>{localize('Most frequent in the last 20 ticks')}</option>
                                    <option value='random'>{localize('Pick a random digit')}</option>
                                </select>
                            </label>
                        )}
                        {(family === 'barrier' || (family === 'match' && digitChoice === 'fixed')) && (
                            <div className='tick-insights__field-help'>
                                <label>
                                    {family === 'barrier' ? localize('Barrier') : localize('Digit')}
                                    <select value={digit} onChange={event => setDigit(Number(event.target.value))}>
                                        {signalDigits(family, choice).map(value => (
                                            <option key={value} value={value}>
                                                {value}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                                <MenuHelp
                                    label={family === 'barrier' ? localize('Barrier') : localize('Digit')}
                                    description={
                                        family === 'barrier'
                                            ? localize('With a barrier of 5, Over wins on 6�9 and Under wins on 0�4.')
                                            : localize(
                                                  'Choose the digit to compare against. Matches wins if the last digit equals it. Differs wins if the last digit is different.'
                                              )
                                    }
                                />
                            </div>
                        )}
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Entry condition')}
                                <select
                                    value={condition}
                                    onChange={event => {
                                        const value = event.target.value as TCondition;
                                        setCondition(value);
                                        setTarget(value === 'frequency' ? '60' : '4');
                                    }}
                                >
                                    <option value='always'>{localize('After each trade settles')}</option>
                                    <option value='streak'>{localize('After a streak')}</option>
                                    <option value='frequency'>
                                        {localize('When a side reaches a share of the last 20 ticks')}
                                    </option>
                                    {family === 'match' && (
                                        <option value='pattern'>{localize('After an exact digit sequence')}</option>
                                    )}
                                </select>
                            </label>
                            <MenuHelp
                                label={localize('Entry condition')}
                                description={localize(
                                    'Choose whether to enter after a streak, at a frequency threshold, or as soon as the previous trade settles. Digit matching also supports exact sequences.'
                                )}
                            />
                        </div>
                        {(condition === 'streak' || condition === 'frequency') && (
                            <>
                                <div className='tick-insights__field-help'>
                                    <label>
                                        {localize('Watch for')}
                                        <select
                                            value={watch}
                                            onChange={event => setWatch(event.target.value as TWatch)}
                                        >
                                            {watchOptions.map(value => (
                                                <option key={value} value={value}>
                                                    {family === 'match' && digitChoice === 'random'
                                                        ? value === 'selected'
                                                            ? localize('Digits matching the watch digit')
                                                            : watchLabels.different_digit
                                                        : watchLabels[value]}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <MenuHelp
                                        label={localize('Watch for')}
                                        description={localize(
                                            'Choose the market movement or digit outcome the entry rule counts.'
                                        )}
                                    />
                                </div>
                                {family === 'match' && digitChoice === 'random' && (
                                    <label>
                                        {localize('Digit to watch')}
                                        <select
                                            value={watchDigit}
                                            onChange={event => setWatchDigit(Number(event.target.value))}
                                        >
                                            {signalDigits('match', 'first').map(value => (
                                                <option key={value} value={value}>
                                                    {value}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                )}
                                {condition === 'frequency' && (
                                    <label>
                                        {localize('Comparison')}
                                        <select
                                            value={comparison}
                                            onChange={event => setComparison(event.target.value as TComparison)}
                                        >
                                            <option value='minimum'>{localize('At or above')}</option>
                                            <option value='maximum'>{localize('At or below')}</option>
                                            <option value='range'>{localize('Inside a range')}</option>
                                        </select>
                                    </label>
                                )}
                                <div className='tick-insights__field-help'>
                                    <label>
                                        {condition === 'streak'
                                            ? localize('Ticks in a row')
                                            : comparison === 'range'
                                              ? localize('Lower threshold (%)')
                                              : localize('Threshold (%)')}
                                        <input
                                            type='number'
                                            required
                                            min={condition === 'streak' ? 1 : 0}
                                            max={condition === 'streak' ? 20 : 100}
                                            value={target}
                                            onChange={event => setTarget(event.target.value)}
                                        />
                                    </label>
                                    <MenuHelp
                                        label={
                                            condition === 'streak' ? localize('Ticks in a row') : localize('Threshold')
                                        }
                                        description={localize(
                                            'For a streak, enter the number of consecutive ticks that must match. A frequency threshold is a share of the last 20 observations, so 60% means 12 out of 20.'
                                        )}
                                    />
                                </div>
                                {condition === 'frequency' && comparison === 'range' && (
                                    <label>
                                        {localize('Upper threshold (%)')}
                                        <input
                                            type='number'
                                            min={Number(target)}
                                            max='100'
                                            required
                                            value={upper}
                                            onChange={event => setUpper(event.target.value)}
                                        />
                                    </label>
                                )}
                            </>
                        )}
                        {condition === 'pattern' && (
                            <label>
                                {localize('Digits to wait for, oldest first')}
                                <input
                                    type='text'
                                    inputMode='numeric'
                                    pattern='[0-9]{1,20}'
                                    maxLength={20}
                                    required
                                    value={pattern}
                                    onChange={event => setPattern(event.target.value)}
                                />
                            </label>
                        )}
                        {condition !== 'always' && (
                            <>
                                <div className='tick-insights__field-help'>
                                    <label>
                                        {localize('Trade when')}
                                        <select
                                            value={negate ? 'no' : 'yes'}
                                            onChange={event => setNegate(event.target.value === 'no')}
                                        >
                                            <option value='yes'>{localize('The condition holds')}</option>
                                            <option value='no'>{localize('The condition does not hold')}</option>
                                        </select>
                                    </label>
                                    <MenuHelp
                                        label={localize('Trade when')}
                                        description={localize(
                                            'Choose whether to enter when the rule is true or when it is false.'
                                        )}
                                    />
                                </div>
                                <div className='tick-insights__field-help'>
                                    <label>
                                        {localize('How far to look back')}
                                        <select
                                            value={memory}
                                            onChange={event => setMemory(Number(event.target.value))}
                                        >
                                            <option value={1}>{localize('Latest tick only')}</option>
                                            <option value={3}>{localize('Any of the last 3 ticks')}</option>
                                            <option value={5}>{localize('Any of the last 5 ticks')}</option>
                                        </select>
                                    </label>
                                    <MenuHelp
                                        label={localize('How far to look back')}
                                        description={localize(
                                            'Choose whether the rule must be true on the newest tick or can have been true on any of the last three or five ticks.'
                                        )}
                                    />
                                </div>
                                <div className='tick-insights__field-help'>
                                    <label>
                                        {localize('After a trade')}
                                        <select
                                            value={after}
                                            onChange={event => setAfter(event.target.value as TAfter)}
                                        >
                                            <option value='reset'>{localize('Wait for the condition to reset')}</option>
                                            <option value='repeat'>
                                                {localize('Trade again if the condition still holds')}
                                            </option>
                                            <option value='once'>
                                                {localize('Use the condition only to start the run')}
                                            </option>
                                        </select>
                                    </label>
                                    <MenuHelp
                                        label={localize('After a trade')}
                                        description={localize(
                                            'After settlement, wait for a new signal, trade again if the rule still holds, or use the rule only for the first trade.'
                                        )}
                                    />
                                </div>
                            </>
                        )}
                    </fieldset>
                    <button type='button' onClick={() => rules.current?.close()}>
                        {localize('Done')}
                    </button>
                </dialog>
                <dialog
                    ref={limits}
                    className='tick-insights tick-insights__dialog'
                    aria-label={localize('Automatic settings')}
                >
                    <fieldset className='tick-insights__fields tick-insights__preset' disabled={active}>
                        <legend>
                            {localize('Run limits')} ({currency})
                        </legend>
                        <label>
                            {localize('Stake per trade')}
                            <input
                                type='number'
                                min='0.01'
                                step='any'
                                required
                                value={stake}
                                onChange={event => setStake(event.target.value)}
                            />
                        </label>
                        <label>
                            {localize('Duration in ticks')}
                            <input
                                type='number'
                                min='1'
                                max='10'
                                required
                                value={ticks}
                                onChange={event => setTicks(event.target.value)}
                            />
                        </label>
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Stop loss')}
                                <input
                                    type='number'
                                    min={stake}
                                    step='any'
                                    required
                                    value={loss}
                                    onChange={event => setLoss(event.target.value)}
                                />
                            </label>
                            <MenuHelp
                                label={localize('Stop loss')}
                                description={localize('The most this run can lose before it stops placing new trades.')}
                            />
                        </div>
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Take profit (optional)')}
                                <input
                                    type='number'
                                    min='0.01'
                                    step='any'
                                    value={goal}
                                    onChange={event => setGoal(event.target.value)}
                                />
                            </label>
                            <MenuHelp
                                label={localize('Take profit (optional)')}
                                description={localize(
                                    'The net profit at which the run stops. Leave blank to use the other limits.'
                                )}
                            />
                        </div>
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Maximum trades')}
                                <input
                                    type='number'
                                    min='1'
                                    max='20'
                                    required
                                    value={max}
                                    onChange={event => setMax(event.target.value)}
                                />
                            </label>
                            <MenuHelp
                                label={localize('Maximum trades')}
                                description={localize('The run stops after this many trades have settled.')}
                            />
                        </div>
                    </fieldset>
                    <button type='button' onClick={() => limits.current?.close()}>
                        {localize('Done')}
                    </button>
                </dialog>
                <p>
                    <strong>{localize('Next trade')}</strong> ·{' '}
                    {decision.candidates.length === 1
                        ? candidateLabel(decision.candidates[0])
                        : decision.candidates.length > 1
                          ? localize('Chosen at random when the rule fires')
                          : '—'}{' '}
                    · {ticks} {localize('ticks')} · {money(Number(stake) || 0)}
                </p>
                <p>
                    {!history.length
                        ? localize('Waiting for live ticks…')
                        : (displayedRule.condition === 'frequency' && decision.eligible < 20) ||
                            (family === 'match' && ['rarest', 'frequent'].includes(digitChoice) && history.length < 20)
                          ? localize('Collecting observations for the 20-tick window…')
                          : displayedRule.condition === 'streak'
                            ? localize('{{side}} streak {{reading}}/{{target}}', {
                                  side: watchLabels[displayedRule.watch],
                                  reading: String(decision.reading),
                                  target,
                              })
                            : displayedRule.condition === 'frequency'
                              ? localize('{{side}} · {{reading}}% · Threshold {{threshold}}', {
                                    side: watchLabels[displayedRule.watch],
                                    reading: String(decision.reading),
                                    threshold: frequencyTarget,
                                })
                              : displayedRule.condition === 'pattern'
                                ? decision.ready
                                    ? localize('Digit sequence found.')
                                    : localize('Waiting for digit sequence {{pattern}}.', { pattern })
                                : localize('Ready on the next tick.')}
                </p>
                {!!history.length && displayedRule.condition !== 'always' && (
                    <p>{decision.ready ? localize('Entry rule is ready.') : localize('Waiting for the entry rule.')}</p>
                )}
                {account && !account.demo && !active && (
                    <label>
                        <input
                            type='checkbox'
                            checked={acknowledged}
                            onChange={event => setAcknowledged(event.target.checked)}
                        />
                        {localize('I authorize automatic trades using real funds on this account.')}
                    </label>
                )}
                <div className='tick-insights__actions'>
                    {active ? (
                        <button type='button' disabled={stopping} onClick={stopRun}>
                            {stopping ? localize('Stopping�') : localize('Stop run')}
                        </button>
                    ) : (
                        <button
                            type='submit'
                            disabled={
                                startPending ||
                                !!block ||
                                !account ||
                                !history.length ||
                                (!account.demo && !acknowledged)
                            }
                        >
                            {startPending
                                ? localize('Please wait�')
                                : account?.demo
                                  ? localize('Start on demo')
                                  : localize('Start on real account')}
                        </button>
                    )}
                </div>
            </form>
            {block && <p>{block}</p>}
            {status && <p role='status'>{status}</p>}
            <p>
                {localize('Settled trades')} {totals.count} · {localize('Net result')} {money(totals.net)}
            </p>
            {!active && marker && (
                <details>
                    <summary>{localize('Resolve a previous purchase')}</summary>
                    <p>
                        {localize(
                            'Check Positions and Reports. Continue after any trade from the previous run has settled.'
                        )}
                    </p>
                    <button type='button' onClick={() => void clearPrevious()}>
                        {localize('I checked the previous purchase')}
                    </button>
                </details>
            )}
        </section>
    );
};

export default SignalStrategy;
