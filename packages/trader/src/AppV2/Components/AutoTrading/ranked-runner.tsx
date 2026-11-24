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

export default function RankedRunner({ currency, symbol, stake, account, block, buy }: Props) {
    const ws = useWS();
    const [loss, setLoss] = React.useState('');
    const [target, setTarget] = React.useState(String(3 * stake));
    const [method, setMethod] = React.useState('martingale');
    const [mode, setMode] = React.useState('automatic');
    const [review, setReview] = React.useState<RankedQuote[]>();
    const reviewDecision = React.useRef<(decision?: RankedQuote | null) => void>();
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
                    if (mode === 'semi-automatic') {
                        setReview(topQuotes);
                        setStatus('Choose a contract or skip. Session P/L ' + net + ' ' + currency);
                        const decision = await new Promise<RankedQuote | null | undefined>(resolve => {
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
                        if (!decision || !fresh(decision.time)) continue;
                        pick = decision;
                    }
                    const selected = pick;
                    let id: string;
                    try {
                        id = await latest.current.buy(selected.trade, signal, () => {
                            if (signal.aborted || stopping.current || latest.current.block)
                                throw new Error('Trading conditions changed before purchase.');
                            if (!fresh(selected.time))
                                throw new InsightQuoteChanged(
                                    'The comparison expired. Checking live contracts again.',
                                    selected.trade.payout
                                );
                            localStorage.setItem(key, 'pending');
                        });
                    } catch (error) {
                        if (error instanceof InsightQuoteChanged) {
                            setStatus('Quote changed. Checking live contracts again.');
                            await delay(1000);
                            continue;
                        }
                        throw error;
                    }
                    skipped.clear();
                    localStorage.setItem(key, id);
                    setStatus(
                        pick.trade.symbol +
                            ' ' +
                            pick.trade.candidate +
                            ' · ' +
                            (100 * pick.rate).toFixed(1) +
                            '% historical wins · stake ' +
                            amount +
                            ' ' +
                            currency +
                            ' · awaiting settlement'
                    );
                    while (!signal.aborted) {
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
                            const profit = Number(position.profit);
                            net = round(net + profit);
                            amount = method === 'martingale' && profit < 0 ? round(amount * 2) : stake;
                            localStorage.removeItem(key);
                            break;
                        }
                        await delay(750);
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
                {review?.length ? (
                    <p>
                        {localize('Stake per contract')} {review[0].trade.stake} {currency}
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
                    I checked the previous purchase and confirmed it is settled
                </button>
            )}
        </section>
    );
}
