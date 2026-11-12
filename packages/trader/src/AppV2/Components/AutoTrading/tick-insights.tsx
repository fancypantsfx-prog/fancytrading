import React from 'react';
import { createPortal } from 'react-dom';
import { fetchPremiumAccess } from '@deriv/api';
import type { TPremiumAccess } from '@deriv/api';
import { getDecimalPlaces, getPlatformLogo, useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { FancyTradingDialogContext } from './fancy-trading-dialog-context';
import {
    compareInsightMarkets,
    getInsightContract,
    getInsightMarkets,
    getInsightPreset,
    isInsightPresetValid,
    waitForInsightRequest,
} from './tick-insights-data';
import type { TFamily, TInsightRun, TInsightStrategyOption, TInsightTrade, TTickInsights } from './tick-insights-data';
import InsightsCompare, { candidateLabel } from './insights-compare';
import type { TCompareSetup } from './insights-compare';
import './tick-insights.scss';

const percent = (value: number) => value.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 1 });
const hitRate = ({ hits, count }: { hits: number; count: number }) => hits / count;
type TInsightRow = TTickInsights['rows'][number];

const formatMoney = (value: number, currency: string) =>
    value.toLocaleString(undefined, { style: 'currency', currency });

const InsightsResults = ({
    report,
    onReview,
    canReview,
    canBuy,
    onStar,
    isStarred,
    canStar,
}: {
    report: TTickInsights;
    onReview: (row: TInsightRow, automatic: boolean) => void;
    canReview: (row: TInsightRow) => boolean;
    canBuy: boolean;
    onStar: (row: TInsightRow) => void;
    isStarred: (row: TInsightRow) => boolean;
    canStar: boolean;
}) => {
    const [minimum_payout, setMinimumPayout] = React.useState('');
    const [metric, setMetric] = React.useState('rate');
    const money = (value: number) => formatMoney(value, report.currency);
    const rows = report.rows.filter(row => row.payout >= Number(minimum_payout || 0));
    const score = (row: TInsightRow) => {
        switch (metric) {
            case 'net':
                return row.estimatedNet ?? -Infinity;
            case 'return':
                return row.returnOnStake ?? -Infinity;
            case 'wins':
                return row.maxWins ?? -Infinity;
            case 'losses':
                return row.maxLosses === undefined ? -Infinity : -row.maxLosses;
            case 'payout':
                return row.payout;
            default:
                return hitRate(row.historical);
        }
    };
    rows.sort(
        (a, b) =>
            score(b) - score(a) ||
            (a.symbol ?? '').localeCompare(b.symbol ?? '') ||
            a.candidate.localeCompare(b.candidate)
    );

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
                {localize('Latest 400 ticks per instrument · {{ticks}}-tick target · Last sample {{time}}', {
                    time: new Date(report.lastTick * 1000).toLocaleString(),
                    ticks: String(report.ticks),
                })}
            </p>
            {!!report.marketsScanned && (
                <p>
                    {localize(
                        '{{count}} instruments checked. Results use each instrument’s latest tick sample and current quote.',
                        { count: String(report.marketsScanned) }
                    )}
                </p>
            )}
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
                    <select value={metric} onChange={e => setMetric(e.target.value)}>
                        <option value='rate'>{localize('Historical hit rate')}</option>
                        <option value='payout'>{localize('Total payout')}</option>
                        <option value='net'>{localize('Highest estimated net over the window')}</option>
                        <option value='return'>{localize('Highest return on total staked')}</option>
                        <option value='wins'>{localize('Most consecutive wins')}</option>
                        <option value='losses'>{localize('Fewest consecutive losses')}</option>
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
                                <th scope='col'>{localize('Total payout')}</th>
                                <th scope='col'>{localize('Stake / profit if successful')}</th>
                                <th scope='col'>{localize('Break-even hit rate')}</th>
                                <th scope='col'>{localize('Estimated net / return')}</th>
                                <th scope='col'>{localize('Max consecutive wins / losses')}</th>
                                <th scope='col'>{localize('Trade actions')}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(row => (
                                <tr key={`${row.symbol ?? ''}:${row.candidate}`}>
                                    <th scope='row'>
                                        {candidateLabel(row.candidate)}
                                        {row.symbol && <small>{row.symbol}</small>}
                                    </th>
                                    <td>
                                        <strong>{percent(hitRate(row.historical))}</strong>
                                        <small>
                                            {row.historical.hits}/{row.historical.count}
                                        </small>
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
                                        {row.estimatedNet === undefined ? '—' : money(row.estimatedNet)}
                                        {row.returnOnStake != null && <small>{percent(row.returnOnStake)}</small>}
                                    </td>
                                    <td>
                                        {row.maxWins ?? '—'} / {row.maxLosses ?? '—'}
                                    </td>
                                    <td>
                                        <button
                                            type='button'
                                            aria-pressed={isStarred(row)}
                                            disabled={!canStar && !isStarred(row)}
                                            aria-label={
                                                isStarred(row)
                                                    ? localize('Remove from Compare')
                                                    : localize('Add to Compare')
                                            }
                                            onClick={() => onStar(row)}
                                        >
                                            {isStarred(row) ? '★' : '☆'}
                                        </button>
                                        <button
                                            type='button'
                                            disabled={!canReview(row)}
                                            aria-label={localize('Review {{trade}}', {
                                                trade: candidateLabel(row.candidate),
                                            })}
                                            onClick={() => onReview(row, true)}
                                        >
                                            {localize('Review automatic')}
                                        </button>
                                        <button
                                            type='button'
                                            disabled={!canBuy}
                                            aria-label={localize('Buy {{trade}} once', {
                                                trade: candidateLabel(row.candidate),
                                            })}
                                            onClick={() => onReview(row, false)}
                                        >
                                            {localize('Buy once')}
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
                    'Simulated trades use non-overlapping tick moves. Estimated net uses historical outcomes and the current quoted payout at the selected stake.'
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
    initial_candidate?: string;
    is_accumulator: boolean;
    account_label: string;
    execution_block: string;
    purchase_block: string;
    preset_key?: string;
    onBuy: (trade: TInsightTrade, signal: AbortSignal) => Promise<string>;
    getStrategies: (contract_type: string) => TInsightStrategyOption[];
    onRefreshAutomation?: () => void;
    onStart: (draft: TInsightRun, signal: AbortSignal) => Promise<string>;
};

type TPanelProps = TProps & {
    starred: TCompareSetup[];
    setStarred: (setups: TCompareSetup[]) => void;
    durations: number[];
    setDurations: (durations: number[]) => void;
};

const InsightsPanel = ({
    symbol,
    currency,
    initial_stake,
    initial_ticks,
    initial_candidate,
    is_accumulator,
    account_label,
    execution_block,
    purchase_block,
    preset_key,
    onBuy,
    getStrategies,
    onRefreshAutomation,
    onStart,
    starred,
    setStarred,
    durations,
    setDurations,
}: TPanelProps) => {
    const ws = useWS();
    const [family, setFamily] = React.useState<TFamily>(is_accumulator ? 'accumulator' : 'digital');
    const [finderGroup, setFinderGroup] = React.useState(is_accumulator ? 'accumulator' : 'digital');
    const [finderBarrier, setFinderBarrier] = React.useState('5');
    const [preset] = React.useState(() => getInsightPreset(preset_key));
    const [stake, setStake] = React.useState(String(preset?.stake ?? initial_stake));
    const [stop_loss, setStopLoss] = React.useState(preset ? String(preset.stopLoss) : '');
    const [take_profit, setTakeProfit] = React.useState(
        preset?.takeProfit === undefined ? '' : String(preset.takeProfit)
    );
    const [preset_saved, setPresetSaved] = React.useState(false);
    const [draft, setDraft] = React.useState<{
        trade: TInsightTrade;
        run?: Omit<TInsightRun, keyof TInsightTrade>;
    }>();
    const [result, setResult] = React.useState<{ id: string; automatic: boolean }>();
    const review_ref = React.useRef<HTMLElement>(null);
    const [ticks, setTicks] = React.useState(String(preset?.ticks ?? initial_ticks));
    const [access, setAccess] = React.useState<TPremiumAccess | 'checking' | 'error'>('checking');
    const [check, setCheck] = React.useState(0);
    const [report, setReport] = React.useState<TTickInsights>();
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [view, setView] = React.useState<'finder' | 'compare'>('finder');
    const [manualSetup, setManualSetup] = React.useState<TCompareSetup>({
        symbol,
        candidate: initial_candidate ?? 'CALL',
    });
    const [markets, setMarkets] = React.useState<{ symbol: string; label: string }[]>([]);
    const [progress, setProgress] = React.useState<{ scanned: number; total: number }>();
    const request = React.useRef<AbortController>();

    React.useEffect(() => {
        if (view !== 'compare' || markets.length || typeof access === 'string' || access.access === 'locked') return;
        let active = true;
        void getInsightMarkets(payload => ws.send(payload)).then(
            result => {
                if (active && result.length) setMarkets(result);
            },
            () => undefined
        );
        return () => {
            active = false;
        };
    }, [view, markets.length, ws, access]);

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
        setResult(undefined);
        setProgress(undefined);
        const timeout = window.setTimeout(() => {
            if (!controller.signal.aborted) {
                controller.abort();
                setBusy(false);
                setReport(undefined);
                setError(localize('The comparison timed out. Try again.'));
            }
        }, 120000);
        try {
            const available = markets.length
                ? markets
                : await waitForInsightRequest(
                      getInsightMarkets(payload => ws.send(payload)),
                      localize('Instrument list timed out.')
                  );
            if (controller.signal.aborted) return;
            setMarkets(available);
            const symbols = [...new Set([symbol, ...available.map(market => market.symbol)])];
            setProgress({ scanned: 0, total: symbols.length });
            const candidates =
                finderGroup === 'digit-barrier'
                    ? ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF']
                          .filter(
                              type =>
                                  !(type === 'DIGITOVER' && finderBarrier === '9') &&
                                  !(type === 'DIGITUNDER' && finderBarrier === '0')
                          )
                          .map(type => `${type}:${finderBarrier}`)
                    : undefined;
            const result = await compareInsightMarkets(
                payload => ws.send(payload),
                { symbol, currency, family, stake: Number(stake), ticks: Number(ticks), candidates, windowSize: 400 },
                symbols,
                controller.signal,
                scanned => setProgress({ scanned, total: symbols.length })
            );
            if (controller.signal.aborted) return;
            setAccess(result?.access ?? { access: 'locked' });
            setReport(result ?? undefined);
        } catch {
            if (!controller.signal.aborted) {
                setReport(undefined);
                setError(
                    localize('Could not load instrument comparisons. Check your market connection and try again.')
                );
            }
        } finally {
            window.clearTimeout(timeout);
            if (!controller.signal.aborted) setBusy(false);
        }
    };

    const is_reviewing = !!draft;
    React.useEffect(() => {
        if (is_reviewing) review_ref.current?.focus();
    }, [is_reviewing]);

    const optionsFor = (candidate: string, duration: number, tradeFamily = family) =>
        getStrategies(getInsightContract(tradeFamily, candidate, duration).contract_type);

    const isStarred = (row: TInsightRow) =>
        starred.some(item => item.symbol === (row.symbol ?? symbol) && item.candidate === row.candidate);
    const star = (row: TInsightRow) => {
        const setup = { symbol: row.symbol ?? symbol, candidate: row.candidate };
        if (isStarred(row)) {
            setStarred(starred.filter(item => item.symbol !== setup.symbol || item.candidate !== setup.candidate));
            return;
        }
        if (manualSetup.symbol !== setup.symbol || manualSetup.candidate !== setup.candidate)
            setStarred([...starred, setup]);
        setDurations([...new Set([...durations, report?.ticks ?? Number(ticks)])]);
    };

    const savePreset = () => {
        if (!preset_key) return;
        const settings = {
            stake: Number(stake),
            ticks: Number(ticks),
            stopLoss: Number(stop_loss),
            takeProfit: take_profit === '' ? undefined : Number(take_profit),
        };
        setError('');
        if (!isInsightPresetValid(settings)) {
            setError(
                localize(
                    'Enter a valid stake and tick target, a run stop loss at least as large as the stake, and a positive take profit if used.'
                )
            );
            return;
        }
        try {
            localStorage.setItem(preset_key, JSON.stringify(settings));
            setPresetSaved(true);
        } catch {
            setError(localize('This browser could not save the automatic preset.'));
        }
    };

    const review = (
        row: TInsightRow,
        automatic: boolean,
        duration = report?.ticks ?? Number(ticks),
        tradeFamily = family
    ) => {
        if (row.stake !== Number(stake)) {
            setError(localize('The quoted stake differs from the entered stake. Adjust the stake and compare again.'));
            return;
        }
        const stopLoss = Number(stop_loss);
        const takeProfit = take_profit === '' ? undefined : Number(take_profit);
        const contractTakeProfit =
            tradeFamily === 'accumulator'
                ? Number((row.payout - row.stake).toFixed(getDecimalPlaces(currency)))
                : undefined;
        if (contractTakeProfit !== undefined && contractTakeProfit <= 0) {
            setError(localize('This payout target rounds to zero profit. Increase the stake or tick target.'));
            return;
        }
        setError('');
        setDraft({
            trade: {
                candidate: row.candidate,
                family: tradeFamily,
                ticks: duration,
                symbol: row.symbol ?? symbol,
                currency,
                stake: row.stake,
                payout: row.payout,
                contractTakeProfit,
            },
            run: automatic
                ? {
                      stopLoss,
                      takeProfit,
                      strategyId:
                          optionsFor(row.candidate, duration, tradeFamily).find(
                              option => option.id === '__fixed_stake__'
                          )?.id ?? '',
                  }
                : undefined,
        });
    };

    const confirm = async () => {
        if (!draft || busy || (draft.run ? execution_block : purchase_block)) return;
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        try {
            const id = draft.run
                ? await onStart({ ...draft.trade, ...draft.run }, controller.signal)
                : await onBuy(draft.trade, controller.signal);
            if (!controller.signal.aborted) {
                setResult({ id, automatic: !!draft.run });
                setDraft(undefined);
                setReport(undefined);
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                setError(error instanceof Error ? error.message : localize('Could not confirm the trade.'));
            }
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
    };

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
        const { trade, run } = draft;
        const title = run ? localize('Review automatic run') : localize('Review one contract');
        const block = run ? execution_block : purchase_block;
        const money = (value: number) => formatMoney(value, trade.currency);
        const strategies = run ? optionsFor(trade.candidate, trade.ticks, trade.family) : [];
        const selected_strategy = strategies.find(option => option.id === run?.strategyId);
        const valid_stop_loss = !!run && Number.isFinite(run.stopLoss) && run.stopLoss >= trade.stake;
        const strategy_incomplete =
            !!run &&
            (!selected_strategy ||
                !valid_stop_loss ||
                (selected_strategy.requiresTakeProfit && run.takeProfit === undefined) ||
                (run.takeProfit !== undefined && (!Number.isFinite(run.takeProfit) || run.takeProfit <= 0)) ||
                (!!selected_strategy.multiplier && !run.multiplier));
        return (
            <section ref={review_ref} tabIndex={-1} className='tick-insights__review' aria-label={title}>
                <h3>{title}</h3>
                {run && (
                    <div className='tick-insights__fields'>
                        <label>
                            {localize('Automatic strategy')}
                            <select
                                disabled={busy}
                                value={run.strategyId}
                                onChange={e => {
                                    const option = strategies.find(item => item.id === e.target.value);
                                    setError('');
                                    setDraft({
                                        trade,
                                        run: {
                                            ...run,
                                            strategyId: e.target.value,
                                            multiplier: option?.multiplier?.defaultValue,
                                            maxStake: undefined,
                                        },
                                    });
                                }}
                            >
                                <option value=''>{localize('Select a strategy')}</option>
                                {strategies.map(option => (
                                    <option key={option.id} value={option.id}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </label>
                        <label>
                            {localize('Run stop loss')} ({currency})
                            <input
                                type='number'
                                min={trade.stake}
                                step='any'
                                disabled={busy}
                                value={run.stopLoss || ''}
                                onChange={e => setDraft({ trade, run: { ...run, stopLoss: Number(e.target.value) } })}
                            />
                            {!valid_stop_loss && (
                                <small>
                                    {localize('Enter a run stop loss at least as large as the quoted stake.')}
                                </small>
                            )}
                        </label>
                        {selected_strategy?.multiplier && (
                            <label>
                                {localize('Stake multiplier')}
                                <input
                                    type='number'
                                    step='any'
                                    disabled={busy}
                                    value={run.multiplier ?? ''}
                                    onChange={e => setDraft({ trade, run: { ...run, multiplier: e.target.value } })}
                                />
                            </label>
                        )}
                        {selected_strategy?.maxStake && (
                            <label>
                                {localize('Maximum stake (optional)')} ({currency})
                                <input
                                    type='number'
                                    min={trade.stake}
                                    step='any'
                                    disabled={busy}
                                    value={run.maxStake ?? ''}
                                    onChange={e => setDraft({ trade, run: { ...run, maxStake: e.target.value } })}
                                />
                            </label>
                        )}
                        {(selected_strategy?.requiresTakeProfit || run.takeProfit !== undefined) && (
                            <label>
                                {selected_strategy?.requiresTakeProfit
                                    ? localize('Required run take profit')
                                    : localize('Run take profit')}{' '}
                                ({currency})
                                <input
                                    type='number'
                                    min='0.01'
                                    step='any'
                                    disabled={busy}
                                    value={run.takeProfit ?? ''}
                                    onChange={e =>
                                        setDraft({
                                            trade,
                                            run: {
                                                ...run,
                                                takeProfit: e.target.value ? Number(e.target.value) : undefined,
                                            },
                                        })
                                    }
                                />
                            </label>
                        )}
                    </div>
                )}
                {selected_strategy?.description && <p>{selected_strategy.description}</p>}
                <dl>
                    <dt>{localize('Account')}</dt>
                    <dd>{account_label}</dd>
                    <dt>{localize('Market and contract')}</dt>
                    <dd>
                        {trade.symbol} · {candidateLabel(trade.candidate)}
                    </dd>
                    <dt>{run ? localize('Initial stake') : localize('Stake')}</dt>
                    <dd>{money(trade.stake)}</dd>
                    {trade.contractTakeProfit === undefined ? (
                        <>
                            <dt>{localize('Duration')}</dt>
                            <dd>{localize('{{ticks}} ticks', { ticks: String(trade.ticks) })}</dd>
                        </>
                    ) : (
                        <>
                            <dt>{localize('Take profit per contract')}</dt>
                            <dd>{money(trade.contractTakeProfit)}</dd>
                        </>
                    )}
                    <dt>
                        {trade.contractTakeProfit === undefined
                            ? localize('Quoted payout')
                            : localize('Estimated payout')}
                    </dt>
                    <dd>
                        {money(
                            trade.contractTakeProfit === undefined
                                ? trade.payout
                                : trade.stake + trade.contractTakeProfit
                        )}
                    </dd>
                </dl>
                <p>
                    {run
                        ? localize(
                              'The run stop loss stops new purchases at the loss threshold. Open contracts can still settle and increase the loss.'
                          )
                        : localize('This buys one contract. The full stake is at risk.')}
                </p>
                <p>{localize('Pricing can change between review and execution.')}</p>
                {error && <p role='alert'>{error}</p>}
                {!busy && block && <p role='status'>{block}</p>}
                {!busy && block && run && onRefreshAutomation && (
                    <button type='button' onClick={onRefreshAutomation}>
                        {localize('Refresh automatic status')}
                    </button>
                )}
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
                    <button
                        type='button'
                        disabled={busy || !!block || strategy_incomplete}
                        onClick={() => void confirm()}
                    >
                        {busy
                            ? localize('Submitting…')
                            : run
                              ? localize('Confirm and start run')
                              : localize('Confirm and buy once')}
                    </button>
                </div>
            </section>
        );
    }

    return (
        <>
            {result && (
                <p role='status'>
                    {result.automatic
                        ? localize('Automatic run {{id}} started. Open Automatic settings to monitor or stop it.', {
                              id: result.id,
                          })
                        : localize('Contract {{id}} purchased. View it in Positions or Reports.', { id: result.id })}
                </p>
            )}
            <nav className='tick-insights__navigation' aria-label={localize('FancyTrading views')}>
                <button
                    type='button'
                    aria-pressed={view === 'finder'}
                    disabled={busy}
                    onClick={() => setView('finder')}
                >
                    {localize('Strategy finder')}
                </button>
                <button
                    type='button'
                    aria-pressed={view === 'compare'}
                    disabled={busy}
                    onClick={() => setView('compare')}
                >
                    {localize('Compare')} ({starred.length + 1})
                </button>
            </nav>
            {view === 'finder' && (
                <form onSubmit={compare} className='tick-insights__fields'>
                    <label>
                        {localize('Contract group')}
                        <select
                            value={finderGroup}
                            onChange={e => {
                                setFinderGroup(e.target.value);
                                setFamily(e.target.value === 'accumulator' ? 'accumulator' : 'digital');
                                setReport(undefined);
                            }}
                            disabled={busy}
                        >
                            <option value='accumulator'>{localize('Accumulator growth rates')}</option>
                            <option value='digital'>{localize('Rise / Fall and Even / Odd')}</option>
                            <option value='digit-barrier'>
                                {localize('Digit Over / Under and Matches / Differs')}
                            </option>
                        </select>
                    </label>
                    {finderGroup === 'digit-barrier' && (
                        <label>
                            {localize('Barrier')}
                            <select
                                value={finderBarrier}
                                disabled={busy}
                                onChange={e => {
                                    setFinderBarrier(e.target.value);
                                    setReport(undefined);
                                }}
                            >
                                {Array.from({ length: 10 }, (_, value) => (
                                    <option key={value}>{value}</option>
                                ))}
                            </select>
                        </label>
                    )}
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
                                setPresetSaved(false);
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
                                setPresetSaved(false);
                                setReport(undefined);
                            }}
                        />
                    </label>
                    <button type='submit' disabled={busy}>
                        {busy
                            ? localize('Comparing…')
                            : report
                              ? localize('Refresh comparison')
                              : localize('Scan instruments')}
                    </button>
                </form>
            )}
            {busy && progress && (
                <p role='status'>
                    {localize('Checked {{scanned}} of {{total}} instruments', {
                        scanned: String(progress.scanned),
                        total: String(progress.total),
                    })}
                </p>
            )}
            <fieldset className='tick-insights__fields tick-insights__preset'>
                <legend>{localize('Automatic settings')}</legend>
                <label>
                    {localize('Run stop loss (automatic only)')} ({currency})
                    <input
                        type='number'
                        min='0.01'
                        step='any'
                        value={stop_loss}
                        disabled={busy}
                        onChange={e => {
                            setStopLoss(e.target.value);
                            setPresetSaved(false);
                        }}
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
                        onChange={e => {
                            setTakeProfit(e.target.value);
                            setPresetSaved(false);
                        }}
                    />
                </label>
                {preset_key && (
                    <button type='button' disabled={busy} onClick={savePreset}>
                        {localize('Save automatic preset')}
                    </button>
                )}
            </fieldset>
            {preset_saved && <p role='status'>{localize('Automatic preset saved for this account.')}</p>}
            {error && <p role='alert'>{error}</p>}
            {view === 'compare' && (
                <>
                    {!initial_candidate && (
                        <p className='tick-insights__note'>
                            {localize(
                                'This manual contract has no tick replay. Compare starts with Rise on the active instrument.'
                            )}
                        </p>
                    )}
                    <InsightsCompare
                        symbol={symbol}
                        currency={currency}
                        stake={stake}
                        onStake={value => {
                            setStake(value);
                            setPresetSaved(false);
                            setReport(undefined);
                        }}
                        setups={[manualSetup, ...starred]}
                        onSetups={([first, ...rest]) => {
                            setManualSetup(first);
                            setStarred(rest);
                        }}
                        durations={durations}
                        onDurations={setDurations}
                        send={payload => ws.send(payload)}
                        subscribeTicks={ws.subscribeTicks}
                        markets={markets}
                        canBuy={!busy && !purchase_block}
                        canReview={contract => !busy && !execution_block && !!getStrategies(contract).length}
                        onReview={({ setup, row, report }, automatic) =>
                            review(
                                { ...row, symbol: setup.symbol },
                                automatic,
                                report.ticks,
                                /^[1-5]$/.test(setup.candidate) ? 'accumulator' : 'digital'
                            )
                        }
                    />
                </>
            )}
            {view === 'finder' && report && (
                <>
                    {purchase_block && <p role='status'>{purchase_block}</p>}
                    {execution_block && execution_block !== purchase_block && <p role='status'>{execution_block}</p>}
                    {execution_block && onRefreshAutomation && (
                        <button type='button' disabled={busy} onClick={onRefreshAutomation}>
                            {localize('Refresh automatic status')}
                        </button>
                    )}
                    {!execution_block &&
                        !!report.rows.length &&
                        report.rows.every(row => !optionsFor(row.candidate, report.ticks).length) && (
                            <p role='status'>
                                {localize('Deriv has no automatic strategies for the contracts in this comparison.')}
                            </p>
                        )}
                    <InsightsResults
                        report={report}
                        onReview={review}
                        canBuy={!busy && !purchase_block}
                        canReview={row => !busy && !execution_block && !!optionsFor(row.candidate, report.ticks).length}
                        onStar={star}
                        isStarred={isStarred}
                        canStar={starred.length < 3 && (durations.length < 4 || durations.includes(report.ticks))}
                    />
                </>
            )}
            <p className='tick-insights__note'>
                {localize(
                    'Historical hit rates describe past ticks. Review the account, stake and payout before confirming a trade.'
                )}
            </p>
        </>
    );
};

const TickInsights = (props: TProps) => {
    const dialog = React.useRef<HTMLDialogElement>(null);
    const [starred, setStarred] = React.useState<TCompareSetup[]>([]);
    const [durations, setDurations] = React.useState<number[]>();
    const title = React.useId();
    const fancy_trading = React.useContext(FancyTradingDialogContext);
    const open = !!props.symbol && !!fancy_trading?.open;

    React.useEffect(() => {
        const element = dialog.current;
        if (open && element && !element.open) element.showModal();
    }, [open]);

    if (!open) return null;

    return createPortal(
        <dialog
            ref={dialog}
            className='tick-insights tick-insights__dialog'
            aria-labelledby={title}
            onClose={() => fancy_trading?.setOpen(false)}
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
            <InsightsPanel
                {...props}
                starred={starred}
                setStarred={setStarred}
                durations={durations ?? [props.initial_ticks]}
                setDurations={setDurations}
            />
        </dialog>,
        document.body
    );
};

export default TickInsights;
