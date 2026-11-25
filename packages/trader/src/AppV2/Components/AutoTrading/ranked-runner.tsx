import React from 'react';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { candidateLabel } from './insights-compare';
import type { RankedQuote } from './ranked-trade';
import { fresh, rankedTradeKey, selectRankedTrade } from './ranked-trade';
import { InsightQuoteChanged, InsightRateLimitError, waitForInsightRequest } from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

type Props = {
    currency: string;
    symbol?: string;
    stake: number;
    account: string;
    block: string;
    buy: (trade: TInsightTrade, signal: AbortSignal, beforeBuy: () => void) => Promise<string>;
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type ReviewDecision = RankedQuote | 'all' | null;

export default function RankedRunner({ currency, symbol, stake, account, block, buy }: Props) {
    const ws = useWS();
    const [loss, setLoss] = React.useState('');
    const [target, setTarget] = React.useState(String(3 * stake));
    const [method, setMethod] = React.useState('martingale');
    const [mode, setMode] = React.useState('automatic');
    const [review, setReview] = React.useState<{ quotes: RankedQuote[]; canBuyAll: boolean }>();
    const reviewDecision = React.useRef<(decision?: ReviewDecision) => void>();
    const [rankings, setRankings] = React.useState<RankedQuote[]>();
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState('');
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
        if (!(stake > 0 && Number.isFinite(sl) && sl >= stake && Number.isFinite(tp) && tp > 0)) {
            setStatus('Enter a positive take profit and a stop loss covering at least the initial stake.');
            return;
        }
        const controller = new AbortController();
        const { signal } = controller;
        current.current = controller;
        stopping.current = false;
        setRankings(undefined);
        setRunning(true);
        try {
            await navigator.locks.request(key, { ifAvailable: true }, async lock => {
                if (!lock) throw new Error('A ranked run is active in another tab.');
                if (localStorage.getItem(key))
                    throw new Error(
                        'Review the previous purchase in Positions and Reports before starting another run.'
                    );
                let net = 0,
                    amount = stake;
                const skipped = new Set<string>();
                const round = (value: number) => Number(value.toFixed(getDecimalPlaces(currency)));
                while (!signal.aborted && !stopping.current) {
                    if (latest.current.block) throw new Error(latest.current.block);
                    if (net >= tp || round(net - amount) < -sl) break;
                    setStatus('Comparing live contracts. Session P/L ' + net + ' ' + currency);
                    let pick: RankedQuote | undefined;
                    let topQuotes: RankedQuote[] = [];
                    try {
                        pick = await selectRankedTrade(
                            ws.send,
                            currency,
                            amount,
                            signal,
                            skipped,
                            quotes => {
                                topQuotes = quotes.slice(0, 3);
                                setRankings(topQuotes);
                            },
                            symbol
                        );
                    } catch (error) {
                        if (!(error instanceof InsightRateLimitError)) throw error;
                        setStatus('Deriv is limiting quotes. Retrying when the limit clears.');
                        await delay(10000);
                        continue;
                    }
                    if (signal.aborted || stopping.current) break;
                    if (!pick) {
                        skipped.clear();
                        setStatus(
                            'No eligible live quote at this stake. Retrying. Session P/L ' + net + ' ' + currency
                        );
                        await delay(10000);
                        continue;
                    }
                    const batchStake = topQuotes.reduce((total, quote) => total + quote.trade.stake, 0);
                    const canBuyAll = topQuotes.length === 3 && round(net - batchStake) >= -sl;
                    let batch = canBuyAll ? topQuotes : [pick];
                    if (mode === 'semi-automatic') {
                        setReview({ quotes: topQuotes, canBuyAll });
                        setStatus(
                            (canBuyAll ? 'Choose a contract, buy all 3, or skip.' : 'Choose a contract or skip.') +
                                ' Session P/L ' + net + ' ' + currency
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
                        if (decision === null) topQuotes.forEach(quote => skipped.add(rankedTradeKey(quote.trade)));
                        if (!decision) continue;
                        if (decision === 'all') {
                            if (!canBuyAll || !topQuotes.every(quote => fresh(quote.time))) continue;
                        } else {
                            if (!fresh(decision.time)) continue;
                            batch = [decision];
                        }
                    }
                    const open = new Set<string>();
                    let pending = 0;
                    const saveOutstanding = () => {
                        if (open.size || pending) {
                            localStorage.setItem(key, JSON.stringify([...open, ...(pending ? ['pending'] : [])]));
                        } else {
                            localStorage.removeItem(key);
                        }
                    };
                    const purchases = await Promise.allSettled(
                        batch.map(async quote => {
                            const id = await latest.current.buy(quote.trade, signal, () => {
                                if (signal.aborted || stopping.current || latest.current.block)
                                    throw new Error('Trading conditions changed before purchase.');
                                if (!fresh(quote.time))
                                    throw new InsightQuoteChanged(
                                        'The comparison expired. Checking live contracts again.',
                                        quote.trade.payout
                                    );
                                localStorage.setItem(key, JSON.stringify([...open, 'pending']));
                                pending++;
                            });
                            open.add(id);
                            pending--;
                            saveOutstanding();
                        })
                    );
                    const failure = purchases.find(
                        result => result.status === 'rejected' && !(result.reason instanceof InsightQuoteChanged)
                    );
                    const purchased = open.size > 0;
                    if (purchased) {
                        skipped.clear();
                        setStatus(
                            open.size === 1
                                ? localize('Awaiting settlement for 1 contract.')
                                : localize('Awaiting settlement for {{count}} contracts.', { count: String(open.size) })
                        );
                    } else if (!failure && !signal.aborted && !stopping.current) {
                        setStatus('Quote changed. Checking live contracts again.');
                        await delay(1000);
                    }
                    let batchProfit = 0;
                    while (open.size && !signal.aborted) {
                        for (const id of open) {
                            if (signal.aborted) break;
                            const response = await waitForInsightRequest<{
                                error?: { message: string };
                                proposal_open_contract?: { contract_id: number; is_sold: number; profit: number };
                            }>(
                                ws.send({ proposal_open_contract: 1, contract_id: Number(id) }),
                                'Settlement request timed out.'
                            );
                            const position = response?.proposal_open_contract;
                            if (response?.error) throw new Error(response.error.message);
                            if (position && String(position.contract_id) === id && Number(position.is_sold) === 1) {
                                if (position.profit == null || !Number.isFinite(Number(position.profit)))
                                    throw new Error('Invalid settlement amount.');
                                batchProfit = round(batchProfit + Number(position.profit));
                                open.delete(id);
                                saveOutstanding();
                            }
                        }
                        if (open.size && !signal.aborted) await delay(750);
                    }
                    if (failure?.status === 'rejected' && (pending || !stopping.current)) throw failure.reason;
                    if (purchased && !signal.aborted) {
                        net = round(net + batchProfit);
                        amount = method === 'martingale' && batchProfit < 0 ? round(amount * 2) : stake;
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
                Strategy{' '}
                <select value={method} disabled={running} onChange={e => setMethod(e.target.value)}>
                    <option value='martingale'>Martingale (2× after a loss)</option>
                    <option value='fixed'>Fixed stake</option>
                </select>
            </label>
            <label>
                Execution mode{' '}
                <select value={mode} disabled={running} onChange={e => setMode(e.target.value)}>
                    <option value='automatic'>Automatic</option>
                    <option value='semi-automatic'>Semi-automatic</option>
                </select>
            </label>
            <button
                type='button'
                disabled={!running && !!block}
                onClick={() => {
                    if (running) {
                        stopping.current = true;
                        reviewDecision.current?.();
                        setReview(undefined);
                        setStatus('Stopping after any open contract settles.');
                    } else void start();
                }}
            >
                {running ? 'Stop run' : 'Start trading'}
            </button>
            <p role='status'>{block || status}</p>
            <section className='tick-insights__rankings'>
                <h3>{localize('Top 3 contracts')}</h3>
                {review?.quotes.length ? (
                    <p>
                        {localize('Stake per contract')} {review.quotes[0].trade.stake} {currency}
                    </p>
                ) : null}
                {rankings?.length ? (
                    <div className='tick-insights__table'>
                        <table>
                            <thead>
                                <tr>
                                    <th scope='col'>{localize('Contract')}</th>
                                    <th scope='col'>{localize('Historical win probability')}</th>
                                    <th scope='col'>{localize('Expected payout')}</th>
                                    {review && <th scope='col'>{localize('Quoted payout')}</th>}
                                    {review && <th scope='col'>{localize('Trade actions')}</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {rankings.map(quote => {
                                    const { trade, rate, expectedPayout } = quote;
                                    const contract = `${trade.symbol} · ${candidateLabel(trade.candidate)} · ${trade.ticks} ${localize('ticks')}`;
                                    return (
                                        <tr key={rankedTradeKey(trade)}>
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
                                                    <button
                                                        type='button'
                                                        disabled={!!block}
                                                        aria-label={localize('Buy {{contract}}', { contract })}
                                                        onClick={() => reviewDecision.current?.(quote)}
                                                    >
                                                        {localize('Buy')}
                                                    </button>
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
                {review?.canBuyAll && (
                    <button type='button' disabled={!!block} onClick={() => reviewDecision.current?.('all')}>
                        {localize('Buy all 3')}
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
