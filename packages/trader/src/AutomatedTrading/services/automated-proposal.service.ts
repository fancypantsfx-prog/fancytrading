import { fancyApiAdapter } from '../adapter/FancyApiAdapter';

import type {
    AutomatedProposal,
    AutomatedSignal,
    AutomatedTradeConfig,
    ManualTradeSelection,
} from '../types/automated-trading.types';

export class AutomatedProposalService {
    async create(
        config: AutomatedTradeConfig,
        signal: AutomatedSignal
    ): Promise<AutomatedProposal> {
        const request = {
            contractType: signal.contractType,
            symbol: config.symbol,
            amount: config.amount,
            currency: config.currency,
            basis: config.basis ?? 'stake',

            ...(config.duration !== undefined &&
            config.durationUnit !== undefined
                ? {
                      duration: config.duration,
                      durationUnit: config.durationUnit,
                  }
                : {}),

            ...(signal.barrier !== undefined
                ? { barrier: signal.barrier }
                : {}),

            ...(signal.barrier2 !== undefined
                ? { barrier2: signal.barrier2 }
                : {}),

            ...(signal.strike !== undefined
                ? { strike: signal.strike }
                : {}),

            ...(signal.payoutPerPoint !== undefined
                ? { payoutPerPoint: signal.payoutPerPoint }
                : {}),

            ...(config.growthRate !== undefined
                ? { growthRate: config.growthRate }
                : {}),

            ...(config.multiplier !== undefined
                ? { multiplier: config.multiplier }
                : {}),

            ...(config.cancellationDuration !== undefined
                ? { cancellation: config.cancellationDuration }
                : {}),

            ...(signal.proposalParams
                ? { extra: signal.proposalParams }
                : {}),
        };

        return fancyApiAdapter.getProposal(request);
    }

    /**
     * Create a fresh proposal from the exact manual trade snapshot.
     *
     * The automation engine may override only the stake and contract type.
     * All other manual proposal fields remain unchanged.
     */
    async createFromManualSelection(
        selection: ManualTradeSelection,
        overrides?: {
            amount?: number;
            contractType?: string;
        }
    ): Promise<AutomatedProposal> {
        return fancyApiAdapter.getProposalFromManualRequest(
            selection.proposalRequest,
            overrides
        );
    }

    async requestProposal(
        signal: AutomatedSignal,
        config: AutomatedTradeConfig
    ): Promise<AutomatedProposal> {
        return this.create(config, signal);
    }
}

export const automatedProposalService =
    new AutomatedProposalService();

export default automatedProposalService;
