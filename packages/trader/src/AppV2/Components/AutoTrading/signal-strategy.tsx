import React from 'react';
import { localize } from '@deriv-com/translations';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import {
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
import { candidateLabel } from './insights-compare';

const passthrough = { fancytrading_insights: true };
class StaleSignal extends Error {}
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
    const [watch, setWatch] = React.useState<TWatch>('odd');
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
    const [acknowledged, setAcknowledged] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const [totals, setTotals] = React.useState({ count: 0, net: 0 });
    const run = React.useRef<TRun>();
    const live = React.useRef(false);
    const starting = React.useRef(false);
    const processTick = React.useRef<(ticks: TSignalTick[]) => void>();
    const latestTicks = React.useRef<TSignalTick[]>([]);
    const marker = account && 'fancytrading-rule-purchase:' + account.id;
    const settings = {
        family,
        choice,
        digitChoice,
        digit,
        condition,
        watch,
        watchDigit,
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
    const watchLabels = {
        even: localize('Even digits'),
        odd: localize('Odd digits'),
        rise: localize('Rising prices'),
        fall: localize('Falling prices'),
        digit: localize('A specific digit'),
        over: localize('Digits above a barrier'),
        under: localize('Digits below a barrier'),
        selected: localize('The digit selected for the next trade'),
    };
    const canWatchSelected = family === 'barrier' || (family === 'match' && digitChoice !== 'random');
    const money = (amount: number) => amount.toLocaleString(undefined, { style: 'currency', currency });
    const stop = React.useCallback((message: string) => {
        const current = run.current;
        run.current = undefined;
        current?.controller.abort();
        current?.release();
        setActive(false);
        setAcknowledged(false);
        setStatus(message);
    }, []);

    React.useEffect(() => {
        if (block && run.current) stop(block);
    }, [block, stop]);

    const settle = async (id: string, signal: AbortSignal) => {
        await waitForInsightRequestSlot(signal);
        let subscription: TSubscription | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: () => void = () => undefined;
        try {
            return await new Promise<number>((resolve, reject) => {
                cancel = () => reject(new Error(localize('Run stopped. Check Positions for any open trade.')));
                if (signal.aborted) return cancel();
                signal.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(
                    () => reject(new Error(localize('Settlement could not be confirmed. Check Positions or Reports.'))),
                    120000
                );
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
                        if (response.error)
                            return reject(new Error(response.error.message || localize('Could not check settlement.')));
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
            clearTimeout(timer);
            subscription?.unsubscribe();
        }
    };

    processTick.current = nextTicks => {
        const current = run.current;
        if (!current || !marker) return;
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
                            performance.now() > deadline ||
                            !latest.ready ||
                            !latest.candidates.includes(candidate)
                        )
                            throw new StaleSignal();
                        if (localStorage.getItem(marker))
                            throw new Error(localize('Check the previous trade in Positions or Reports first.'));
                        localStorage.setItem(marker, 'pending');
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
                setTotals({ count: current.count, net: current.net });
                if (
                    current.count >= current.max ||
                    current.net <= -current.loss ||
                    (current.goal > 0 && current.net >= current.goal)
                )
                    stop(localize('Run finished. One of your limits was reached.'));
                else setStatus(localize('Waiting for the next tick.'));
            } catch (error) {
                if (error instanceof StaleSignal && !signal.aborted) {
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
        const watchdog = setInterval(() => {
            if (run.current && performance.now() - lastTickAt > 15000)
                stop(localize('Live ticks stopped arriving. Check your connection.'));
        }, 5000);
        const visibility = () => {
            if (document.hidden && run.current)
                stop(localize('Run stopped when the tab was hidden. Open trades can still settle.'));
        };
        document.addEventListener('visibilitychange', visibility);
        const watch = async () => {
            await waitForInsightRequestSlot(controller.signal);
            const response = (await waitForInsightRequest(
                ws.send({ ticks_history: symbol, end: 'latest', count: 1, style: 'ticks', passthrough }),
                localize('Could not load market precision.')
            )) as { pip_size?: number };
            if (isInsightRateLimit(response)) {
                noteInsightRateLimit();
                throw new Error(localize('Deriv is limiting requests. Reopen this panel in a minute.'));
            }
            precision = response.pip_size;
            await waitForInsightRequestSlot(controller.signal);
            if (controller.signal.aborted) return;
            subscription = ws.subscribeTicks(
                symbol,
                (message: {
                    error?: { message?: string };
                    tick?: { quote: number | string; pip_size?: number; epoch: number; symbol?: string };
                }) => {
                    if (controller.signal.aborted) return;
                    if (message.error) {
                        if (isInsightRateLimit(message)) noteInsightRateLimit();
                        stop(message.error.message || localize('The tick stream stopped.'));
                        return;
                    }
                    const tick = message.tick;
                    if (!tick || (tick.symbol && tick.symbol !== symbol)) return;
                    const decimals = tick.pip_size ?? precision;
                    if (
                        decimals === undefined ||
                        !Number.isInteger(decimals) ||
                        decimals < 0 ||
                        decimals > 10 ||
                        !Number.isFinite(Number(tick.quote))
                    )
                        return;
                    const key = tick.epoch + ':' + tick.quote;
                    if (lastTick === key) return;
                    lastTick = key;
                    lastTickAt = performance.now();
                    const price = Number(tick.quote);
                    ticks = [...ticks.slice(-24), { price, digit: Number(price.toFixed(decimals).slice(-1)) }];
                    latestTicks.current = ticks;
                    setHistory(ticks);
                    processTick.current?.(ticks);
                },
                passthrough
            );
        };
        void watch().catch(error => {
            if (!controller.signal.aborted)
                setStatus(
                    error instanceof Error && error.message
                        ? error.message
                        : localize('The live feed is unavailable. Reopen this panel to reconnect.')
                );
        });
        return () => {
            live.current = false;
            controller.abort();
            run.current?.controller.abort();
            run.current?.release();
            run.current = undefined;
            clearInterval(watchdog);
            document.removeEventListener('visibilitychange', visibility);
            subscription?.unsubscribe();
        };
    }, [symbol, stop, ws]);

    const start = (event: React.FormEvent) => {
        event.preventDefault();
        if (
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
        void navigator.locks
            .request(marker, { ifAvailable: true }, async lock => {
                if (!live.current || document.hidden) return;
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
                        armed: true,
                    };
                    setTotals({ count: 0, net: 0 });
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
            });
    };

    const clearPrevious = async () => {
        if (!marker || !navigator.locks) return;
        try {
            await navigator.locks.request(marker, { ifAvailable: true }, lock => {
                if (!lock || !live.current) return;
                localStorage.removeItem(marker);
                setStatus(localize('Previous purchase acknowledged. You can start a new run.'));
            });
        } catch {
            setStatus(localize('Could not clear the previous purchase.'));
        }
    };

    return (
        <section aria-label={localize('Signal Strategy')}>
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
                    <button type='button' aria-haspopup='dialog' onClick={() => rules.current?.showModal()}>
                        {localize('Rules')}
                    </button>
                    <button type='button' aria-haspopup='dialog' onClick={() => limits.current?.showModal()}>
                        {localize('Automatic settings')}
                    </button>
                </div>
                <dialog ref={rules} className='tick-insights tick-insights__dialog' aria-label={localize('Rules')}>
                    <fieldset
                        className='tick-insights__fields tick-insights__preset tick-insights__signal-fields'
                        disabled={active}
                    >
                        <legend>{localize('Trade rule')}</legend>
                        <p>
                            {localize('Signal source')} · {localize('Live ticks from {{market}}', { market: symbol })}
                        </p>
                        <label>
                            {localize('Which side')}
                            <select
                                value={choice}
                                onChange={event => {
                                    const next = event.target.value as TSignalChoice;
                                    setChoice(next);
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
                                        <option value='opposite'>{localize('Go opposite to the latest tick')}</option>
                                    </>
                                )}
                            </select>
                        </label>
                        {family === 'match' && (
                            <label>
                                {localize('How to choose the digit')}
                                <select
                                    value={digitChoice}
                                    onChange={event => {
                                        setDigitChoice(event.target.value as TDigitChoice);
                                        if (event.target.value === 'random' && watch === 'selected') setWatch('odd');
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
                        )}
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
                                <option value='pattern'>{localize('After an exact digit sequence')}</option>
                            </select>
                        </label>
                        {(condition === 'streak' || condition === 'frequency') && (
                            <>
                                <label>
                                    {localize('Watch for')}
                                    <select value={watch} onChange={event => setWatch(event.target.value as TWatch)}>
                                        {Object.entries(watchLabels)
                                            .filter(([value]) => value !== 'selected' || canWatchSelected)
                                            .map(([value, label]) => (
                                                <option key={value} value={value}>
                                                    {label}
                                                </option>
                                            ))}
                                    </select>
                                </label>
                                {['digit', 'over', 'under'].includes(watch) && (
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
                                <label>
                                    {localize('How far to look back')}
                                    <select value={memory} onChange={event => setMemory(Number(event.target.value))}>
                                        <option value={1}>{localize('Latest tick only')}</option>
                                        <option value={3}>{localize('Any of the last 3 ticks')}</option>
                                        <option value={5}>{localize('Any of the last 5 ticks')}</option>
                                    </select>
                                </label>
                                <label>
                                    {localize('After a trade')}
                                    <select value={after} onChange={event => setAfter(event.target.value as TAfter)}>
                                        <option value='reset'>{localize('Wait for the condition to reset')}</option>
                                        <option value='repeat'>
                                            {localize('Trade again if the condition still holds')}
                                        </option>
                                        <option value='once'>
                                            {localize('Use the condition only to start the run')}
                                        </option>
                                    </select>
                                </label>
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
                                  side: watchLabels[watch],
                                  reading: String(decision.reading),
                                  target,
                              })
                            : displayedRule.condition === 'frequency'
                              ? localize('{{side}} · {{reading}}% · Threshold {{threshold}}', {
                                    side: watchLabels[watch],
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
                        <button
                            type='button'
                            onClick={() => stop(localize('Run stopped. Open trades can still settle.'))}
                        >
                            {localize('Stop run')}
                        </button>
                    ) : (
                        <button
                            type='submit'
                            disabled={!!block || !account || !history.length || (!account.demo && !acknowledged)}
                        >
                            {account?.demo ? localize('Start on demo') : localize('Start on real account')}
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
