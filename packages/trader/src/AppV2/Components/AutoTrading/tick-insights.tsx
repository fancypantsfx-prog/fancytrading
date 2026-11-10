import React from 'react';
import { fetchPremiumAccess } from '@deriv/api';
import type { TPremiumAccess } from '@deriv/api';
import { getDecimalPlaces, getPlatformLogo, useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { compareRecentTicks, getInsightContract } from './tick-insights-data';
import type { TFamily, TInsightRun, TTickInsights } from './tick-insights-data';
import './tick-insights.scss';

const percent = (value: number) => value.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 1 });
const hitRate = ({ hits, count }: { hits: number; count: number }) => hits / count;
const candidateLabel = (candidate: string) =>
    ({
        CALL: localize('Rise'),
        PUT: localize('Fall'),
        DIGITEVEN: localize('Digit Even'),
        DIGITODD: localize('Digit Odd'),
    })[candidate] ?? localize('{{rate}}% growth', { rate: candidate });

type TInsightRow = TTickInsights['rows'][number];

const formatMoney = (value: number, currency: string) =>
    value.toLocaleString(undefined, { style: 'currency', currency });

const InsightsResults = ({
    report,
    onReview,
    canReview,
}: {
    report: TTickInsights;
    onReview: (row: TInsightRow) => void;
    canReview: (row: TInsightRow) => boolean;
}) => {
    const [minimum_payout, setMinimumPayout] = React.useState('');
    const [sort_by_payout, setSortByPayout] = React.useState(false);
    const money = (value: number) => formatMoney(value, report.currency);
    const rows = report.rows.filter(row => row.payout >= Number(minimum_payout || 0));
    if (sort_by_payout) rows.sort((a, b) => b.payout - a.payout);

    if (!report.rows.length) {
        return (
            <p role='status'>
                {localize('No comparable quotes are available. Try another trade type, stake or tick target.')}
            </p>
        );
    }

    return (
        <div className='tick-insights__results' aria-live='polite'>
            <p>
                {localize('400 ticks ending at {{time}} · {{ticks}}-tick target', {
                    time: new Date(report.lastTick * 1000).toLocaleString(),
                    ticks: String(report.ticks),
                })}
            </p>
            <div className='tick-insights__fields'>
                <label>
                    {localize('Minimum total payout')} ({report.currency})
                    <input
                        type='number'
                        min='0'
                        step='any'
                        value={minimum_payout}
                        onChange={e => setMinimumPayout(e.target.value)}
                    />
                </label>
                <label>
                    {localize('Sort by')}
                    <select
                        value={sort_by_payout ? 'payout' : 'rate'}
                        onChange={e => setSortByPayout(e.target.value === 'payout')}
                    >
                        <option value='rate'>{localize('Historical hit rate')}</option>
                        <option value='payout'>{localize('Total payout')}</option>
                    </select>
                </label>
            </div>
            {!rows.length ? (
                <p role='status'>{localize('No available quotes meet that payout target.')}</p>
            ) : (
                <div
                    className='tick-insights__table'
                    tabIndex={0}
                    role='region'
                    aria-label={localize('Trade comparison')}
                >
                    <table>
                        <thead>
                            <tr>
                                <th scope='col'>{localize('Trade')}</th>
                                <th scope='col'>{localize('Historical hit rate')}</th>
                                <th scope='col'>{localize('Older / recent')}</th>
                                <th scope='col'>{localize('Total payout')}</th>
                                <th scope='col'>{localize('Stake / profit if successful')}</th>
                                <th scope='col'>{localize('Break-even hit rate')}</th>
                                <th scope='col'>{localize('Automatic')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => (
                                <tr key={row.candidate}>
                                    <th scope='row'>{candidateLabel(row.candidate)}</th>
                                    <td>
                                        <strong>{percent(hitRate(row.historical))}</strong>
                                        <small>
                                            {row.historical.hits}/{row.historical.count}
                                        </small>
                                    </td>
                                    <td>
                                        {percent(hitRate(row.older))} / {percent(hitRate(row.recent))}
                                    </td>
                                    <td>
                                        <strong>{money(row.payout)}</strong>
                                        {row.estimated && <small>{localize('Estimate')}</small>}
                                    </td>
                                    <td>
                                        {money(row.stake)} / {money(row.payout - row.stake)}
                                    </td>
                                    <td>{row.breakEven === undefined ? '—' : percent(row.breakEven)}</td>
                                    <td>
                                        <button
                                            type='button'
                                            disabled={!canReview(row)}
                                            aria-label={localize('Review {{trade}}', {
                                                trade: candidateLabel(row.candidate),
                                            })}
                                            onClick={() => onReview(row)}
                                        >
                                            {localize('Review trade')}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            <p className='tick-insights__note'>
                {localize(
                    'The 400 ticks are split into two 200-tick samples. Trials share no price moves within each sample. Compare both halves before relying on a high historical hit rate.'
                )}
            </p>
            <p className='tick-insights__note'>
                {localize(
                    report.rows.some(row => row.estimated)
                        ? 'Accumulator results replay the currently quoted range on past ticks. Payout estimates assume the full target stays in range. Actual ranges, settlement and payouts can differ.'
                        : 'Break-even is quoted stake divided by total payout for a full loss on unsuccessful trades. Quotes can change before entry.'
                )}
            </p>
        </div>
    );
};

type TProps = {
    symbol: string;
    currency: string;
    initial_stake: number;
    initial_ticks: number;
    is_accumulator: boolean;
    account_label: string;
    execution_block: string;
    supportsContract: (contract_type: string) => boolean;
    onStart: (draft: TInsightRun, signal: AbortSignal) => Promise<string>;
};

const InsightsPanel = ({
    symbol,
    currency,
    initial_stake,
    initial_ticks,
    is_accumulator,
    account_label,
    execution_block,
    supportsContract,
    onStart,
}: TProps) => {
    const ws = useWS();
    const [family, setFamily] = React.useState<TFamily>(is_accumulator ? 'accumulator' : 'digital');
    const [stake, setStake] = React.useState(String(initial_stake));
    const [stop_loss, setStopLoss] = React.useState('');
    const [take_profit, setTakeProfit] = React.useState('');
    const [draft, setDraft] = React.useState<TInsightRun>();
    const [run_id, setRunId] = React.useState('');
    const review_ref = React.useRef<HTMLElement>(null);
    const [ticks, setTicks] = React.useState(String(initial_ticks));
    const [access, setAccess] = React.useState<TPremiumAccess | 'checking' | 'error'>('checking');
    const [check, setCheck] = React.useState(0);
    const [report, setReport] = React.useState<TTickInsights>();
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const request = React.useRef<AbortController>();

    React.useEffect(() => {
        const controller = new AbortController();
        fetchPremiumAccess('tick-insights', controller.signal)
            .then(result => {
                if (!controller.signal.aborted) setAccess(result);
            })
            .catch(() => {
                if (!controller.signal.aborted) setAccess('error');
            });
        return () => controller.abort();
    }, [check]);

    React.useEffect(() => {
        if (typeof access === 'string' || !('expiresAt' in access)) return;
        const remaining = access.expiresAt * 1000 - Date.now();
        const timer = window.setTimeout(
            () => {
                request.current?.abort();
                setBusy(false);
                setReport(undefined);
                setDraft(undefined);
                setAccess('checking');
                setCheck(value => value + 1);
            },
            Math.max(0, Math.min(remaining, 2147483647))
        );
        return () => window.clearTimeout(timer);
    }, [access]);

    React.useEffect(() => () => request.current?.abort(), []);

    const compare = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (busy) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        setReport(undefined);
        const timeout = window.setTimeout(() => {
            if (!controller.signal.aborted) {
                controller.abort();
                setBusy(false);
                setError(localize('The comparison timed out. Try again.'));
            }
        }, 15000);
        try {
            const result = await compareRecentTicks(
                payload => ws.send(payload),
                { symbol, currency, family, stake: Number(stake), ticks: Number(ticks) },
                controller.signal
            );
            if (controller.signal.aborted) return;
            setAccess(result?.access ?? { access: 'locked' });
            setReport(result ?? undefined);
        } catch {
            if (!controller.signal.aborted) {
                setError(
                    localize('Could not load the 400-tick comparison. Check your market connection and try again.')
                );
            }
        } finally {
            window.clearTimeout(timeout);
            if (!controller.signal.aborted) setBusy(false);
        }
    };

    React.useEffect(() => {
        if (draft) review_ref.current?.focus();
    }, [draft]);

    const review = (row: TInsightRow) => {
        const stopLoss = Number(stop_loss);
        const takeProfit = take_profit === '' ? undefined : Number(take_profit);
        if (!Number.isFinite(stopLoss) || stopLoss < row.stake) {
            setError(localize('Enter a run stop loss at least as large as the quoted stake.'));
            return;
        }
        if (takeProfit !== undefined && (!Number.isFinite(takeProfit) || takeProfit <= 0)) {
            setError(localize('Enter a run take profit greater than zero.'));
            return;
        }
        const contractTakeProfit =
            family === 'accumulator' ? Number((row.payout - row.stake).toFixed(getDecimalPlaces(currency))) : undefined;
        if (contractTakeProfit !== undefined && contractTakeProfit <= 0) {
            setError(localize('This payout target rounds to zero profit. Increase the stake or tick target.'));
            return;
        }
        setError('');
        setDraft({
            candidate: row.candidate,
            family,
            ticks: Number(ticks),
            symbol,
            currency,
            stake: row.stake,
            payout: row.payout,
            stopLoss,
            takeProfit,
            contractTakeProfit,
        });
    };

    const confirm = async () => {
        if (!draft || busy || execution_block) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        try {
            const id = await onStart(draft, controller.signal);
            if (!controller.signal.aborted) setRunId(id);
        } catch (error) {
            if (!controller.signal.aborted) {
                setError(error instanceof Error ? error.message : localize('Could not confirm the automatic run.'));
            }
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
    };

    if (run_id) {
        return (
            <p role='status'>
                {localize('Automatic run {{id}} started. Open Automatic settings to monitor or stop it.', {
                    id: run_id,
                })}
            </p>
        );
    }
    if (access === 'checking') return <p role='status'>{localize('Checking access…')}</p>;
    if (access === 'error' || access.access === 'locked') {
        return (
            <>
                <p role='status'>
                    {access === 'error'
                        ? localize('FancyTrading insights are temporarily unavailable.')
                        : localize(
                              'FancyTrading insights are locked. Sign in with a Deriv account that has premium access, or return during a free preview.'
                          )}
                </p>
                <button
                    type='button'
                    onClick={() => {
                        setAccess('checking');
                        setCheck(value => value + 1);
                    }}
                >
                    {localize('Check access again')}
                </button>
            </>
        );
    }

    if (draft) {
        const money = (value: number) => formatMoney(value, draft.currency);
        return (
            <section
                ref={review_ref}
                tabIndex={-1}
                className='tick-insights__review'
                aria-label={localize('Review automatic run')}
            >
                <h3>{localize('Review automatic run')}</h3>
                <dl>
                    <dt>{localize('Account')}</dt>
                    <dd>{account_label}</dd>
                    <dt>{localize('Market and contract')}</dt>
                    <dd>
                        {symbol} · {candidateLabel(draft.candidate)}
                    </dd>
                    <dt>{localize('Stake per contract')}</dt>
                    <dd>{money(draft.stake)}</dd>
                    <dt>{localize('Run stop loss')}</dt>
                    <dd>{money(draft.stopLoss)}</dd>
                    {draft.takeProfit !== undefined && (
                        <>
                            <dt>{localize('Run take profit')}</dt>
                            <dd>{money(draft.takeProfit)}</dd>
                        </>
                    )}
                    {draft.contractTakeProfit === undefined ? (
                        <>
                            <dt>{localize('Duration')}</dt>
                            <dd>{localize('{{ticks}} ticks', { ticks: String(draft.ticks) })}</dd>
                        </>
                    ) : (
                        <>
                            <dt>{localize('Take profit per contract')}</dt>
                            <dd>{money(draft.contractTakeProfit)}</dd>
                        </>
                    )}
                    <dt>
                        {draft.contractTakeProfit === undefined
                            ? localize('Quoted payout')
                            : localize('Estimated payout')}
                    </dt>
                    <dd>
                        {money(
                            draft.contractTakeProfit === undefined
                                ? draft.payout
                                : draft.stake + draft.contractTakeProfit
                        )}
                    </dd>
                </dl>
                <p>
                    {localize(
                        'The run uses a fixed stake. The stop loss stops new purchases when the run reaches the loss threshold. Open contracts can still settle and increase the loss.'
                    )}
                </p>
                <p>{localize('Pricing can change between review and execution.')}</p>
                {error && <p role='alert'>{error}</p>}
                {!busy && execution_block && <p role='status'>{execution_block}</p>}
                <div className='tick-insights__actions'>
                    <button
                        type='button'
                        disabled={busy}
                        onClick={() => {
                            setDraft(undefined);
                            setError('');
                        }}
                    >
                        {localize('Back to comparison')}
                    </button>
                    <button type='button' disabled={busy || !!execution_block} onClick={() => void confirm()}>
                        {busy ? localize('Starting…') : localize('Confirm and start run')}
                    </button>
                </div>
            </section>
        );
    }

    return (
        <>
            <p className='tick-insights__badge'>
                {access.access === 'paid'
                    ? localize('Premium access')
                    : access.access === 'preview'
                      ? localize('Free preview')
                      : localize('Free launch access')}
            </p>
            <p>
                {localize(
                    'Compare historical outcomes and current payout quotes for {{symbol}} before setting up an automatic run.',
                    { symbol }
                )}
            </p>
            <form onSubmit={compare} className='tick-insights__fields'>
                <label>
                    {localize('Compare')}
                    <select
                        value={family}
                        onChange={e => {
                            setFamily(e.target.value as TFamily);
                            setReport(undefined);
                        }}
                        disabled={busy}
                    >
                        <option value='accumulator'>{localize('Accumulator growth rates')}</option>
                        <option value='digital'>{localize('Rise / Fall and Even / Odd')}</option>
                    </select>
                </label>
                <label>
                    {localize('Stake per contract')} ({currency})
                    <input
                        type='number'
                        required
                        min='0.01'
                        max='1000000'
                        step='any'
                        value={stake}
                        disabled={busy}
                        onChange={e => {
                            setStake(e.target.value);
                            setReport(undefined);
                        }}
                    />
                </label>
                <label>
                    {localize('Run stop loss')} ({currency})
                    <input
                        type='number'
                        min='0.01'
                        step='any'
                        value={stop_loss}
                        disabled={busy}
                        onChange={e => setStopLoss(e.target.value)}
                    />
                </label>
                <label>
                    {localize('Run take profit (if required)')} ({currency})
                    <input
                        type='number'
                        min='0.01'
                        step='any'
                        value={take_profit}
                        disabled={busy}
                        onChange={e => setTakeProfit(e.target.value)}
                    />
                </label>
                <label>
                    {localize('Tick target')}
                    <input
                        type='number'
                        required
                        min='1'
                        max='20'
                        step='1'
                        value={ticks}
                        disabled={busy}
                        onChange={e => {
                            setTicks(e.target.value);
                            setReport(undefined);
                        }}
                    />
                </label>
                <button type='submit' disabled={busy}>
                    {busy ? localize('Comparing…') : localize('Compare trades')}
                </button>
            </form>
            {error && <p role='alert'>{error}</p>}
            {report && (
                <>
                    {execution_block && <p role='status'>{execution_block}</p>}
                    <InsightsResults
                        report={report}
                        onReview={review}
                        canReview={row =>
                            !execution_block &&
                            supportsContract(getInsightContract(family, row.candidate, report.ticks).contract_type)
                        }
                    />
                </>
            )}
            <p className='tick-insights__note'>
                {localize(
                    'Historical hit rates describe past ticks. Review the account, contract and run limits before confirming an automatic run.'
                )}
            </p>
        </>
    );
};

const TickInsights = (props: TProps) => {
    const dialog = React.useRef<HTMLDialogElement>(null);
    const title = React.useId();
    const [open, setOpen] = React.useState(false);

    return (
        <div className='tick-insights'>
            <button
                type='button'
                className='tick-insights__trigger'
                aria-haspopup='dialog'
                disabled={!props.symbol}
                onClick={() => {
                    dialog.current?.showModal();
                    setOpen(true);
                }}
            >
                FancyTrading
            </button>
            <dialog
                ref={dialog}
                className='tick-insights__dialog'
                aria-labelledby={title}
                onClose={() => setOpen(false)}
                onTouchStart={event => event.stopPropagation()}
                onTouchEnd={event => event.stopPropagation()}
            >
                <header>
                    <div className='tick-insights__brand'>
                        <img src={'/' + getPlatformLogo()} alt='' width={40} height={40} />
                        <div>
                            <h2 id={title}>FancyTrading</h2>
                            <p>{localize('Insights by FancyPants')}</p>
                        </div>
                    </div>
                    <button
                        type='button'
                        onClick={() => dialog.current?.close()}
                        aria-label={localize('Close FancyTrading')}
                    >
                        ×
                    </button>
                </header>
                {open && <InsightsPanel {...props} />}
            </dialog>
        </div>
    );
};

export default TickInsights;
