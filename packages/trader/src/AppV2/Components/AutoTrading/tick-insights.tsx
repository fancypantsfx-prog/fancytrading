import React from 'react';
import { fetchPremiumAccess } from '@deriv/api';
import type { TPremiumAccess } from '@deriv/api';
import { useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { compareRecentTicks } from './tick-insights-data';
import type { TFamily, TTickInsights } from './tick-insights-data';
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

const InsightsResults = ({ report }: { report: TTickInsights }) => {
    const [minimum_payout, setMinimumPayout] = React.useState('');
    const [sort_by_payout, setSortByPayout] = React.useState(false);
    const formatMoney = (value: number) =>
        value.toLocaleString(undefined, { style: 'currency', currency: report.currency });
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
                                        <strong>{formatMoney(row.payout)}</strong>
                                        {row.estimated && <small>{localize('Estimate')}</small>}
                                    </td>
                                    <td>
                                        {formatMoney(row.stake)} / {formatMoney(row.payout - row.stake)}
                                    </td>
                                    <td>{row.breakEven === undefined ? '—' : percent(row.breakEven)}</td>
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
};

const InsightsPanel = ({ symbol, currency, initial_stake, initial_ticks, is_accumulator }: TProps) => {
    const ws = useWS();
    const [family, setFamily] = React.useState<TFamily>(is_accumulator ? 'accumulator' : 'digital');
    const [stake, setStake] = React.useState(String(initial_stake));
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

    if (access === 'checking') return <p role='status'>{localize('Checking access…')}</p>;
    if (access === 'error' || access.access === 'locked') {
        return (
            <>
                <p role='status'>
                    {access === 'error'
                        ? localize('Trade Insights is temporarily unavailable.')
                        : localize(
                              'Trade Insights is locked. Sign in with a Deriv account that has premium access, or return during a free preview.'
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
                    {localize('Stake')} ({currency})
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
            {report && <InsightsResults report={report} />}
            <p className='tick-insights__note'>
                {localize(
                    'Historical hit rates do not predict the next trade or establish a profitable strategy. This comparison does not change your automatic settings or place trades.'
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
                {localize('400-Tick Trade Insights')}
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
                    <h2 id={title}>{localize('400-Tick Trade Insights')}</h2>
                    <button
                        type='button'
                        onClick={() => dialog.current?.close()}
                        aria-label={localize('Close Trade Insights')}
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
