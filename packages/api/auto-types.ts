/**
 * Automation API types (auto_list_strategies, auto_start, auto_get, auto_list,
 * auto_pause, auto_resume, auto_stop).
 *
 * Source of truth: auto_documentation.txt (Deriv Automation API).
 * Request keys such as `auto_start: 1` are typed as the literal `1` on purpose:
 * `TSocketRequestCleaned` in ./types.ts strips keys typed as `1` from the payload.
 */

export type TAutoContractType =
    | 'HIGHER'
    | 'LOWER'
    | 'ACCU'
    | 'ASIAND'
    | 'ASIANU'
    | 'CALL'
    | 'CALLE'
    | 'DIGITDIFF'
    | 'DIGITEVEN'
    | 'DIGITMATCH'
    | 'DIGITODD'
    | 'DIGITOVER'
    | 'DIGITUNDER'
    | 'EXPIRYMISS'
    | 'EXPIRYMISSE'
    | 'EXPIRYRANGE'
    | 'EXPIRYRANGEE'
    | 'MULTDOWN'
    | 'MULTUP'
    | 'NOTOUCH'
    | 'ONETOUCH'
    | 'PUT'
    | 'PUTE'
    | 'RANGE'
    | 'RESETCALL'
    | 'RESETPUT'
    | 'RUNHIGH'
    | 'RUNLOW'
    | 'TICKHIGH'
    | 'TICKLOW'
    | 'TURBOSLONG'
    | 'TURBOSSHORT'
    | 'UPORDOWN'
    | 'VANILLALONGCALL'
    | 'VANILLALONGPUT';

export type TAutoDurationUnit = 'd' | 'm' | 's' | 'h' | 't';

export type TAutoContractTemplate = {
    /** Initial stake or payout value. Min: 0 */
    amount?: number;
    /** Barrier (or last digit prediction for digit contracts). Pattern: ^(?=.{1,20}$)[+-]?[0-9]+\.?[0-9]*$ */
    barrier?: string;
    /** Low barrier for contracts with two barriers */
    barrier2?: string;
    basis?: 'payout' | 'stake';
    contract_type: TAutoContractType;
    /** Pattern: ^[a-zA-Z0-9]{2,20}$ */
    currency: string;
    /** Min: 0, Max: 99999999 */
    duration?: number;
    duration_unit?: TAutoDurationUnit;
    /** Growth rate of an accumulator contract */
    growth_rate?: number;
    /** Only for MULTUP, MULTDOWN and ACCU */
    limit_order?: {
        stop_loss?: number;
        take_profit?: number;
    };
    /** Min: 0 */
    multiplier?: number;
    /** TICKHIGH / TICKLOW only */
    selected_tick?: number;
    /** Pattern: ^\w{2,30}$ */
    underlying_symbol: string;
};

export type TAutoContractStatus = 'open' | 'won' | 'lost';

export type TAutoContract = {
    buy_price: number;
    contract_id: number;
    contract_status?: TAutoContractStatus;
    /** Epoch */
    purchase_time: number;
    sell_price?: number;
    /** Epoch */
    sell_time?: number;
};

export type TAutoRunStatus = 'running' | 'paused' | 'stopped';
export type TAutoStopReason = 'error' | 'user_stopped' | 'condition_triggered';

export type TAutoStrategyParameters = Record<string, unknown>;

export type TAutoRun = {
    contract_template: Partial<TAutoContractTemplate>;
    contracts?: TAutoContract[];
    run_id: string;
    /** Epoch */
    start_time: number;
    status: TAutoRunStatus;
    stop_reason?: TAutoStopReason;
    stop_reason_code?: string;
    /** Epoch */
    stop_time?: number;
    strategy_id: string;
    strategy_parameters: TAutoStrategyParameters;
    total_payout?: number;
    total_stake?: number;
};

export type TAutoStrategyParameterSchema = {
    type?: string;
    [key: string]: unknown;
};

export type TAutoStrategy = {
    description?: string;
    display_name: string;
    parameters: Record<string, TAutoStrategyParameterSchema>;
    strategy_id: string;
    supported_contract_types: string[];
};

type TCommonRequestFields = {
    passthrough?: Record<string, unknown>;
    req_id?: number;
};

type TCommonResponseFields<M extends string> = {
    echo_req: Record<string, unknown>;
    msg_type: M;
    req_id?: number;
};

/* ----------------------------- auto_list_strategies ----------------------------- */
export type TAutoListStrategiesRequest = TCommonRequestFields & { auto_list_strategies: 1 };
export type TAutoListStrategiesResponse = TCommonResponseFields<'auto_list_strategies'> & {
    auto_list_strategies?: { strategies: TAutoStrategy[] };
};

/* ----------------------------------- auto_start ---------------------------------- */
export type TAutoStartRequest = TCommonRequestFields & {
    auto_start: 1;
    contract_template: TAutoContractTemplate;
    strategy_id: string;
    strategy_parameters: TAutoStrategyParameters;
    subscribe?: 1;
};
export type TAutoStartResponse = TCommonResponseFields<'auto_start'> & {
    auto_start?: TAutoRun;
    subscription?: { id: string };
};

/* ------------------------------------ auto_get ----------------------------------- */
export type TAutoGetRequest = TCommonRequestFields & {
    auto_get: 1;
    /** Pattern: ^[\w-]{1,128}$ */
    run_id: string;
    subscribe?: 1;
};
export type TAutoGetResponse = TCommonResponseFields<'auto_get'> & {
    auto_get?: TAutoRun;
    subscription?: { id: string };
};

/* ------------------------------------ auto_list ---------------------------------- */
export type TAutoListRequest = TCommonRequestFields & { auto_list: 1 };
export type TAutoListResponse = TCommonResponseFields<'auto_list'> & {
    auto_list?: { runs: TAutoRun[] };
};

/* ----------------------------- auto_pause / resume / stop ------------------------ */
export type TAutoPauseRequest = TCommonRequestFields & { auto_pause: 1; run_id: string };
export type TAutoPauseResponse = TCommonResponseFields<'auto_pause'> & { auto_pause?: TAutoRun };

export type TAutoResumeRequest = TCommonRequestFields & { auto_resume: 1; run_id: string };
export type TAutoResumeResponse = TCommonResponseFields<'auto_resume'> & { auto_resume?: TAutoRun };

export type TAutoStopRequest = TCommonRequestFields & { auto_stop: 1; run_id: string };
export type TAutoStopResponse = TCommonResponseFields<'auto_stop'> & { auto_stop?: TAutoRun };
