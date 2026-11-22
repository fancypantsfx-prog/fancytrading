import React from 'react';
import { getDecimalPlaces, useWS } from '@deriv/shared';
import { fresh, selectRankedTrade } from './ranked-trade';
import { waitForInsightRequest } from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

type Props = {
    currency: string;
    stake: number;
    account: string;
    block: string;
    buy: (trade: TInsightTrade, signal: AbortSignal, beforeBuy: () => void) => Promise<string>;
};
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export default function RankedRunner({ currency, stake, account, block, buy }: Props) {
    const ws = useWS();
    const [loss, setLoss] = React.useState('');
    const [target, setTarget] = React.useState(String(3 * stake));
    const [method, setMethod] = React.useState('martingale');
    const [running, setRunning] = React.useState(false);
    const [status, setStatus] = React.useState('');
    const current = React.useRef<AbortController>();
    const stopping = React.useRef(false);
    const latest = React.useRef({ block, buy });
    latest.current = { block, buy };
    React.useEffect(() => () => current.current?.abort(), []);
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
                const round = (value: number) => Number(value.toFixed(getDecimalPlaces(currency)));
                while (!signal.aborted && !stopping.current) {
                    if (latest.current.block) throw new Error(latest.current.block);
                    if (net >= tp || round(net - amount) < -sl) break;
                    setStatus('Comparing live contracts. Session P/L ' + net + ' ' + currency);
                    const pick = await selectRankedTrade(ws.send, currency, amount, signal);
                    if (signal.aborted || stopping.current) break;
                    if (!pick) {
                        setStatus('Waiting for a qualifying contract. Session P/L ' + net + ' ' + currency);
                        await delay(10000);
                        continue;
                    }
                    const id = await latest.current.buy(pick.trade, signal, () => {
                        if (!fresh(pick.time) || signal.aborted || stopping.current || latest.current.block)
                            throw new Error('Trading conditions changed before purchase.');
                        localStorage.setItem(key, 'pending');
                    });
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
                        await delay(2000);
                    }
                }
                if (!signal.aborted) setStatus('Run stopped. Session P/L ' + net + ' ' + currency);
            });
        } catch (error) {
            if (!signal.aborted)
                setStatus(error instanceof Error ? error.message : 'Run stopped. Check Positions and Reports.');
        } finally {
            current.current = undefined;
            if (!signal.aborted) setRunning(false);
        }
    };
    return (
        <section className='tick-insights__fields'>
            <p>
                {account} · Initial stake {stake} {currency} · Keep the Trade tab open during the run.
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
            <button
                type='button'
                disabled={!running && !!block}
                onClick={() => {
                    if (running) {
                        stopping.current = true;
                        setStatus('Stopping after any open contract settles.');
                    } else void start();
                }}
            >
                {running ? 'Stop run' : 'Start trading'}
            </button>
            <p role='status'>{block || status}</p>
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
