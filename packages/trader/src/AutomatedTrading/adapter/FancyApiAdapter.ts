import { WS } from '@deriv/shared';

import { processPurchase } from '../../Stores/Modules/Trading/Actions/purchase';

import type {
    AutomatedContractResult,
    AutomatedProposal,
    AutomatedTick,
    AutomatedContractType,
} from '../types/automated-trading.types';

export type ActiveSymbol = {
    symbol: string;
    name?: string;
    pipSize?: number;
    exchangeIsOpen?: boolean;
    tradingSuspended?: boolean;
};

export type AutomatedProposalRequest = {
    contractType: AutomatedContractType;
    symbol: string;

    amount: number;
    currency: string;

    basis: 'stake' | 'payout';

    duration?: number;

    durationUnit?:
        | 't'
        | 's'
        | 'm'
        | 'h'
        | 'd';

    barrier?: number;

    barrier2?: number;

    strike?: number;

    payoutPerPoint?: number;

    growthRate?: number;

    multiplier?: number;

    cancellation?: number;

    limitOrder?: {
        takeProfit?: number;
        stopLoss?: number;
    };

    /**
     * Allows strategy-specific proposal fields
     * without forcing every contract to use them.
     */
    extra?: Record<string, unknown>;
};

const normalizeActiveSymbol = (
    item: any
): ActiveSymbol => ({
    symbol:
        item?.underlying_symbol ??
        item?.symbol ??
        '',

    name:
        item?.underlying_symbol_name ??
        item?.display_name ??
        item?.symbol,

    pipSize:
        item?.pip_size == null
            ? undefined
            : Number(item.pip_size),

    exchangeIsOpen:
        item?.exchange_is_open == null
            ? undefined
            : Boolean(item.exchange_is_open),

    tradingSuspended:
        item?.is_trading_suspended == null
            ? undefined
            : Boolean(item.is_trading_suspended),
});

class FancyApiAdapter {
    /**
     * ------------------------------------------------------------------
     * ACTIVE SYMBOLS
     * ------------------------------------------------------------------
     */

    async getActiveSymbols(): Promise<ActiveSymbol[]> {
        const response =
            await WS.activeSymbols('brief');

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    'Unable to load active symbols'
            );
        }

        return (
            response?.active_symbols ?? []
        )
            .map(normalizeActiveSymbol)
            .filter(
                (item: ActiveSymbol) =>
                    Boolean(item.symbol)
            );
    }

    async getActiveSymbol(
        symbol: string
    ): Promise<ActiveSymbol | undefined> {
        const symbols =
            await this.getActiveSymbols();

        return symbols.find(
            item =>
                item.symbol === symbol
        );
    }

    /**
     * ------------------------------------------------------------------
     * TICK HISTORY
     * ------------------------------------------------------------------
     */

    async requestTicks(
        symbol: string,
        count = 1000,
        pipSize?: number
    ): Promise<AutomatedTick[]> {
        const response =
            await WS.storage.send({
                ticks_history: symbol,
                end: 'latest',
                count,
                style: 'ticks',
            });

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    'Unable to load tick history'
            );
        }

        const times =
            response?.history?.times ?? [];

        const prices =
            response?.history?.prices ?? [];

        return times
            .map(
                (
                    epoch: number,
                    index: number
                ) => {
                    const raw = String(
                        prices[index]
                    );

                    return {
                        epoch: Number(epoch),

                        quote: Number(raw),

                        quoteString: raw,

                        symbol,

                        pipSize,
                    };
                }
            )
            .filter(
                (tick: AutomatedTick) =>
                    Number.isFinite(
                        tick.quote
                    )
            );
    }

    /**
     * ------------------------------------------------------------------
     * LIVE TICKS
     * ------------------------------------------------------------------
     */

    subscribeTicks(
        symbol: string,
        callback: (
            tick: AutomatedTick
        ) => void
    ) {
        return WS.subscribeTicks(
            symbol,
            (response: any) => {
                if (!response?.tick) {
                    return;
                }

                const tick =
                    response.tick;

                const raw = String(
                    tick.quote
                );

                const normalizedTick: AutomatedTick =
                    {
                        epoch: Number(
                            tick.epoch
                        ),

                        quote: Number(
                            raw
                        ),

                        quoteString: raw,

                        symbol:
                            tick.symbol ??
                            symbol,

                        pipSize:
                            tick.pip_size ==
                            null
                                ? undefined
                                : Number(
                                      tick.pip_size
                                  ),
                    };

                if (
                    !Number.isFinite(
                        normalizedTick.quote
                    )
                ) {
                    return;
                }

                callback(
                    normalizedTick
                );
            }
        );
    }

    /**
     * ------------------------------------------------------------------
     * PROPOSALS
     * ------------------------------------------------------------------
     *
     * Unlike the previous implementation, this does NOT assume that
     * every contract needs duration + duration_unit + barrier.
     *
     * The proposal is constructed only from the fields required by
     * the selected contract.
     */

    async getProposal(
        R
        : AutomatedProposalRequest
    ): Promise<AutomatedProposal> {
        const proposalRequest: Record<
            string,
            unknown
        > = {
            proposal: 1,

            subscribe: 1,

            amount:
                R
                .amount,

            basis:
                R
                .basis,

            contract_type:
                R
                .contractType,

            currency:
                R
                .currency,

            underlying_symbol:
                R
                .symbol,
        };

        /**
         * Duration contracts.
         *
         * Accumulators and Multipliers will simply omit these fields.
         */
        if (
            R
            .duration !==
                undefined &&
            R
            .durationUnit !==
                undefined
        ) {
            proposalRequest.duration =
                R
                .duration;

            proposalRequest.duration_unit =
                R
                .durationUnit;
        }

        /**
         * Single barrier.
         */
        if (
            R
            .barrier !==
            undefined
        ) {
            proposalRequest.barrier =
                R
                .barrier;
        }

        /**
         * Second barrier.
         *
         * Used by contracts such as Accumulators where applicable.
         */
        if (
            R
            .barrier2 !==
            undefined
        ) {
            proposalRequest.barrier2 =
                R
                .barrier2;
        }

        /**
         * Vanilla / strike-based contracts.
         */
        if (
            R
            .strike !==
            undefined
        ) {
            proposalRequest.strike =
                R
                .strike;
        }

        /**
         * Turbos.
         */
        if (
            R
            .payoutPerPoint !==
            undefined
        ) {
            proposalRequest.payout_per_point =
                R
                .payoutPerPoint;
        }

        /**
         * Accumulators.
         */
        if (
            R
            .growthRate !==
            undefined
        ) {
            proposalRequest.growth_rate =
                R
                .growthRate;
        }

        /**
         * Multipliers.
         */
        if (
            R
            .multiplier !==
            undefined
        ) {
            proposalRequest.multiplier =
                R
                .multiplier;
        }

        if (
            R
            .cancellation !==
            undefined
        ) {
            proposalRequest.cancellation =
                R
                .cancellation;
        }

        /**
         * Optional risk-management fields.
         */
        if (R
            .limitOrder) {
            const limitOrder: Record<
                string,
                number
            > = {};

            if (
                R
                .limitOrder
                    .takeProfit !==
                undefined
            ) {
                limitOrder.take_profit =
                    R
                    .limitOrder
                        .takeProfit;
            }

            if (
                R
                .limitOrder
                    .stopLoss !==
                undefined
            ) {
                limitOrder.stop_loss =
                    R
                    .limitOrder
                        .stopLoss;
            }

            if (
                Object.keys(
                    limitOrder
                ).length > 0
            ) {
                proposalRequest.limit_order =
                    limitOrder;
            }
        }

        /**
         * Strategy-specific fields.
         */
        if (R
            .extra) {
            Object.assign(
                proposalRequest,
                R
                .extra
            );
        }

        const response =
            await WS.storage.send(
                proposalRequest
            );

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    'Proposal Request failed'
            );
        }

        if (
            !response?.proposal?.id
        ) {
            throw new Error(
                'Deriv returned no proposal'
            );
        }

        const proposal =
            response.proposal;

        return {
            id: String(
                proposal.id
            ),

            askPrice: Number(
                proposal.ask_price ??
                    proposal.display_value ??
                    0
            ),

            payout:
                proposal.payout ==
                null
                    ? undefined
                    : Number(
                          proposal.payout
                      ),

            contractType:
                proposal.contract_type ??
                R
                .contractType,

            barrier:
                proposal.barrier ==
                null
                    ? R
                    .barrier
                    : Number(
                          proposal.barrier
                      ),

            barrier2:
                proposal.barrier2 ==
                null
                    ? R
                    .barrier2
                    : Number(
                          proposal.barrier2
                      ),

            raw: proposal,
        };
    }

    /**
     * Request a proposal from an exact snapshot of the manual proposal
     * request. The automation engine only overrides the stake and, when
     * Trade Differs is enabled, the contract type.
     */
    async getProposalFromManualRequest(
        request: Record<string, unknown>,
        overrides?: {
            amount?: number;
            contractType?: string;
        }
    ): Promise<AutomatedProposal> {
        const proposalRequest: Record<string, unknown> = {
            ...request,
            proposal: 1,
            subscribe: 1,
        };

        if (overrides?.amount !== undefined) {
            proposalRequest.amount = overrides.amount;
        }

        if (overrides?.contractType !== undefined) {
            proposalRequest.contract_type = overrides.contractType;
        }

        // Validate required proposal fields locally so the user gets a clear
        // error instead of Deriv's less actionable contract_type validation.
        const contractType = proposalRequest.contract_type;
        if (typeof contractType !== 'string' || contractType.trim() === '') {
            throw new Error(
                'Automation cannot request a proposal because contract_type is missing. Re-select the contract in the manual trading panel and wait for its proposal.'
            );
        }

        if (typeof proposalRequest.symbol !== 'string' || proposalRequest.symbol.trim() === '') {
            throw new Error('Automation cannot request a proposal because the market symbol is missing.');
        }

        if (typeof proposalRequest.currency !== 'string' || proposalRequest.currency.trim() === '') {
            throw new Error('Automation cannot request a proposal because the account currency is missing.');
        }

        const requestAmount = Number(proposalRequest.amount);
        if (!Number.isFinite(requestAmount) || requestAmount <= 0) {
            throw new Error('Automation cannot request a proposal because the stake or payout amount is invalid.');
        }

        if (proposalRequest.basis !== 'stake' && proposalRequest.basis !== 'payout') {
            throw new Error('Automation cannot request a proposal because the amount basis must be stake or payout.');
        }

        // Session TP/SL are handled by the automation engine after each
        // contract settles. Do not attach them to the proposal here.
        delete proposalRequest.limit_order;

        const response = await WS.storage.send(proposalRequest);

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    'Manual automation proposal request failed'
            );
        }

        if (!response?.proposal?.id) {
            throw new Error(
                'Deriv returned no proposal for the manual selection'
            );
        }

        const proposal = response.proposal;

        return {
            id: String(proposal.id),

            askPrice: Number(
                proposal.ask_price ??
                    proposal.display_value ??
                    0
            ),

            payout:
                proposal.payout == null
                    ? undefined
                    : Number(proposal.payout),

            contractType:
                proposal.contract_type ??
                String(proposalRequest.contract_type ?? ''),

            barrier:
                proposal.barrier == null
                    ? undefined
                    : Number(proposal.barrier),

            barrier2:
                proposal.barrier2 == null
                    ? undefined
                    : Number(proposal.barrier2),

            raw: proposal,
        };
    }

    /**
     * ------------------------------------------------------------------
     * PURCHASE
     * ------------------------------------------------------------------
     *
     * Keep Fancy's existing purchase flow.
     *
     * This means automation uses the same authenticated account/session
     * and purchase infrastructure as normal manual trading.
     */

    async buy(
        proposal: AutomatedProposal
    ) {
        const response =
            await processPurchase(
                proposal.id,
                proposal.askPrice
            );

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    'Purchase failed'
            );
        }

        if (
            !response?.buy
                ?.contract_id
        ) {
            throw new Error(
                'Deriv returned no contract id'
            );
        }

        return response.buy;
    }

    /**
     * ------------------------------------------------------------------
     * CONTRACT MONITORING
     * ------------------------------------------------------------------
     */

    monitorContract(
        contractId: string
    ): Promise<AutomatedContractResult> {
        return new Promise(
            (
                resolve,
                reject
            ) => {
                let settled =
                    false;

                const subscription =
                    WS.subscribeProposalOpenContract(
                        contractId,
                        (
                            response: any
                        ) => {
                            if (
                                settled
                            ) {
                                return;
                            }

                            if (
                                response?.error
                            ) {
                                settled =
                                    true;

                                subscription?.unsubscribe?.();

                                reject(
                                    new Error(
                                        response
                                            .error
                                            .message ||
                                            'Contract monitoring failed'
                                    )
                                );

                                return;
                            }

                            const contract =
                                response?.proposal_open_contract;

                            if (
                                !contract
                            ) {
                                return;
                            }

                            const isSold =
                                Boolean(
                                    contract.is_sold
                                ) ||
                                contract.status ===
                                    'sold' ||
                                contract.status ===
                                    'won' ||
                                contract.status ===
                                    'lost';

                            const isExpired =
                                Boolean(
                                    contract.is_expired
                                ) ||
                                contract.status ===
                                    'expired';

                            if (
                                !isSold &&
                                !isExpired
                            ) {
                                return;
                            }

                            settled =
                                true;

                            subscription?.unsubscribe?.();

                            resolve({
                                contractId:
                                    String(
                                        contract.contract_id ??
                                            contractId
                                    ),

                                status:
                                    String(
                                        contract.status ??
                                            (isExpired
                                                ? 'expired'
                                                : 'sold')
                                    ),

                                isSold,

                                isExpired,

                                profit:
                                    Number(
                                        contract.profit ??
                                            0
                                    ),

                                buyPrice:
                                    Number(
                                        contract.buy_price ??
                                            0
                                    ),

                                sellPrice:
                                    contract.sell_price ==
                                    null
                                        ? undefined
                                        : Number(
                                              contract.sell_price
                                          ),

                                exitSpot:
                                    contract.exit_spot ==
                                    null
                                        ? undefined
                                        : Number(
                                              contract.exit_spot
                                          ),
                            });
                        }
                    );

                if (!subscription) {
                    reject(
                        new Error(
                            'Unable to subscribe to contract updates'
                        )
                    );
                }
            }
        );
    }

    /**
     * ------------------------------------------------------------------
     * SELL
     * ------------------------------------------------------------------
     */

    sell(
        contractId: string,
        price = 0
    ) {
        return WS.sell(
            contractId,
            price
        );
    }
}

export const fancyApiAdapter =
    new FancyApiAdapter();

export default fancyApiAdapter;