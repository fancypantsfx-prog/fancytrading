import React from 'react';
import { localize } from '@deriv-com/translations';
import {
    compareRecentTicks,
    getInsightContract,
    InsightRateLimitError,
    isInsightRateLimit,
    noteInsightRateLimit,
    waitForInsightRequest,
    waitForInsightRequestSlot,
} from './tick-insights-data';
import type { TFamily, TTickInsights } from './tick-insights-data';

export type TCompareSetup = { symbol: string; candidate: string };
export type TCompareResult = { setup: TCompareSetup; report: TTickInsights; row: TTickInsights['rows'][number] };
const familyOf = (candidate: string): TFamily => (/^[1-5]$/.test(candidate) ? 'accumulator' : 'digital');
const percent = (value: number) => value.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 1 });
const contracts = [
    'CALL',
    'PUT',
    'DIGITEVEN',
    'DIGITODD',
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITMATCH',
    'DIGITDIFF',
];

export const candidateLabel = (candidate: string) => {
    const [type, barrier] = candidate.split(':');
    switch (type) {
        case 'CALL':
            return localize('Rise');
        case 'PUT':
            return localize('Fall');
        case 'DIGITEVEN':
            return localize('Digit Even');
        case 'DIGITODD':
            return localize('Digit Odd');
        case 'DIGITOVER':
            return localize('Digit Over {{digit}}', { digit: barrier ?? '' }).trim();
        case 'DIGITUNDER':
            return localize('Digit Under {{digit}}', { digit: barrier ?? '' }).trim();
        case 'DIGITMATCH':
            return localize('Digit Matches {{digit}}', { digit: barrier ?? '' }).trim();
        case 'DIGITDIFF':
            return localize('Digit Differs {{digit}}', { digit: barrier ?? '' }).trim();
        default:
            return localize('{{rate}}% growth', { rate: candidate });
    }
};

type TProps = {
    symbol: string;
    currency: string;
    stake: string;
    onStake: (stake: string) => void;
    setups: TCompareSetup[];
    onSetups: (setups: TCompareSetup[]) => void;
    durations: number[];
    onDurations: (durations: number[]) => void;
    send: Parameters<typeof compareRecentTicks>[0];
    subscribeTicks?: (symbol: string, callback: (response: { tick?: unknown }) => void) => { unsubscribe: () => void };
    markets: { symbol: string; label: string }[];
    onReview: (result: TCompareResult, automatic: boolean) => void;
    canBuy: boolean;
    canReview: (contract: string) => boolean;
};

const InsightsCompare = ({
    symbol,
    currency,
    stake,
    onStake,
    setups,
    onSetups,
    durations,
    onDurations,
    send,
    subscribeTicks,
    markets,
    onReview,
    canBuy,
    canReview,
}: TProps) => {
    const [windowSize, setWindowSize] = React.useState(100);
    const [duration, setDuration] = React.useState('5');
    const [live, setLive] = React.useState(false);
    const [rateLimited, setRateLimited] = React.useState(false);
    const [refresh, setRefresh] = React.useState(0);
    const [showWins, setShowWins] = React.useState(true);
    const [showLosses, setShowLosses] = React.useState(true);
    const [showTimeline, setShowTimeline] = React.useState(true);
    const [snapshot, setSnapshot] = React.useState<{
        key: string;
        results: { setup: TCompareSetup; ticks: number; result?: TCompareResult }[];
        updated: number;
    }>();
    const key = JSON.stringify([setups, durations, windowSize, stake, currency]);
    const current = snapshot?.key === key ? snapshot : undefined;
    const sendRef = React.useRef(send);
    sendRef.current = send;
    const subscribeRef = React.useRef(subscribeTicks);
    subscribeRef.current = subscribeTicks;
    React.useEffect(() => {
        if (rateLimited || !Number.isFinite(Number(stake)) || Number(stake) < 0.01 || Number(stake) > 1000000) return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let request: AbortController;
        let cancelled = false;
        let running = false;
        let pendingTick = false;
        let lastStart = 0;
        const streamController = new AbortController();
        const subscriptions: { unsubscribe: () => void }[] = [];
        const pauseForRateLimit = () => {
            if (cancelled) return;
            cancelled = true;
            request?.abort();
            setRateLimited(true);
            setLive(false);
        };
        const schedule = () => {
            if (cancelled || running || timer) return;
            timer = setTimeout(
                () => {
                    timer = undefined;
                    void update();
                },
                Math.max(0, 5000 - (Date.now() - lastStart))
            );
        };
        const update = async () => {
            running = true;
            pendingTick = false;
            lastStart = Date.now();
            request = new AbortController();
            const { signal } = request;
            const marketRequests = new Map();
            const results = await Promise.all(
                setups.flatMap(setup =>
                    durations.map(async ticks => {
                        try {
                            const report = await waitForInsightRequest(
                                compareRecentTicks(
                                    sendRef.current,
                                    {
                                        ...setup,
                                        ticks,
                                        currency,
                                        stake: Number(stake),
                                        windowSize,
                                        family: familyOf(setup.candidate),
                                    },
                                    signal,
                                    marketRequests
                                ),
                                localize('Comparison timed out.')
                            );
                            const row = report?.rows[0];
                            return { setup, ticks, result: report && row ? { setup, report, row } : undefined };
                        } catch (error) {
                            if (error instanceof InsightRateLimitError) pauseForRateLimit();
                            return { setup, ticks };
                        }
                    })
                )
            );
            if (cancelled) return;
            request.abort();
            running = false;
            setSnapshot({ key, results, updated: Date.now() });
            if (live && (pendingTick || !subscriptions.length)) schedule();
        };
        if (live || !current) void update();
        const subscribe = subscribeRef.current;
        if (live && subscribe) {
            for (const symbol of new Set(setups.map(setup => setup.symbol))) {
                void waitForInsightRequestSlot(streamController.signal)
                    .then(() => {
                        if (cancelled) return;
                        subscriptions.push(
                            subscribe(symbol, response => {
                                if (isInsightRateLimit(response)) {
                                    noteInsightRateLimit();
                                    pauseForRateLimit();
                                    return;
                                }
                                if (!response.tick) return;
                                pendingTick = true;
                                schedule();
                            })
                        );
                    })
                    .catch(error => {
                        if (error instanceof InsightRateLimitError) pauseForRateLimit();
                    });
            }
        }
        return () => {
            cancelled = true;
            request?.abort();
            streamController.abort();
            clearTimeout(timer);
            for (const subscription of subscriptions) subscription.unsubscribe();
        };
        // The key tracks all comparison inputs. Keep the last snapshot when pausing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, live, refresh, rateLimited]);

    const changeSetup = (index: number, setup: TCompareSetup) =>
        onSetups(setups.map((item, position) => (position === index ? setup : item)));
    const money = (value: number) => value.toLocaleString(undefined, { style: 'currency', currency });
    const marketLabel = (market: string) => markets.find(item => item.symbol === market)?.label ?? market;

    return (
        <section aria-label={localize('Compare setups')}>
            <div className='tick-insights__fields'>
                <label>
                    {localize('History window')}
                    <select value={windowSize} onChange={e => setWindowSize(Number(e.target.value))}>
                        {[20, 100, 400].map(size => (
                            <option key={size} value={size}>
                                {localize('Last {{size}} ticks', { size: String(size) })}
                            </option>
                        ))}
                    </select>
                </label>
                <label>
                    {localize('Stake per trade')} ({currency})
                    <input
                        type='number'
                        min='0.01'
                        max='1000000'
                        step='any'
                        value={stake}
                        onChange={e => onStake(e.target.value)}
                    />
                </label>
                <button
                    type='button'
                    aria-pressed={live}
                    onClick={() => {
                        setRateLimited(false);
                        setLive(!live);
                    }}
                >
                    {live ? localize('Pause') : localize('Go live')}
                </button>
                <button
                    type='button'
                    onClick={() => {
                        setRateLimited(false);
                        setSnapshot(undefined);
                        setRefresh(refresh + 1);
                    }}
                >
                    {localize('Refresh')}
                </button>
            </div>
            <fieldset className='tick-insights__fields tick-insights__preset'>
                <legend>{localize('Durations applied to every setup')}</legend>
                {durations.map(ticks => (
                    <button
                        key={ticks}
                        type='button'
                        disabled={durations.length === 1}
                        onClick={() => onDurations(durations.filter(value => value !== ticks))}
                        aria-label={localize('Remove {{ticks}}-tick duration', { ticks: String(ticks) })}
                    >
                        {ticks} {localize('ticks')} ×
                    </button>
                ))}
                <label>
                    {localize('Duration in ticks')}
                    <select value={duration} onChange={e => setDuration(e.target.value)}>
                        {Array.from({ length: 20 }, (_, index) => index + 1).map(value => (
                            <option key={value}>{value}</option>
                        ))}
                    </select>
                </label>
                <button
                    type='button'
                    disabled={durations.length >= 4 || durations.includes(Number(duration))}
                    onClick={() => onDurations([...durations, Number(duration)])}
                >
                    {localize('Add duration')}
                </button>
            </fieldset>
            {setups.map((setup, index) => {
                const [contract, barrier] = setup.candidate.split(':');
                const digits = Array.from({ length: 10 }, (_, digit) => digit).filter(
                    digit => (contract !== 'DIGITOVER' || digit < 9) && (contract !== 'DIGITUNDER' || digit > 0)
                );
                return (
                    <fieldset className='tick-insights__fields tick-insights__preset' key={index}>
                        <legend>{localize('Setup {{number}}', { number: String(index + 1) })}</legend>
                        <label>
                            {localize('Instrument')}
                            <select
                                value={setup.symbol}
                                onChange={e => changeSetup(index, { ...setup, symbol: e.target.value })}
                            >
                                {!markets.some(item => item.symbol === setup.symbol) && (
                                    <option value={setup.symbol}>{setup.symbol}</option>
                                )}
                                {markets.map(item => (
                                    <option key={item.symbol} value={item.symbol}>
                                        {item.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            {localize('Contract')}
                            <select
                                value={contract}
                                onChange={e => {
                                    const type = e.target.value;
                                    changeSetup(index, {
                                        ...setup,
                                        candidate: ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(type)
                                            ? `${type}:5`
                                            : type,
                                    });
                                }}
                            >
                                {contracts.map(value => (
                                    <option key={value} value={value}>
                                        {candidateLabel(value)}
                                    </option>
                                ))}
                            </select>
                        </label>
                        {barrier !== undefined && (
                            <label>
                                {localize('Barrier')}
                                <select
                                    value={barrier}
                                    onChange={e =>
                                        changeSetup(index, { ...setup, candidate: `${contract}:${e.target.value}` })
                                    }
                                >
                                    {digits.map(digit => (
                                        <option key={digit}>{digit}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {setups.length > 1 && (
                            <button
                                type='button'
                                onClick={() => onSetups(setups.filter((_, position) => position !== index))}
                            >
                                {localize('Remove setup')}
                            </button>
                        )}
                    </fieldset>
                );
            })}
            <button
                type='button'
                disabled={setups.length >= 4}
                onClick={() => onSetups([...setups, { symbol, candidate: 'DIGITOVER:4' }])}
            >
                {localize('Add setup')}
            </button>
            <details className='tick-insights__metrics'>
                <summary>{localize('Show metrics')}</summary>
                <label>
                    <input type='checkbox' checked={showWins} onChange={e => setShowWins(e.target.checked)} />
                    {localize('Max consecutive wins')}
                </label>
                <label>
                    <input type='checkbox' checked={showLosses} onChange={e => setShowLosses(e.target.checked)} />
                    {localize('Max consecutive losses')}
                </label>
                <label>
                    <input type='checkbox' checked={showTimeline} onChange={e => setShowTimeline(e.target.checked)} />
                    {localize('Win/loss timeline')}
                </label>
            </details>
            {rateLimited && (
                <p role='status'>
                    {localize('Deriv is limiting requests. Wait a minute before refreshing or going live again.')}
                </p>
            )}
            {!current && !rateLimited && (
                <p role='status'>
                    {Number(stake) >= 0.01 && Number(stake) <= 1000000
                        ? localize('Loading comparison…')
                        : localize('Enter a valid stake.')}
                </p>
            )}
            {current && (
                <p className='tick-insights__note'>
                    {localize(
                        'Last quote check {{time}}. Estimates use current quotes and historical simulated outcomes.',
                        { time: new Date(current.updated).toLocaleTimeString() }
                    )}
                </p>
            )}
            <div className='tick-insights__comparison-grid'>
                {current?.results.map(({ setup, ticks, result }, index) => {
                    const { row, report } = result ?? {};
                    const rate = row?.historical.count ? row.historical.hits / row.historical.count : undefined;
                    return (
                        <article className='tick-insights__comparison-card' key={index}>
                            <h3>
                                {marketLabel(setup.symbol)} · {candidateLabel(setup.candidate)} · {ticks}{' '}
                                {localize('ticks')}
                            </h3>
                            {rate === undefined || !row || !report || !result ? (
                                <p>{localize('No completed trials or comparable quote for this setup.')}</p>
                            ) : (
                                <>
                                    <p className='tick-insights__net'>
                                        {money(row.estimatedNet ?? 0)} · {percent(row.returnOnStake ?? 0)}
                                        <small>{localize('Estimated net and return on total staked')}</small>
                                    </p>
                                    <p>
                                        {row.historical.hits}/{row.historical.count} {localize('wins')} ·{' '}
                                        {money(row.stake)} {localize('per trade')}
                                    </p>
                                    <p className='tick-insights__note'>
                                        {new Date(report.firstTick * 1000).toLocaleString()} –{' '}
                                        {new Date(report.lastTick * 1000).toLocaleString()}
                                    </p>
                                    {row.estimated && (
                                        <p className='tick-insights__note'>
                                            {localize(
                                                'Accumulator replay uses the currently quoted range and assumes exit at the selected tick target.'
                                            )}
                                        </p>
                                    )}
                                    <div className='tick-insights__chart-label'>
                                        <span>
                                            {localize('Win rate')} {percent(rate)}
                                        </span>
                                        {row.breakEven !== undefined && (
                                            <span>
                                                {localize('Break-even')} {percent(row.breakEven)}
                                            </span>
                                        )}
                                    </div>
                                    <div className='tick-insights__rate-chart' aria-hidden='true'>
                                        <span style={{ width: percent(rate) }} />
                                        {row.breakEven !== undefined && (
                                            <i style={{ insetInlineStart: percent(row.breakEven) }} />
                                        )}
                                    </div>
                                    <div className='tick-insights__chart-label' aria-hidden='true'>
                                        <span>0%</span>
                                        <span>100%</span>
                                    </div>
                                    <p>
                                        {showWins && (
                                            <span>
                                                {localize('Max consecutive wins')} {row.maxWins}{' '}
                                            </span>
                                        )}
                                        {showLosses && (
                                            <span>
                                                {localize('Max consecutive losses')} {row.maxLosses}
                                            </span>
                                        )}
                                    </p>
                                    {showTimeline && row.outcomes && (
                                        <OutcomeTimeline
                                            outcomes={row.outcomes}
                                            maxWins={row.maxWins}
                                            maxLosses={row.maxLosses}
                                        />
                                    )}
                                    <div className='tick-insights__actions'>
                                        <button
                                            type='button'
                                            disabled={!canBuy}
                                            onClick={() => onReview(result, false)}
                                        >
                                            {localize('Buy once')}
                                        </button>
                                        <button
                                            type='button'
                                            disabled={
                                                !canReview(
                                                    getInsightContract(
                                                        familyOf(setup.candidate),
                                                        setup.candidate,
                                                        ticks
                                                    ).contract_type
                                                )
                                            }
                                            onClick={() => onReview(result, true)}
                                        >
                                            {localize('Review automatic')}
                                        </button>
                                    </div>
                                </>
                            )}
                        </article>
                    );
                })}
            </div>
        </section>
    );
};

const OutcomeTimeline = ({
    outcomes,
    maxWins,
    maxLosses,
}: {
    outcomes: boolean[];
    maxWins?: number;
    maxLosses?: number;
}) => {
    const streaks: { win: boolean; length: number }[] = [];
    for (const win of outcomes) {
        const previous = streaks.at(-1);
        if (previous?.win === win) previous.length++;
        else streaks.push({ win, length: 1 });
    }
    return (
        <>
            <p className='tick-insights__timeline-key'>
                <span className='is-win'>{localize('Wins')}</span>
                <span className='is-loss'>{localize('Losses')}</span>
                <span>{localize('Underline marks a longest streak')}</span>
            </p>
            <div className='tick-insights__timeline' aria-label={localize('Win/loss timeline, oldest to newest')}>
                {streaks.map(({ win, length }, index) => (
                    <span
                        key={index}
                        className={win ? 'is-win' : 'is-loss'}
                        data-longest={length === (win ? maxWins : maxLosses)}
                        style={{ flexGrow: length }}
                        title={
                            win
                                ? localize('{{count}} consecutive wins', { count: String(length) })
                                : localize('{{count}} consecutive losses', { count: String(length) })
                        }
                    />
                ))}
            </div>
        </>
    );
};

export default InsightsCompare;
