import React from 'react';
import { createPortal } from 'react-dom';
import { fetchPremiumAccess, fetchStrategyFinder } from '@deriv/api';
import type { TPremiumAccess } from '@deriv/api';
import { getPlatformLogo, useWS } from '@deriv/shared';
import { localize } from '@deriv-com/translations';
import { FancyTradingDialogContext } from './fancy-trading-dialog-context';
import {
    formatInsightMoney as formatMoney,
    getLiveInsightQuote,
    getInsightContract,
    getInsightMarkets,
    getInsightPreset,
    InsightRateLimitError,
    InsightQuoteChanged,
    isInsightPresetValid,
} from './tick-insights-data';
import type { TInsightRun, TInsightStrategyOption, TInsightTrade, TTickInsights } from './tick-insights-data';
import RankedRunner from './ranked-runner';
import MenuHelp from './menu-help';
import InsightsCompare, { candidateLabel } from './insights-compare';
import type { TCompareSetup } from './insights-compare';
import { fetchFinderWindows, FINDER_SAMPLE_MAX_AGE, finderLiveSample } from './finder-ticks';
import './tick-insights.scss';

const percent = (value: number) => value.toLocaleString(undefined, { style: 'percent', maximumFractionDigits: 1 });
type TInsightRow = TTickInsights['rows'][number];

type TFinderRow = Pick<TInsightRow, 'candidate' | 'historical'> & {
    symbol: string;
    label?: string;
    sampleAt: number;
};
type TFinderReport = {
    access: TPremiumAccess;
    rows: TFinderRow[];
    ticks: number;
    precisionBySymbol?: Record<string, number>;
};
type TFinderSnapshot = TFinderReport & { settings: string; expiresAt: number };
const finderContracts = {
    rise_fall: ['CALL', 'PUT'],
    even_odd: ['DIGITEVEN', 'DIGITODD'],
    over_under: ['DIGITOVER', 'DIGITUNDER'],
    match_diff: ['DIGITMATCH'],
} as const;
type TFinderContract = keyof typeof finderContracts;
type TProps = {
    symbol: string;
    currency: string;
    initial_stake: number;
    initial_ticks: number;
    initial_candidate?: string;
    account_label: string;
    execution_block: string;
    purchase_block: string;
    preset_key?: string;
    onShowTrade?: (trade: TInsightTrade) => Promise<void>;
    onBuy: (trade: TInsightTrade, signal: AbortSignal) => Promise<string>;
    onRankedBuy?: React.ComponentProps<typeof RankedRunner>['buy'];
    getStrategies: (contract_type: string) => TInsightStrategyOption[];
    onRefreshAutomation?: () => void;
    onStart: (draft: TInsightRun, signal: AbortSignal) => Promise<string>;
};

type TPanelProps = TProps & {
    open: boolean;
    starred: TCompareSetup[];
    setStarred: (setups: TCompareSetup[]) => void;
    durations: number[];
    setDurations: (durations: number[]) => void;
};

const InsightsPanel = ({
    open,
    symbol,
    currency,
    initial_stake,
    initial_ticks,
    initial_candidate,
    account_label,
    execution_block,
    purchase_block,
    preset_key,
    onBuy,
    onRankedBuy,
    onShowTrade,
    getStrategies,
    onRefreshAutomation,
    onStart,
    starred,
    setStarred,
    durations,
    setDurations,
}: TPanelProps) => {
    const ws = useWS();
    const [finderGroup, setFinderGroup] = React.useState<TFinderContract>(
        () =>
            (Object.keys(finderContracts) as TFinderContract[]).find(group =>
                finderContracts[group].some(type => type === initial_candidate?.split(':')[0])
            ) ?? 'rise_fall'
    );
    const [finderBarrier, setFinderBarrier] = React.useState(initial_candidate?.split(':')[1] ?? '5');
    const [preset] = React.useState(() => getInsightPreset(preset_key));
    const [stake, setStake] = React.useState(String(preset?.stake ?? initial_stake));
    const [stop_loss, setStopLoss] = React.useState(preset ? String(preset.stopLoss) : '');
    const [take_profit, setTakeProfit] = React.useState(
        preset?.takeProfit === undefined ? '' : String(preset.takeProfit)
    );
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const settingsDialog = React.useRef<HTMLDialogElement>(null);
    React.useEffect(() => {
        if (settingsOpen) settingsDialog.current?.showModal();
    }, [settingsOpen]);
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
    const [snapshot, setReport] = React.useState<TFinderSnapshot>();
    const [loadingScan, setLoadingScan] = React.useState(false);
    const [refreshRequest, setRefreshRequest] = React.useState<{ settings: string; startedAt: number }>();
    const lastScan = React.useRef<{ settings: string; request: typeof refreshRequest }>();
    const [, expireRankings] = React.useReducer(version => version + 1, 0);
    const [error, setError] = React.useState('');
    const [scanError, setScanError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [view, setView] = React.useState<'finder' | 'compare' | 'trade'>('finder');
    const [markets, setMarkets] = React.useState<{ symbol: string; label: string }[]>([]);
    const request = React.useRef<AbortController>();

    React.useEffect(() => {
        if (!open || view !== 'compare' || markets.length || typeof access === 'string' || access.access === 'locked') return;
        const controller = new AbortController();
        void getInsightMarkets(payload => ws.send(payload), controller.signal).then(
            result => {
                if (!controller.signal.aborted && result.length) setMarkets(result);
            },
            () => undefined
        );
        return () => controller.abort();
    }, [open, view, markets.length, ws, access]);

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
                lastScan.current = undefined;
                setDraft(undefined);
                setAccess('checking');
                setCheck(value => value + 1);
            },
            Math.max(0, Math.min(remaining, 2147483647))
        );
        return () => window.clearTimeout(timer);
    }, [access]);

    React.useEffect(() => () => request.current?.abort(), []);

    React.useEffect(() => {
        if (open) return;
        request.current?.abort();
        setBusy(false);
        setDraft(undefined);
        setResult(undefined);
        setError('');
        setSettingsOpen(false);
        setView('finder');
    }, [open]);

    const scanSettings = new URLSearchParams({ contract: finderGroup, ticks, barrier: finderBarrier }).toString();
    const hasScanAccess = typeof access !== 'string' && access.access !== 'locked';

    const selectedSnapshot = snapshot?.settings === scanSettings ? snapshot : undefined;
    const report = selectedSnapshot && Date.now() < selectedSnapshot.expiresAt ? selectedSnapshot : undefined;
    const finderRows = report?.rows;
    const send = ws.send;

    React.useEffect(() => {
        if (!selectedSnapshot) return;
        const timer = window.setTimeout(expireRankings, Math.max(0, selectedSnapshot.expiresAt - Date.now()));
        return () => window.clearTimeout(timer);
    }, [selectedSnapshot]);

    React.useEffect(() => {
        setLoadingScan(false);
        if (!hasScanAccess || !/^([1-9]|1[0-9]|20)$/.test(ticks)) return;
        const previous = lastScan.current;
        const manual = refreshRequest?.settings === scanSettings && refreshRequest !== previous?.request;
        if (!manual && previous?.settings === scanSettings) return;

        const controller = new AbortController();
        const { signal } = controller;
        const refresh = async () => {
            setLoadingScan(true);
            setScanError('');
            try {
                const fetchController = new AbortController();
                const abortFetch = () => fetchController.abort();
                signal.addEventListener('abort', abortFetch, { once: true });
                const timeout = window.setTimeout(abortFetch, 6000);
                const next = await fetchStrategyFinder<TFinderReport>(
                    new URLSearchParams(scanSettings),
                    fetchController.signal
                ).finally(() => {
                    window.clearTimeout(timeout);
                    signal.removeEventListener('abort', abortFetch);
                });
                if (signal.aborted) return;
                if (next === null) {
                    setReport(undefined);
                    setAccess({ access: 'locked' });
                    return;
                }
                let rows = next.rows.filter(row => row.candidate.split(':')[0] !== 'DIGITDIFF');
                if (manual && rows.length) {
                    const symbols = [...new Set(rows.map(row => row.symbol))];
                    const windows = await fetchFinderWindows(send, symbols, signal);
                    if (signal.aborted) return;
                    if (!windows.size) throw new Error('No live tick history');
                    rows = rows.map(row => {
                        const sample = windows.get(row.symbol);
                        if (!sample || sample.sampleAt < row.sampleAt) return row;
                        const historical = finderLiveSample(
                            { ...sample, precision: sample.precision ?? next.precisionBySymbol?.[row.symbol] },
                            next.ticks,
                            row.candidate
                        );
                        return historical ? { ...row, historical, sampleAt: sample.sampleAt } : row;
                    });
                }
                const freshAfter = Date.now() - FINDER_SAMPLE_MAX_AGE;
                rows = rows.filter(({ sampleAt, historical }) =>
                    sampleAt > freshAfter && historical.count > 0 &&
                    (finderGroup !== 'rise_fall' || historical.hits / historical.count < 0.9)
                ).sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
                const startedAt = manual ? refreshRequest.startedAt : Date.now();
                setReport({ ...next, rows, settings: scanSettings, expiresAt: startedAt + FINDER_SAMPLE_MAX_AGE });
            } catch {
                if (!signal.aborted) setScanError(localize('Rankings are temporarily unavailable. Select Refresh rankings to try again.'));
            } finally {
                if (!signal.aborted) {
                    lastScan.current = { settings: scanSettings, request: refreshRequest };
                    setLoadingScan(false);
                }
            }
        };
        refresh();
        return () => controller.abort();
    }, [hasScanAccess, ticks, finderGroup, scanSettings, refreshRequest, send]);

    const is_reviewing = !!draft;
    React.useEffect(() => {
        if (is_reviewing) review_ref.current?.focus();
    }, [is_reviewing]);

    const optionsFor = (candidate: string, duration: number) =>
        getStrategies(getInsightContract('digital', candidate, duration).contract_type);

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
        row: Pick<TInsightRow, 'candidate' | 'symbol' | 'stake' | 'payout'>,
        automatic: boolean,
        duration = report?.ticks ?? Number(ticks)
    ) => {
        if (row.stake !== Number(stake)) {
            setError(localize('The quoted stake differs from the entered stake. Adjust the stake and compare again.'));
            return;
        }
        const strategy = automatic ? optionsFor(row.candidate, duration)[0] : undefined;
        const stopLoss = Number(stop_loss);
        const takeProfit = take_profit === '' ? undefined : Number(take_profit);
        setError('');
        setDraft({
            trade: {
                candidate: row.candidate,
                family: 'digital',
                ticks: duration,
                symbol: row.symbol ?? symbol,
                currency,
                stake: row.stake,
                payout: row.payout,
            },
            run: automatic
                ? {
                      stopLoss,
                      takeProfit,
                      strategyId: strategy?.id ?? '',
                      multiplier: strategy?.multiplier?.defaultValue,
                  }
                : undefined,
        });
    };

    const quoteFinderRow = async (row: TFinderRow, automatic: boolean) => {
        if (!report || Date.now() >= report.expiresAt || busy || purchase_block) return;
        const amount = Number(stake);
        if (!Number.isFinite(amount) || amount < 0.01 || amount > 1000000) {
            setError(localize('Enter a valid stake before requesting a live quote.'));
            return;
        }
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        try {
            const quote = await getLiveInsightQuote(
                payload => ws.send(payload),
                {
                    symbol: row.symbol,
                    currency,
                    stake: amount,
                    ticks: report.ticks,
                    candidate: row.candidate,
                    reportRejection: true,
                },
                controller.signal
            );
            if (controller.signal.aborted) return;
            if (quote?.stake !== amount) {
                throw new Error(localize('Deriv has no live quote for this selection.'));
            }
            review({ ...row, ...quote }, automatic, report.ticks);
        } catch (failure) {
            if (!controller.signal.aborted) {
                setError(
                    failure instanceof InsightRateLimitError
                        ? localize('Deriv is limiting requests. Wait a minute before requesting another quote.')
                        : failure instanceof Error
                          ? failure.message
                          : localize('Could not quote this trade. Check the stake and contract availability.')
                );
            }
        } finally {
            if (!controller.signal.aborted) setBusy(false);
        }
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
                try {
                    await onShowTrade?.(draft.trade);
                } catch {
                    setError(localize('The trade was confirmed. The chart could not be switched.'));
                }
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                if (error instanceof InsightQuoteChanged) {
                    setDraft({ ...draft, trade: { ...draft.trade, payout: error.payout } });
                }
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
                        lastScan.current = undefined;
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
        const strategies = run ? optionsFor(trade.candidate, trade.ticks) : [];
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
                    {localize('Fancy Strategy Finder')}
                </button>
                <MenuHelp
                    label={localize('Fancy Strategy Finder')}
                    description={localize(
                        'Rank instruments using historical ticks. Select a result to request a live quote.'
                    )}
                />
                <button
                    type='button'
                    aria-pressed={view === 'compare'}
                    disabled={busy}
                    onClick={() => setView('compare')}
                >
                    {localize('Compare')} ({starred.length})
                </button>
                <MenuHelp
                    label={localize('Compare')}
                    description={localize('Compare selected contracts, instruments and tick durations side by side.')}
                />
                {onRankedBuy && (
                    <button type='button' disabled={busy} aria-pressed={view === 'trade'} onClick={() => setView('trade')}>
                        {localize('FancyTrading')}
                    </button>
                )}
            </nav>
            {view === 'trade' && onRankedBuy && (
                <RankedRunner
                    currency={currency}
                    symbol={symbol}
                    stake={initial_stake}
                    account={account_label}
                    block={execution_block || purchase_block}
                    buy={onRankedBuy}
                />
            )}
            {view === 'finder' && starred.length > 0 && (
                <button type='button' disabled={busy} onClick={() => setStarred([])}>
                    {localize('Clear Compare')}
                </button>
            )}
            {view === 'finder' && loadingScan && !report && <p role='status'>{localize('Loading market rankings�')}</p>}
            {view === 'finder' && selectedSnapshot && !report && !loadingScan && (
                <p role='status'>{localize('Rankings expired. Select Refresh rankings for new results.')}</p>
            )}
            {view === 'finder' && (
                <div className='tick-insights__fields'>
                    <div className='tick-insights__field-help'>
                        <label>
                            {localize('Contract group')}
                            <select
                                value={finderGroup}
                                onChange={e => {
                                    setFinderGroup(e.target.value as TFinderContract);
                                }}
                                disabled={busy}
                            >
                                <option value='rise_fall'>{localize('Rise / Fall')}</option>
                                <option value='even_odd'>{localize('Even / Odd')}</option>
                                <option value='over_under'>{localize('Over / Under')}</option>
                                <option value='match_diff'>{localize('Digit Matches')}</option>
                            </select>
                        </label>
                        <MenuHelp
                            label={localize('Contract group')}
                            description={localize('Choose the contract types to rank using historical ticks.')}
                        />
                    </div>
                    {(finderGroup === 'over_under' || finderGroup === 'match_diff') && (
                        <div className='tick-insights__field-help'>
                            <label>
                                {localize('Barrier')}
                                <select
                                    value={finderBarrier}
                                    disabled={busy}
                                    onChange={e => {
                                        setFinderBarrier(e.target.value);
                                    }}
                                >
                                    {Array.from({ length: 10 }, (_, value) => (
                                        <option key={value}>{value}</option>
                                    ))}
                                </select>
                            </label>
                            <MenuHelp
                                label={localize('Barrier')}
                                description={localize(
                                    'The digit used for the comparison. With a barrier of 3, Over wins on 4�9 and Under wins on 0�2. Matches uses the exact digit.'
                                )}
                            />
                        </div>
                    )}
                    <div className='tick-insights__field-help'>
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
                                }}
                            />
                        </label>
                        <MenuHelp
                            label={localize('Stake per contract')}
                            description={localize(
                                'The amount you would risk on one contract. This is used when you request a live quote.'
                            )}
                        />
                    </div>
                    <div className='tick-insights__field-help'>
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
                                }}
                            />
                        </label>
                        <MenuHelp
                            label={localize('Tick target')}
                            description={localize('How many market price updates each simulated contract lasts.')}
                        />
                    </div>
                    <button
                        type='button'
                        disabled={busy || loadingScan || !/^([1-9]|1[0-9]|20)$/.test(ticks)}
                        onClick={() => setRefreshRequest({ settings: scanSettings, startedAt: Date.now() })}
                    >
                        {loadingScan ? localize('Refreshing rankings…') : localize('Refresh rankings')}
                    </button>
                </div>
            )}
            <>
                <button type='button' aria-haspopup='dialog' onClick={() => setSettingsOpen(true)}>
                    {localize('Automatic settings')}
                </button>
                <MenuHelp
                    label={localize('Automatic settings')}
                    description={localize(
                        'Set and save stop loss and take profit for automatic runs reviewed in FancyTrading.'
                    )}
                />
                {settingsOpen && (
                    <dialog
                        ref={settingsDialog}
                        className='tick-insights tick-insights__dialog'
                        aria-label={localize('Automatic settings')}
                        onClose={() => setSettingsOpen(false)}
                    >
                        <button
                            type='button'
                            onClick={() => {
                                settingsDialog.current?.close();
                                setSettingsOpen(false);
                            }}
                        >
                            {localize('Done')}
                        </button>
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
                    </dialog>
                )}
            </>
            {preset_saved && <p role='status'>{localize('Automatic preset saved for this account.')}</p>}
            {(error || (view === 'finder' && scanError)) && <p role='alert'>{error || scanError}</p>}
            <a className='tick-insights__tutorial' href='/help#tutorial' target='_blank' rel='noopener noreferrer'>
                {localize('FancyTrading tutorial')}
            </a>
            {view === 'compare' && (
                <InsightsCompare
                    symbol={symbol}
                    currency={currency}
                    stake={stake}
                    onStake={value => {
                        setStake(value);
                        setPresetSaved(false);
                    }}
                    setups={starred}
                    onSetups={setStarred}
                    durations={durations}
                    onDurations={setDurations}
                    send={payload => ws.send(payload)}
                    subscribeTicks={
                        ws.subscribeTicks
                            ? (market, callback) =>
                                  ws.subscribeTicks(market, callback, { fancytrading_insights: true })
                            : undefined
                    }
                    markets={markets}
                    canBuy={!busy && !purchase_block}
                    canReview={contract => !busy && !execution_block && !!getStrategies(contract).length}
                    onReview={({ setup, row, report }, automatic) =>
                        review({ ...row, symbol: setup.symbol }, automatic, report.ticks)
                    }
                />
            )}
            {view === 'finder' && purchase_block && <p role='status'>{purchase_block}</p>}
            {view === 'finder' && report && (
                <>
                    {execution_block && execution_block !== purchase_block && <p role='status'>{execution_block}</p>}
                    {execution_block && onRefreshAutomation && (
                        <button type='button' disabled={busy} onClick={onRefreshAutomation}>
                            {localize('Refresh automatic status')}
                        </button>
                    )}
                    {!execution_block &&
                        !!finderRows?.length &&
                        finderRows.every(row => !optionsFor(row.candidate, report.ticks).length) && (
                            <p role='status'>
                                {localize('Deriv has no automatic strategies for the contracts in this comparison.')}
                            </p>
                        )}
                    <div
                        className='tick-insights__table tick-insights__table--finder'
                        tabIndex={0}
                        role='region'
                        aria-label={localize('Scan results')}
                    >
                        <table>
                            <thead>
                                <tr>
                                    <th scope='col'>{localize('Trade')}</th>
                                    <th scope='col'>{localize('Historical hit rate')}</th>
                                    <th scope='col'>{localize('Trade actions')}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {finderRows?.map(row => (
                                    <tr key={`${row.symbol}:${row.candidate}`}>
                                        <th scope='row'>
                                            {row.label || row.symbol} · {candidateLabel(row.candidate)}
                                        </th>
                                        <td>{percent(row.historical.hits / row.historical.count)}</td>
                                        <td>
                                            <button
                                                type='button'
                                                disabled={busy || !!purchase_block}
                                                onClick={() => void quoteFinderRow(row, false)}
                                            >
                                                {localize('Get live quote')}
                                            </button>
                                            <button
                                                type='button'
                                                disabled={
                                                    busy ||
                                                    !!execution_block ||
                                                    !optionsFor(row.candidate, report.ticks).length
                                                }
                                                onClick={() => void quoteFinderRow(row, true)}
                                            >
                                                {localize('Review automatic')}
                                            </button>
                                            <button
                                                type='button'
                                                disabled={
                                                    starred.length >= 4 ||
                                                    starred.some(
                                                        setup =>
                                                            setup.symbol === row.symbol &&
                                                            setup.candidate === row.candidate
                                                    )
                                                }
                                                onClick={() => {
                                                    setStarred([
                                                        ...starred,
                                                        { symbol: row.symbol, candidate: row.candidate },
                                                    ]);
                                                    if (durations.length < 4)
                                                        setDurations([...new Set([...durations, report.ticks])]);
                                                }}
                                            >
                                                {localize('Add to Compare')}
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {!finderRows?.length && !loadingScan && (
                        <p role='status'>
                            {localize('No ranked contracts are available for these settings yet.')}
                        </p>
                    )}
                </>
            )}
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
        if (!element) return;
        if (open && !element.open) element.showModal();
        if (!open && element.open) element.close();
    }, [open]);

    if (!fancy_trading || !props.symbol) return null;

    return createPortal(
        <dialog
            ref={dialog}
            hidden={!open}
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
                        <p>{localize('by FancyPants')}</p>
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
                key={JSON.stringify([props.account_label, props.currency])}
                {...props}
                open={open}
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
