import React from 'react';
import { observer, useStore } from '@deriv/stores';
import { WS } from '@deriv/shared';
import { useTraderStore } from 'Stores/useTraderStores';
import './automated-trading-panel.scss';

type StrategyParameter = { type?: string; description?: string; default?: string | number | boolean; enum?: Array<string | number> };
type Strategy = { strategy_id: string; display_name: string; description?: string; parameters: Record<string, StrategyParameter>; supported_contract_types: string[] };
type Run = { run_id: string; status: string; strategy_id?: string; stop_reason?: string; total_stake?: number; total_payout?: number; contracts?: Array<{ contract_id: number; buy_price: number; sell_price?: number; contract_status?: string; purchase_time?: number }>; contract_template?: Record<string, unknown>; strategy_parameters?: Record<string, unknown> };

const readPayload = (response: any, key: string) => {
    if (response?.error) throw new Error(response.error.message || 'Deriv API request failed');
    return response?.[key];
};

const AutomatedTradingPanel = observer(() => {
    const { client } = useStore();
    const trade = useTraderStore();
    const [isOpen, setIsOpen] = React.useState(false);
    const [strategies, setStrategies] = React.useState<Strategy[]>([]);
    const [strategyId, setStrategyId] = React.useState('');
    const [contractType, setContractType] = React.useState('');
    const [amount, setAmount] = React.useState(String(trade.amount || 1));
    const [duration, setDuration] = React.useState(String(trade.duration || 1));
    const [durationUnit, setDurationUnit] = React.useState(trade.duration_unit || 't');
    const [parameters, setParameters] = React.useState<Record<string, string | number | boolean>>({});
    const [run, setRun] = React.useState<Run | null>(null);
    const [runs, setRuns] = React.useState<Run[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState('');
    const [notice, setNotice] = React.useState('');
    const subscriptionRef = React.useRef<any>(null);
    const aliveRef = React.useRef(true);

    const selectedStrategy = strategies.find(item => item.strategy_id === strategyId);
    const supportedTypes = selectedStrategy?.supported_contract_types || [];

    const applyRun = React.useCallback((nextRun: Run | undefined) => {
        if (!nextRun || !aliveRef.current) return;
        setRun(nextRun);
        setRuns(previous => [nextRun, ...previous.filter(item => item.run_id !== nextRun.run_id)]);
    }, []);

    const loadStrategies = React.useCallback(async () => {
        try {
            const response = await WS.storage.send({ auto_list_strategies: 1 });
            const result = readPayload(response, 'auto_list_strategies');
            const list = Array.isArray(result?.strategies) ? result.strategies : [];
            if (!aliveRef.current) return;
            setStrategies(list);
            setStrategyId(current => list.some((item: Strategy) => item.strategy_id === current) ? current : (list[0]?.strategy_id || ''));
            if (!list.length) setError('Deriv returned no available automation strategies for this connection.');
        } catch (e) {
            if (aliveRef.current) setError(e instanceof Error ? e.message : 'Could not load strategies.');
        }
    }, []);

    const loadRuns = React.useCallback(async () => {
        try {
            const response = await WS.storage.send({ auto_list: 1 });
            const result = readPayload(response, 'auto_list');
            const list = Array.isArray(result?.runs) ? result.runs : [];
            if (!aliveRef.current) return;
            setRuns(list);
            setRun(current => current && list.some((item: Run) => item.run_id === current.run_id) ? list.find((item: Run) => item.run_id === current.run_id) || current : (list.find((item: Run) => item.status === 'running' || item.status === 'paused') || current));
        } catch (e) {
            if (aliveRef.current) setError(e instanceof Error ? e.message : 'Could not load automation runs.');
        }
    }, []);

    React.useEffect(() => {
        aliveRef.current = true;
        if (client.is_logged_in) {
            void loadStrategies();
            void loadRuns();
        }
        return () => {
            aliveRef.current = false;
            try { subscriptionRef.current?.unsubscribe?.(); } catch { /* socket may already be closed */ }
        };
    }, [client.is_logged_in, loadStrategies, loadRuns]);

    React.useEffect(() => {
        const schema = selectedStrategy?.parameters || {};
        setParameters(current => {
            const next: Record<string, string | number | boolean> = {};
            Object.entries(schema).forEach(([key, spec]) => {
                const existing = current[key];
                if (existing !== undefined) next[key] = existing;
                else if (spec.default !== undefined) next[key] = spec.default;
                else if (spec.type === 'boolean') next[key] = false;
                else if (spec.type === 'number' || spec.type === 'integer') next[key] = 1;
                else next[key] = '';
            });
            return next;
        });
        setContractType(current => supportedTypes.includes(current) ? current : (supportedTypes[0] || ''));
    }, [strategyId, selectedStrategy, supportedTypes.join('|')]);

    const watchRun = React.useCallback((runId: string) => {
        try { subscriptionRef.current?.unsubscribe?.(); } catch { /* ignore stale subscription */ }
        if (typeof WS.subscribeTicksHistory !== 'function') return;
        try {
            subscriptionRef.current = WS.subscribeTicksHistory({ auto_get: 1, run_id: runId, subscribe: 1 }, (response: any) => {
                if (response?.error) {
                    setError(response.error.message || 'Run update subscription failed.');
                    return;
                }
                applyRun(response?.auto_get);
            });
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not subscribe to run updates.');
        }
    }, [applyRun]);

    const start = async () => {
        setError(''); setNotice('');
        if (!client.is_logged_in) { setError('Log in to your Deriv account before starting automation.'); return; }
        if (!trade.symbol || !trade.currency) { setError('Choose a market and ensure your account currency is loaded first.'); return; }
        if (!selectedStrategy || !contractType) { setError('Select an available strategy and supported contract type.'); return; }
        const stake = Number(amount); const durationValue = Number(duration);
        if (!Number.isFinite(stake) || stake <= 0 || !Number.isInteger(durationValue) || durationValue <= 0) { setError('Enter a stake greater than zero and a positive whole-number duration.'); return; }
        const cleanParams: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(parameters)) {
            if (value === '' || value === undefined) continue;
            const spec = selectedStrategy.parameters?.[key];
            cleanParams[key] = spec?.type === 'number' || spec?.type === 'integer' ? Number(value) : value;
        }
        setLoading(true);
        try {
            const contract_template: Record<string, unknown> = {
                amount: stake,
                basis: trade.basis === 'payout' ? 'payout' : 'stake',
                contract_type: contractType,
                currency: trade.currency,
                duration: durationValue,
                duration_unit: durationUnit,
                underlying_symbol: trade.symbol,
            };
            if (trade.barrier !== '' && ['DIGITOVER', 'DIGITUNDER', 'DIGITMATCH', 'DIGITDIFF'].includes(contractType)) contract_template.barrier = String(trade.barrier);
            if (typeof WS.subscribeTicksHistory === 'function') {
                try { subscriptionRef.current?.unsubscribe?.(); } catch { /* ignore */ }
                subscriptionRef.current = WS.subscribeTicksHistory({ auto_start: 1, contract_template, strategy_id: strategyId, strategy_parameters: cleanParams, subscribe: 1 }, (response: any) => {
                    if (response?.error) { setError(response.error.message || 'Could not start automation.'); return; }
                    const started = response?.auto_start;
                    if (started) {
                        applyRun(started);
                        if (started.run_id) setNotice(`Automation ${started.status || 'started'} · ${started.run_id}`);
                    }
                });
                setNotice('Sending start request to Deriv…');
            } else {
                const response = await WS.storage.send({ auto_start: 1, contract_template, strategy_id: strategyId, strategy_parameters: cleanParams, subscribe: 1 });
                const started = readPayload(response, 'auto_start');
                applyRun(started);
                if (started?.run_id) watchRun(started.run_id);
                setNotice(`Automation ${started?.status || 'started'}`);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not start automation.');
        } finally { setLoading(false); }
    };

    const manageRun = async (action: 'auto_pause' | 'auto_resume' | 'auto_stop') => {
        if (!run?.run_id) return;
        setError(''); setNotice(''); setLoading(true);
        try {
            const response = await WS.storage.send({ [action]: 1, run_id: run.run_id });
            const updated = readPayload(response, action);
            applyRun(updated);
            setNotice(action === 'auto_stop' ? 'Run stopped. Open contracts will continue until settlement.' : `Run ${updated?.status || action.replace('auto_', '')}.`);
            if (action === 'auto_stop') {
                try { subscriptionRef.current?.unsubscribe?.(); } catch { /* ignore */ }
                subscriptionRef.current = null;
            }
        } catch (e) { setError(e instanceof Error ? e.message : `Could not ${action.replace('auto_', '')} run.`); }
        finally { setLoading(false); }
    };

    const chooseRun = (runId: string) => {
        const chosen = runs.find(item => item.run_id === runId);
        if (!chosen) return;
        applyRun(chosen);
        watchRun(runId);
    };

    return <>
        <button className='automation-launcher' type='button' onClick={() => setIsOpen(value => !value)} aria-expanded={isOpen}>
            <span className='automation-launcher__dot' /> Automation
        </button>
        {isOpen && <section className='automation-panel' aria-label='Automated trading'>
            <header className='automation-panel__header'><div><strong>Automated trading</strong><small>Powered by Deriv Automation API</small></div><button type='button' className='automation-panel__close' onClick={() => setIsOpen(false)} aria-label='Close automation panel'>×</button></header>
            {!client.is_logged_in ? <div className='automation-panel__message'>Log in to your Deriv account to use automated trading.</div> : <>
                <div className='automation-panel__body'>
                    <label>Strategy<select value={strategyId} onChange={event => setStrategyId(event.target.value)} disabled={loading || !!(run && (run.status === 'running' || run.status === 'paused'))}><option value=''>Select strategy</option>{strategies.map(item => <option key={item.strategy_id} value={item.strategy_id}>{item.display_name}</option>)}</select></label>
                    {selectedStrategy?.description && <p className='automation-panel__description'>{selectedStrategy.description}</p>}
                    <div className='automation-panel__grid'>
                        <label>Market<input value={trade.symbol || ''} readOnly /></label>
                        <label>Currency<input value={trade.currency || ''} readOnly /></label>
                        <label>Contract type<select value={contractType} onChange={event => setContractType(event.target.value)} disabled={loading || !supportedTypes.length}>{supportedTypes.map(type => <option key={type} value={type}>{type}</option>)}</select></label>
                        <label>Stake<input type='number' min='0.01' step='any' value={amount} onChange={event => setAmount(event.target.value)} disabled={loading} /></label>
                        <label>Duration<input type='number' min='1' step='1' value={duration} onChange={event => setDuration(event.target.value)} disabled={loading} /></label>
                        <label>Duration unit<select value={durationUnit} onChange={event => setDurationUnit(event.target.value)} disabled={loading}><option value='t'>Ticks</option><option value='s'>Seconds</option><option value='m'>Minutes</option><option value='h'>Hours</option><option value='d'>Days</option></select></label>
                    </div>
                    {Object.keys(selectedStrategy?.parameters || {}).length > 0 && <div className='automation-panel__parameters'><strong>Strategy parameters</strong>{Object.entries(selectedStrategy?.parameters || {}).map(([key, spec]) => <label key={key}>{key.replace(/_/g, ' ')}{spec.type === 'boolean' ? <input type='checkbox' checked={Boolean(parameters[key])} onChange={event => setParameters(current => ({ ...current, [key]: event.target.checked }))} disabled={loading} /> : spec.enum ? <select value={String(parameters[key] ?? '')} onChange={event => setParameters(current => ({ ...current, [key]: event.target.value }))} disabled={loading}>{spec.enum.map(value => <option key={String(value)} value={String(value)}>{String(value)}</option>)}</select> : <input type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'} step={spec.type === 'integer' ? '1' : 'any'} value={String(parameters[key] ?? '')} onChange={event => setParameters(current => ({ ...current, [key]: event.target.value }))} disabled={loading} />}</label>)}</div>}
                    {trade.is_market_closed && <p className='automation-panel__warning'>The selected market is currently marked closed. Deriv may reject a start request.</p>}
                    {error && <p className='automation-panel__error' role='alert'>{error}</p>}{notice && <p className='automation-panel__notice' role='status'>{notice}</p>}
                    <div className='automation-panel__actions'>
                        <button type='button' onClick={start} disabled={loading || !strategies.length || !client.is_logged_in || Boolean(run && (run.status === 'running' || run.status === 'paused'))}>{loading ? 'Please wait…' : 'Start automation'}</button>
                        {run?.status === 'running' && <button type='button' className='secondary' onClick={() => void manageRun('auto_pause')} disabled={loading}>Pause</button>}
                        {run?.status === 'paused' && <button type='button' className='secondary' onClick={() => void manageRun('auto_resume')} disabled={loading}>Resume</button>}
                        {(run?.status === 'running' || run?.status === 'paused') && <button type='button' className='danger' onClick={() => void manageRun('auto_stop')} disabled={loading}>Stop</button>}
                    </div>
                    {run && <div className='automation-panel__run'><div className='automation-panel__run-head'><strong>Current run</strong><span className={`automation-status automation-status--${run.status}`}>{run.status}</span></div><small>{run.run_id}</small><div className='automation-panel__stats'><span>Contracts<strong>{run.contracts?.length ?? 0}</strong></span><span>Total stake<strong>{Number(run.total_stake || 0).toFixed(2)} {trade.currency}</strong></span><span>Total payout<strong>{Number(run.total_payout || 0).toFixed(2)} {trade.currency}</strong></span></div>{run.stop_reason && <small>Stop reason: {run.stop_reason}</small>}</div>}
                    {runs.length > 0 && <label className='automation-panel__history'>Recent runs<select value={run?.run_id || ''} onChange={event => chooseRun(event.target.value)}><option value=''>Select a run</option>{runs.map(item => <option key={item.run_id} value={item.run_id}>{item.strategy_id || 'Strategy'} · {item.status} · {item.run_id.slice(-8)}</option>)}</select></label>}
                    <p className='automation-panel__footnote'>Automation places real trades on the selected Deriv account. Start only when you understand the strategy and risk. Stopping a run does not close existing contracts.</p>
                </div>
            </>}
        </section>}
    </>;
});

export default AutomatedTradingPanel;
