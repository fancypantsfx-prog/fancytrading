import React from 'react';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { candidateLabel } from './insights-compare';
import type { RankedContractGroup, RankedQuote } from './ranked-trade';
import { fresh, rankedContractGroup, rankedTradeKey, selectRankedTrade } from './ranked-trade';
import {
    getInsightCooldown,
    InsightQuoteChanged,
    InsightRateLimitError,
    InsightRequestTimeout,
    REQUEST_SPACING_MS,
    sendInsightRequest,
    waitForInsightRequest,
} from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

type Props = {
    currency: string;
    symbol?: string;
    stake: number;
    account: string;
    block: string;
    buy: (
        trade: TInsightTrade,
        signal: AbortSignal,
        beforeBuy: () => void,
        acceptUpdatedPayout: boolean
    ) => Promise<string>;
};
type ReviewDecision = RankedQuote | 'batch' | null;
type RankedSlot = { rank: number; quote: RankedQuote };
const rankSelections = { all: [0, 1, 2], topTwo: [0, 1], first: [0], second: [1], third: [2] };
const ROUND_SPACING_MS = 1000;
const ROUNDS_PER_ANALYSIS = 3;
const ANALYSIS_COOLDOWN_MS = 5000;
const INITIAL_TIMEOUT_RETRY_MS = 2000;
const MAX_TIMEOUT_RETRY_MS = 15000;
type RankSelection = keyof typeof rankSelections;
const contractGroups: readonly RankedContractGroup[] = ['rise_fall', 'even_odd', 'over_under'];
const contractGroupLabel = (group: RankedContractGroup) => {
    switch (group) {
        case 'rise_fall':
            return localize('Rise / Fall');
        case 'even_odd':
            return localize('Even / Odd');
        case 'over_under':
            return localize('Over / Under');
    }
};

export default function RankedRunner({ currency, symbol, stake, account, block, buy }: Props) {
    const ws = useWS();
    const [loss, setLoss] = React.useState('');
    const [target, setTarget] = React.useState(String(3 * stake));
    const [method, setMethod] = React.useState('fixed');
    const [mode, setMode] = React.useState('automatic');
    const [rankSelection, setRankSelection] = React.useState<RankSelection>('all');
    const [alternateLosers, setAlternateLosers] = React.useState(false);
    const [onlyGroup, setOnlyGroup] = React.useState<RankedContractGroup | ''>('');
    const [excludeGroup, setExcludeGroup] = React.useState<RankedContractGroup | ''>('');
    const [review, setReview] = React.useState<{ quotes: RankedQuote[]; batchSize: number }>();
    const reviewDecision = React.useRef<(decision?: ReviewDecision) => void>();
    const [rankings, setRankings] = React.useState<RankedSlot[]>();
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const [cooldownSeconds, setCooldownSeconds] = React.useState<number>();
    const cancelCooldown = React.useRef<() => void>();
    const current = React.useRef<AbortController>();
    const stopping = React.useRef(false);
    const latest = React.useRef({ block, buy });
    latest.current = { block, buy };
    React.useEffect(
        () => () => {
            current.current?.abort();
            reviewDecision.current?.();
        },
        []
    );
    const key = 'fancy-ranked-purchase:' + account;
    const start = async () => {
        if (current.current || !ws || block) return;
        const sl = Number(loss),
            tp = Number(target);
        if (!(Number.isFinite(stake) && stake > 0 && Number.isFinite(sl) && sl > 0 && Number.isFinite(tp) && tp > 0)) {
            setStatus(localize('Enter a positive stake, take profit and stop loss.'));
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        current.current = controller;
        stopping.current = false;
        setRankings(undefined);
        setRunning(true);

        const waitWithCountdown = (ms: number, settling = false) =>
            new Promise<void>(resolve => {
                const deadline = performance.now() + ms;
                let timer: ReturnType<typeof setTimeout>;
                const finish = () => {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', finish);
                    cancelCooldown.current = undefined;
                    if (!signal.aborted) setCooldownSeconds(undefined);
                    resolve();
                };
                const update = () => {
                    const remaining = deadline - performance.now();
                    if (signal.aborted || (!settling && stopping.current) || remaining <= 0) {
                        finish();
                        return;
                    }
                    setCooldownSeconds(
                        remaining <= 1000 ? Math.ceil(remaining / 100) / 10 : Math.ceil(remaining / 1000)
                    );
                    timer = setTimeout(update, Math.min(remaining, remaining > 1000 ? 1000 : 100));
                };
                if (!settling) cancelCooldown.current = finish;
                signal.addEventListener('abort', finish, { once: true });
                update();
            });

        try {
            await navigator.locks.request(key, { ifAvailable: true }, async lock => {
                if (!lock) throw new Error('A ranked run is active in another tab.');
                if (localStorage.getItem(key))
                    throw new Error(
                        'Review the previous purchase in Positions and Reports before starting another run.'
                    );
                let net = 0,
                    amount = stake;
                let winners = new Map<number, TInsightTrade>();
                let nextRoundAt = 0;
                let rounds = 0;
                let topQuotes: RankedSlot[] = [];
                let reserves: RankedQuote[] = [];
                let timeoutRetryMs = INITIAL_TIMEOUT_RETRY_MS;
                const retryAfterTimeout = async (message: string, settling = false) => {
                    setStatus(message);
                    const delay = timeoutRetryMs;
                    timeoutRetryMs = Math.min(delay * 2, MAX_TIMEOUT_RETRY_MS);
                    await waitWithCountdown(Math.max(delay, getInsightCooldown()), settling);
                };
                const skipped = new Set<string>();
                const decimals = getDecimalPlaces(currency);
                const round = (value: number) => Number(value.toFixed(decimals));
                const floorStake = (value: number) => {
                    const rounded = round(value);
                    return rounded > value ? round(rounded - 10 ** -decimals) : rounded;
                };
                const budgetLimit = floorStake(sl);
                const stopLimit = budgetLimit < sl ? budgetLimit : round(budgetLimit - 10 ** -decimals);
                const matchesFilter = ({ trade }: RankedQuote) => {
                    const group = rankedContractGroup(trade.candidate);
                    return !!group && (!onlyGroup || group === onlyGroup) && group !== excludeGroup;
                };
                while (!signal.aborted && !stopping.current) {
                    if (latest.current.block) throw new Error(latest.current.block);
                    const remaining = Math.min(stopLimit, round(net + stopLimit));
                    if (net >= tp || remaining <= 0) break;
                    const cooldown = getInsightCooldown();
                    if (cooldown > 0) {
                        setStatus(localize('Deriv is limiting quotes. Retrying when the limit clears.'));
                        await waitWithCountdown(cooldown);
                        continue;
                    }
                    const spacing = nextRoundAt - performance.now();
                    if (spacing > 0) {
                        setStatus(
                            rounds === ROUNDS_PER_ANALYSIS
                                ? localize('Three rounds complete. Cooling down before the next analysis.')
                                : localize('Preparing the next trade round.')
                        );
                        await waitWithCountdown(spacing);
                        continue;
                    }
                    amount = Math.min(amount, remaining);
                    if (rounds === ROUNDS_PER_ANALYSIS || topQuotes.some(({ quote }) => !fresh(quote.time))) {
                        rounds = 0;
                        topQuotes = [];
                    }
                    if (!topQuotes.length) {
                        setStatus('Comparing live contracts. Session P/L ' + net + ' ' + currency);
                        let pick: RankedQuote | undefined;
                        let compared: RankedQuote[] = [];
                        try {
                            pick = await selectRankedTrade(
                                payload => waitForInsightRequest(ws.send(payload), 'Comparison request timed out.'),
                                currency,
                                amount,
                                signal,
                                skipped,
                                quotes => {
                                    compared = quotes;
                                },
                                symbol,
                                [...winners.values()]
                            );
                        } catch (error) {
                            if (error instanceof InsightRequestTimeout) {
                                await retryAfterTimeout(localize('Comparison timed out. Retrying shortly.'));
                                continue;
                            }
                            if (!(error instanceof InsightRateLimitError)) throw error;
                            setStatus('Deriv is limiting quotes. Retrying when the limit clears.');
                            await waitWithCountdown(Math.max(getInsightCooldown(), REQUEST_SPACING_MS));
                            continue;
                        }
                        if (signal.aborted || stopping.current) break;
                        if (!pick) {
                            skipped.clear();
                            setStatus(
                                'No eligible live quote at this stake. Retrying. Session P/L ' + net + ' ' + currency
                            );
                            await waitWithCountdown(10000);
                            continue;
                        }
                        const repeatQuotes = new Map<number, RankedQuote>();
                        for (const [rank, trade] of winners) {
                            const quote = compared.find(item => rankedTradeKey(item.trade) === rankedTradeKey(trade));
                            if (quote) repeatQuotes.set(rank, quote);
                        }
                        const repeatSet = new Set(repeatQuotes.values());
                        reserves = (compared.length ? compared : [pick]).filter(quote => !repeatSet.has(quote));
                        topQuotes = rankSelections.all.flatMap(rank => {
                            const quote = repeatQuotes.get(rank) ?? reserves.shift();
                            return quote ? [{ rank, quote }] : [];
                        });
                    }
                    const eligible = topQuotes.filter(
                        ({ rank, quote }) => rankSelections[rankSelection].includes(rank) && matchesFilter(quote)
                    );
                    if (!eligible.length) {
                        setRankings(topQuotes);
                        topQuotes = [];
                        rounds = 0;
                        skipped.clear();
                        setStatus(localize('No contract in the selected ranks meets your filters. Checking again.'));
                        await waitWithCountdown(10000);
                        continue;
                    }
                    const roundStake = Math.min(amount, floorStake(remaining / eligible.length));
                    if (roundStake <= 0) break;
                    for (const slot of topQuotes) {
                        const { quote } = slot;
                        if (quote.trade.stake === roundStake) continue;
                        const payout = round((quote.trade.payout / quote.trade.stake) * roundStake);
                        slot.quote = {
                            ...quote,
                            trade: { ...quote.trade, stake: roundStake, payout },
                            expectedPayout: quote.rate * payout,
                        };
                    }
                    setRankings(topQuotes.map(slot => ({ ...slot })));
                    let batch = eligible.map(({ quote }) => quote);
                    setStatus(
                        localize('Preparing quotes for round {{round}} of {{total}}.', {
                            round: String(rounds + 1),
                            total: String(ROUNDS_PER_ANALYSIS),
                        })
                    );
                    if (mode === 'semi-automatic') {
                        const batchSize = batch.length;
                        setReview({ quotes: batch, batchSize });
                        const session = { net: String(net), currency };
                        setStatus(
                            batchSize > 1
                                ? localize(
                                      'Choose one contract, buy the eligible batch, or skip. Session P/L {{net}} {{currency}}',
                                      session
                                  )
                                : localize('Choose one contract or skip. Session P/L {{net}} {{currency}}', session)
                        );
                        const decision = await new Promise<ReviewDecision | undefined>(resolve => {
                            const timer = setTimeout(() => resolve(undefined), 30000);
                            reviewDecision.current = value => {
                                clearTimeout(timer);
                                resolve(value);
                            };
                        });
                        reviewDecision.current = undefined;
                        if (signal.aborted || stopping.current) break;
                        setReview(undefined);
                        if (decision === null) {
                            batch.forEach(quote => skipped.add(rankedTradeKey(quote.trade)));
                            topQuotes = [];
                            rounds = 0;
                        }
                        if (!decision) continue;
                        if (decision === 'batch') {
                            if (batchSize < 2 || !batch.every(quote => fresh(quote.time))) continue;
                        } else {
                            if (!batch.includes(decision) || !fresh(decision.time)) continue;
                            batch = [decision];
                        }
                    }
                    const open = new Map<string, RankedQuote>();
                    let pending = 0;
                    let quoteTimedOut = false;
                    const saveOutstanding = () => {
                        if (open.size || pending) {
                            localStorage.setItem(
                                key,
                                JSON.stringify([...open.keys(), ...(pending ? ['pending'] : [])])
                            );
                        } else {
                            localStorage.removeItem(key);
                        }
                    };
                    const purchases = await Promise.allSettled(
                        batch.map(async quote => {
                            let submitted = false;
                            const beforeBuy = () => {
                                    if (signal.aborted || stopping.current || latest.current.block)
                                        throw new Error('Trading conditions changed before purchase.');
                                    if (!fresh(quote.time))
                                        throw new InsightQuoteChanged(
                                            'The comparison expired. Checking live contracts again.',
                                            quote.trade.payout
                                        );
                                    localStorage.setItem(key, JSON.stringify([...open.keys(), 'pending']));
                                    pending++;
                                    submitted = true;
                            };
                            const id = await latest.current
                                .buy(quote.trade, signal, beforeBuy, mode === 'automatic')
                                .catch(error => {
                                    if (!submitted && error instanceof InsightQuoteChanged && fresh(quote.time)) {
                                        const slot = topQuotes.find(item => item.quote === quote);
                                        if (slot) {
                                            slot.quote = {
                                                ...quote,
                                                trade: { ...quote.trade, payout: error.payout },
                                                expectedPayout: quote.rate * error.payout,
                                            };
                                        }
                                    }
                                    if (!submitted && error instanceof InsightRequestTimeout) {
                                        quoteTimedOut = true;
                                        return undefined;
                                    }
                                    if (submitted && error instanceof InsightRateLimitError) {
                                        pending--;
                                        saveOutstanding();
                                    }
                                    throw error;
                                });
                            if (id === undefined) return;
                            open.set(id, quote);
                            pending--;
                            saveOutstanding();
                        })
                    );
                    const rateLimited = purchases.some(
                        result => result.status === 'rejected' && result.reason instanceof InsightRateLimitError
                    );
                    const failure = purchases.find(
                        result =>
                            result.status === 'rejected' &&
                            !(result.reason instanceof InsightQuoteChanged) &&
                            !(result.reason instanceof InsightRateLimitError)
                    );
                    const purchased = open.size > 0;
                    if (purchased) {
                        skipped.clear();
                        setStatus(
                            open.size === 1
                                ? localize('Awaiting settlement for 1 contract.')
                                : localize('Awaiting settlement for {{count}} contracts.', { count: String(open.size) })
                        );
                    } else if (!failure && !rateLimited && !quoteTimedOut && !signal.aborted && !stopping.current) {
                        setStatus(localize('Quote changed. Refreshing the selected quotes.'));
                        await waitWithCountdown(REQUEST_SPACING_MS);
                    }
                    let batchProfit = 0;
                    const nextWinners = new Map<number, TInsightTrade>();
                    const losingRanks: number[] = [];
                    while (open.size && !signal.aborted) {
                        const settlementCooldown = getInsightCooldown();
                        if (settlementCooldown > 0) {
                            setStatus(localize('Deriv is limiting requests. Waiting to check open contracts.'));
                            await waitWithCountdown(settlementCooldown, true);
                            continue;
                        }
                        for (const [id, quote] of open) {
                            if (signal.aborted) break;
                            const response = await sendInsightRequest<{
                                error?: { message: string };
                                proposal_open_contract?: { contract_id: number; is_sold: number; profit: number };
                            }>(
                                payload => waitForInsightRequest(ws.send(payload), 'Settlement request timed out.'),
                                { proposal_open_contract: 1, contract_id: Number(id) },
                                signal
                            ).catch(async error => {
                                if (error instanceof InsightRequestTimeout) {
                                    await retryAfterTimeout(
                                        localize('Settlement check timed out. Retrying the open contract check.'),
                                        true
                                    );
                                    return undefined;
                                }
                                if (!(error instanceof InsightRateLimitError)) throw error;
                                return undefined;
                            });
                            if (!response) break;
                            timeoutRetryMs = INITIAL_TIMEOUT_RETRY_MS;
                            const position = response?.proposal_open_contract;
                            if (response?.error) throw new Error(response.error.message);
                            if (position && String(position.contract_id) === id && Number(position.is_sold) === 1) {
                                if (position.profit == null || !Number.isFinite(Number(position.profit)))
                                    throw new Error('Invalid settlement amount.');
                                const profit = Number(position.profit);
                                batchProfit = round(batchProfit + profit);
                                const rank = topQuotes.find(slot => slot.quote === quote)?.rank;
                                if (profit > 0 && rank !== undefined) nextWinners.set(rank, quote.trade);
                                if (profit < 0 && rank !== undefined) losingRanks.push(rank);
                                open.delete(id);
                                saveOutstanding();
                            }
                        }
                        if (open.size && !signal.aborted && getInsightCooldown() === 0) {
                            await waitWithCountdown(750, true);
                        }
                    }
                    if (failure?.status === 'rejected' && (pending || !stopping.current)) throw failure.reason;
                    if (purchased && !signal.aborted) {
                        net = round(net + batchProfit);
                        winners = nextWinners;
                        amount = method === 'martingale' && batchProfit < 0 ? round(roundStake * 2) : stake;
                        rounds++;
                        if (alternateLosers && rounds < ROUNDS_PER_ANALYSIS) {
                            for (const rank of losingRanks) {
                                const replacement = reserves.findIndex(quote => fresh(quote.time) && matchesFilter(quote));
                                const slot = topQuotes.find(item => item.rank === rank);
                                if (slot && replacement >= 0) [slot.quote] = reserves.splice(replacement, 1);
                            }
                        }
                        nextRoundAt =
                            performance.now() +
                            (rounds === ROUNDS_PER_ANALYSIS ? ANALYSIS_COOLDOWN_MS : ROUND_SPACING_MS);
                    }
                    if (rateLimited && !signal.aborted && !stopping.current) {
                        setStatus(localize('Deriv is limiting quotes. Retrying when the limit clears.'));
                        await waitWithCountdown(Math.max(getInsightCooldown(), REQUEST_SPACING_MS));
                    } else if (quoteTimedOut && !signal.aborted && !stopping.current && net < tp && net > -stopLimit) {
                        await retryAfterTimeout(localize('The quote request timed out. Retrying shortly.'));
                    }
                }
                if (!signal.aborted) setStatus('Run stopped. Session P/L ' + net + ' ' + currency);
            });
        } catch (error) {
            if (!signal.aborted)
                setStatus(error instanceof Error ? error.message : 'Run stopped. Check Positions and Reports.');
        } finally {
            current.current = undefined;
            if (!signal.aborted) {
                setReview(undefined);
                setRunning(false);
            }
        }
    };
    return (
        <section className='tick-insights__fields'>
            <p>
                {account} · Initial stake {stake} {currency}
            </p>
            <label>
                Stop loss ({currency}){' '}
                <input
                    type='number'
                    step='any'
                    value={loss}
                    disabled={running}
                    onChange={e => setLoss(e.target.value)}
                />
            </label>
            <label>
                Take profit ({currency}){' '}
                <input
                    type='number'
                    step='any'
                    value={target}
                    disabled={running}
                    onChange={e => setTarget(e.target.value)}
                />
            </label>
            <label>
                {localize('Strategy')}{' '}
                <select value={method} disabled={running} onChange={e => setMethod(e.target.value)}>
                    <option value='fixed'>{localize('Fixed stake')}</option>
                    <option value='martingale'>{localize('Martingale (2x after a loss)')}</option>
                </select>
            </label>
            <label>
                Execution mode{' '}
                <select value={mode} disabled={running} onChange={e => setMode(e.target.value)}>
                    <option value='automatic'>Automatic</option>
                    <option value='semi-automatic'>Semi-automatic</option>
                </select>
            </label>
            <label>
                {localize('Rank selection')}{' '}
                <select
                    disabled={running}
                    value={rankSelection}
                    onChange={e => setRankSelection(e.target.value as RankSelection)}
                >
                    <option value='all'>{localize('All three')}</option>
                    <option value='topTwo'>{localize('First two')}</option>
                    <option value='first'>{localize('First only')}</option>
                    <option value='second'>{localize('Second only')}</option>
                    <option value='third'>{localize('Third only')}</option>
                </select>
            </label>
            <label>
                <input
                    type='checkbox'
                    checked={alternateLosers}
                    disabled={running}
                    onChange={e => setAlternateLosers(e.target.checked)}
                />{' '}
                {localize('Replace losing contracts between rounds')}
            </label>
            {!excludeGroup && (
                <label>
                    {localize('Trade only')}{' '}
                    <select
                        disabled={running}
                        value={onlyGroup}
                        onChange={e => setOnlyGroup(e.target.value as RankedContractGroup | '')}
                    >
                        <option value=''>{localize('Any contract type')}</option>
                        {contractGroups.map(group => (
                            <option key={group} value={group}>
                                {contractGroupLabel(group)}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            {!onlyGroup && (
                <label>
                    {localize('Do not trade')}{' '}
                    <select
                        disabled={running}
                        value={excludeGroup}
                        onChange={e => setExcludeGroup(e.target.value as RankedContractGroup | '')}
                    >
                        <option value=''>{localize('No exclusions')}</option>
                        {contractGroups.map(group => (
                            <option key={group} value={group}>
                                {contractGroupLabel(group)}
                            </option>
                        ))}
                    </select>
                </label>
            )}
            <button
                type='button'
                disabled={!running && !!block}
                onClick={() => {
                    if (running) {
                        stopping.current = true;
                        cancelCooldown.current?.();
                        reviewDecision.current?.();
                        setReview(undefined);
                        setStatus('Stopping after any open contract settles.');
                    } else void start();
                }}
            >
                {running ? 'Stop run' : 'Start trading'}
            </button>
            <p role='status'>{block || status}</p>
            {cooldownSeconds !== undefined && (
                <p role='timer'>{localize('Next request in {{seconds}} s', { seconds: String(cooldownSeconds) })}</p>
            )}
            <section className='tick-insights__rankings'>
                <h3>{localize('Top 3 contracts')}</h3>
                {rankings?.length ? (
                    <p>
                        {localize('Stake per contract')} {rankings[0].quote.trade.stake} {currency}
                    </p>
                ) : null}
                {rankings?.length ? (
                    <div className='tick-insights__table'>
                        <table>
                            <thead>
                                <tr>
                                    <th scope='col'>{localize('Rank')}</th>
                                    <th scope='col'>{localize('Contract')}</th>
                                    <th scope='col'>{localize('Historical win probability')}</th>
                                    <th scope='col'>{localize('Expected payout')}</th>
                                    {review && <th scope='col'>{localize('Quoted payout')}</th>}
                                    {review && <th scope='col'>{localize('Trade actions')}</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {rankings.map(({ rank, quote }) => {
                                    const { trade, rate, expectedPayout } = quote;
                                    const contract = `${trade.symbol} · ${candidateLabel(trade.candidate)} · ${trade.ticks} ${localize('ticks')}`;
                                    return (
                                        <tr key={rankedTradeKey(trade)}>
                                            <td>{rank + 1}</td>
                                            <th scope='row'>{contract}</th>
                                            <td>
                                                {rate.toLocaleString(undefined, {
                                                    style: 'percent',
                                                    maximumFractionDigits: 1,
                                                })}
                                            </td>
                                            <td>
                                                {expectedPayout.toFixed(getDecimalPlaces(currency))} {currency}
                                            </td>
                                            {review && (
                                                <td>
                                                    {trade.payout.toFixed(getDecimalPlaces(currency))} {currency}
                                                </td>
                                            )}
                                            {review && (
                                                <td>
                                                    {review.quotes.includes(quote) && (
                                                        <button
                                                            type='button'
                                                            disabled={!!block}
                                                            aria-label={localize('Buy {{contract}}', { contract })}
                                                            onClick={() => reviewDecision.current?.(quote)}
                                                        >
                                                            {localize('Buy')}
                                                        </button>
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                ) : rankings ? (
                    <p>{localize('No live quotes to compare.')}</p>
                ) : null}
                {review && review.batchSize > 1 && (
                    <button type='button' disabled={!!block} onClick={() => reviewDecision.current?.('batch')}>
                        {review.batchSize === 3 ? localize('Buy all 3') : localize('Buy both')}
                    </button>
                )}
                {review && (
                    <button type='button' onClick={() => reviewDecision.current?.(null)}>
                        {localize('Skip')}
                    </button>
                )}
            </section>
            {!running && status && localStorage.getItem(key) && (
                <button
                    type='button'
                    onClick={() => {
                        localStorage.removeItem(key);
                        setStatus('Previous purchase reviewed. Ready for a new session.');
                    }}
                >
                    I reviewed the previous purchases and confirmed none are open
                </button>
            )}
        </section>
    );
}
