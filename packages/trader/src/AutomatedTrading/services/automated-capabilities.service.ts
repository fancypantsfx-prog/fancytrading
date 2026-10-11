import { WS } from '@deriv/shared';

import {
    getAutomatedCapabilities,
} from '../capabilities/automated-contract-capabilities';

import {
    getImplementedStrategies,
} from '../strategies/strategy-factory';

import type {
    AutomatedContractCapability,
} from '../types/automated-trading.types';

export class AutomatedCapabilitiesService {
    async getCapabilities(
        symbol: string
    ): Promise<
        AutomatedContractCapability[]
    > {
        if (!symbol) {
            return [];
        }

        const response =
            await WS.storage.send({
                contracts_for:
                    symbol,
            });

        if (response?.error) {
            throw new Error(
                response.error.message ||
                    `Unable to load contracts for ${symbol}`
            );
        }

        const available =
            response?.contracts_for
                ?.available ?? [];

        const availableContractTypes =
            new Set<string>(
                available
                    .map(
                        (contract: any) =>
                            contract?.contract_type
                    )
                    .filter(
                        (
                            contractType: unknown
                        ): contractType is string =>
                            typeof contractType ===
                            'string'
                    )
            );

        const implementedStrategies =
            new Set(
                getImplementedStrategies()
            );

        return getAutomatedCapabilities(
            symbol
        )
            .filter(capability =>
                implementedStrategies.has(
                    capability.strategy
                )
            )
            .map(capability => {
                const supportedTypes =
                    capability.contractTypes.filter(
                        contractType =>
                            availableContractTypes.has(
                                contractType
                            )
                    );

                return {
                    ...capability,

                    contractTypes:
                        supportedTypes,

                    available:
                        supportedTypes.length >
                        0,
                };
            })
            .filter(
                capability =>
                    capability.available
            );
    }
}

export const automatedCapabilitiesService =
    new AutomatedCapabilitiesService();

export default automatedCapabilitiesService;