import React from 'react';

import { useMutation, useQuery, useSubscription } from '@deriv/api';
import type { TAutoContractTemplate, TAutoRun, TAutoStrategyParameters } from '@deriv/api';

import { extractRun, isRunActive } from 'AppV2/Utils/auto-trade-utils';

type TApiError = { code?: string; message?: string };

type TStartRunArgs = {
    contract_template: TAutoContractTemplate;
    strategy_id: string;
    strategy_parameters: TAutoStrategyParameters;
};

/** Keeps data we already have (e.g. `contracts`) when a response only contains part of the run. */
const mergeRun = (previous: TAutoRun | null, next: TAutoRun): TAutoRun => {
    if (!previous || previous.run_id !== next.run_id) return next;
    return { ...previous, ...next, contracts: next.contracts ?? previous.contracts };
};

const getErrorMessage = (error: unknown) => {
    const { message } = (error ?? {}) as TApiError;
    return message || 'Something went wrong. Please try again.';
};

/**
 * Everything the Auto Trading page needs, built on the Automation API:
 *  - auto_list_strategies  -> strategies
 *  - auto_start (subscribe) -> startRun(), live run updates
 *  - auto_get (subscribe)   -> re-attaches to a run that is already running/paused
 *  - auto_list              -> run history
 *  - auto_pause / auto_resume / auto_stop
 *
 * Runs live on the server, so closing the page does NOT stop a run. When the page opens
 * again, an existing running/paused run is found through `auto_list` and re-attached
 * with `auto_get` + `subscribe`.
 */
export const useAutoTrade = ({ is_enabled }: { is_enabled: boolean }) => {
    const runs_query = useQuery('auto_list', {
        options: { enabled: is_enabled, cacheTime: 0, retry: false, refetchOnWindowFocus: false },
    });

    const start_stream = useSubscription('auto_start');
    const get_stream = useSubscription('auto_get');

    const pause_mutation = useMutation('auto_pause');
    const resume_mutation = useMutation('auto_resume');
    const stop_mutation = useMutation('auto_stop');

    const [active_run, setActiveRun] = React.useState<TAutoRun | null>(null);
    const [action_error, setActionError] = React.useState<string | null>(null);
    const [dismissed_stream_error, setDismissedStreamError] = React.useState<unknown>(null);
    const attached_run_id = React.useRef<string | null>(null);

    const { refetch: refetchRuns } = runs_query;
    const { subscribe: subscribeGet, unsubscribe: unsubscribeGet } = get_stream;
    const { subscribe: subscribeStart, unsubscribe: unsubscribeStart } = start_stream;

    /* ---- live updates from auto_start / auto_get streams ---- */
    React.useEffect(() => {
        const run = extractRun(start_stream.data);
        if (run) {
            attached_run_id.current = run.run_id;
            setActiveRun(previous => mergeRun(previous, run));
        }
    }, [start_stream.data]);

    React.useEffect(() => {
        const run = extractRun(get_stream.data);
        if (run) setActiveRun(previous => mergeRun(previous, run));
    }, [get_stream.data]);

    /* ---- re-attach to an existing running/paused run when the page opens ---- */
    React.useEffect(() => {
        if (!is_enabled || active_run) return;
        const existing = runs_query.data?.auto_list?.runs?.find(run => isRunActive(run));
        if (!existing || attached_run_id.current === existing.run_id) return;

        attached_run_id.current = existing.run_id;
        setActiveRun(existing);
        subscribeGet({ payload: { run_id: existing.run_id } });
    }, [is_enabled, active_run, runs_query.data, subscribeGet]);

    /* ---- when a run ends: close the streams and refresh the history ---- */
    React.useEffect(() => {
        if (active_run?.status === 'stopped') {
            unsubscribeStart();
            unsubscribeGet();
            refetchRuns();
        }
    }, [active_run?.status, refetchRuns, unsubscribeGet, unsubscribeStart]);

    /* ---- actions ---- */
    const startRun = React.useCallback(
        (args: TStartRunArgs) => {
            setActionError(null);
            setDismissedStreamError(start_stream.error ?? get_stream.error ?? null);
            unsubscribeGet();
            unsubscribeStart();
            attached_run_id.current = null;
            setActiveRun(null);

            subscribeStart({
                payload: {
                    contract_template: args.contract_template,
                    strategy_id: args.strategy_id,
                    strategy_parameters: args.strategy_parameters,
                },
            });
        },
        [get_stream.error, start_stream.error, subscribeStart, unsubscribeGet, unsubscribeStart]
    );

    const runControl = React.useCallback(
        async (action: 'pause' | 'resume' | 'stop') => {
            if (!active_run) return;
            setActionError(null);

            const mutation = { pause: pause_mutation, resume: resume_mutation, stop: stop_mutation }[action];
            try {
                const response = await mutation.mutateAsync({ payload: { run_id: active_run.run_id } });
                const run = extractRun(response);
                if (run) setActiveRun(previous => mergeRun(previous, run));
            } catch (error) {
                setActionError(getErrorMessage(error));
            }
        },
        [active_run, pause_mutation, resume_mutation, stop_mutation]
    );

    const pauseRun = React.useCallback(() => runControl('pause'), [runControl]);
    const resumeRun = React.useCallback(() => runControl('resume'), [runControl]);
    const stopRun = React.useCallback(() => runControl('stop'), [runControl]);

    const clearActiveRun = React.useCallback(() => {
        unsubscribeGet();
        unsubscribeStart();
        setActiveRun(null);
    }, [unsubscribeGet, unsubscribeStart]);

    /* ---- errors ---- */
    const stream_error = start_stream.error ?? get_stream.error;
    const visible_stream_error = stream_error && stream_error !== dismissed_stream_error ? stream_error : null;
    const error_message =
        action_error ??
        (visible_stream_error ? getErrorMessage(visible_stream_error) : null) ??
        (runs_query.error ? getErrorMessage(runs_query.error) : null);

    const dismissError = React.useCallback(() => {
        setActionError(null);
        setDismissedStreamError(stream_error ?? null);
    }, [stream_error]);

    return {
        active_run,
        runs: runs_query.data?.auto_list?.runs ?? [],
        is_loading_runs: runs_query.isInitialLoading,
        is_starting: start_stream.isLoading && !active_run,
        is_busy: pause_mutation.isLoading || resume_mutation.isLoading || stop_mutation.isLoading,
        error_message,
        dismissError,
        startRun,
        pauseRun,
        resumeRun,
        stopRun,
        clearActiveRun,
        refetchRuns,
    };
};

export default useAutoTrade;
