import {
    getContractTypesConfig,
    TRADE_TYPES,
} from '@deriv/shared';

import type {
    AutomatedContractCapability,
    AutomatedStrategyType,
} from '../types/automated-trading.types';

type CapabilityDefinition = {
    strategy: AutomatedStrategyType;

    title: string;

    tradeTypes: string[];
};

const CAPABILITY_DEFINITIONS:
    CapabilityDefinition[] = [
        {
            strategy: 'RISE_FALL',

            title: 'Rise / Fall',

            tradeTypes: [
                TRADE_TYPES.RISE_FALL,
            ],
        },

        {
            strategy:
                'RISE_FALL_EQUAL',

            title: 'Rise / Fall Equal',

            tradeTypes: [
                TRADE_TYPES.RISE_FALL_EQUAL,
            ],
        },

        {
            strategy:
                'HIGHER_LOWER',

            title: 'Higher / Lower',

            tradeTypes: [
                TRADE_TYPES.HIGH_LOW,
            ],
        },

        {
            strategy:
                'TOUCH_NO_TOUCH',

            title: 'Touch / No Touch',

            tradeTypes: [
                TRADE_TYPES.TOUCH,
            ],
        },

        {
            strategy:
                'ENDS_IN_OUT',

            title: 'Ends In / Ends Out',

            tradeTypes: [
                TRADE_TYPES.END,
            ],
        },

        {
            strategy:
                'STAYS_IN_OUT',

            title: 'Stays In / Goes Out',

            tradeTypes: [
                TRADE_TYPES.STAY,
            ],
        },

        {
            strategy: 'ASIAN',

            title: 'Asian Up / Asian Down',

            tradeTypes: [
                TRADE_TYPES.ASIAN,
            ],
        },

        {
            strategy:
                'MATCHES_DIFFERS',

            title: 'Matches / Differs',

            tradeTypes: [
                TRADE_TYPES.MATCH_DIFF,
            ],
        },

        {
            strategy: 'EVEN_ODD',

            title: 'Even / Odd',

            tradeTypes: [
                TRADE_TYPES.EVEN_ODD,
            ],
        },

        {
            strategy: 'OVER_UNDER',

            title: 'Over / Under',

            tradeTypes: [
                TRADE_TYPES.OVER_UNDER,
            ],
        },

        {
            strategy: 'LOOKBACK',

            title: 'Lookbacks',

            tradeTypes: [
                TRADE_TYPES.LB_CALL,
                TRADE_TYPES.LB_PUT,
                TRADE_TYPES.LB_HIGH_LOW,
            ],
        },

        {
            strategy:
                'TICK_HIGH_LOW',

            title: 'High Tick / Low Tick',

            tradeTypes: [
                TRADE_TYPES.TICK_HIGH_LOW,
            ],
        },

        {
            strategy:
                'RUN_HIGH_LOW',

            title: 'Only Ups / Only Downs',

            tradeTypes: [
                TRADE_TYPES.RUN_HIGH_LOW,
            ],
        },

        {
            strategy: 'RESET',

            title: 'Reset Up / Reset Down',

            tradeTypes: [
                TRADE_TYPES.RESET,
            ],
        },

        {
            strategy:
                'CALL_PUT_SPREAD',

            title:
                'Spread Up / Spread Down',

            tradeTypes: [
                TRADE_TYPES.CALL_PUT_SPREAD,
            ],
        },

        {
            strategy: 'ACCUMULATOR',

            title: 'Accumulators',

            tradeTypes: [
                TRADE_TYPES.ACCUMULATOR,
            ],
        },

        {
            strategy: 'MULTIPLIER',

            title: 'Multipliers',

            tradeTypes: [
                TRADE_TYPES.MULTIPLIER,
            ],
        },

        {
            strategy: 'TURBOS',

            title: 'Turbos',

            tradeTypes: [
                TRADE_TYPES.TURBOS.LONG,
                TRADE_TYPES.TURBOS.SHORT,
            ],
        },

        {
            strategy: 'VANILLA',

            title: 'Call / Put',

            tradeTypes: [
                TRADE_TYPES.VANILLA.CALL,
                TRADE_TYPES.VANILLA.PUT,
            ],
        },
    ];

export const getAutomatedCapabilities = (
    symbol: string
): AutomatedContractCapability[] => {
    const config =
        getContractTypesConfig(symbol);

    return CAPABILITY_DEFINITIONS.map(
        definition => {
            const contractTypes =
                definition.tradeTypes.flatMap(
                    tradeType => {
                        const tradeConfig =
                            config[
                                tradeType
                            ];

                        return (
                            tradeConfig
                                ?.trade_types ??
                            []
                        );
                    }
                );

            const uniqueContractTypes =
                Array.from(
                    new Set(
                        contractTypes
                    )
                );

            const primaryConfig =
                definition.tradeTypes
                    .map(
                        tradeType =>
                            config[
                                tradeType
                            ]
                    )
                    .find(Boolean);

            return {
                strategy:
                    definition.strategy,

                contractTypes:
                    uniqueContractTypes,

                title:
                    definition.title,

                basis:
                    primaryConfig
                        ?.basis ?? [],

                components:
                    primaryConfig
                        ?.components ?? [],

                barrierCount:
                    primaryConfig
                        ?.barrier_count ??
                    0,

                hideDuration:
                    Boolean(
                        primaryConfig
                            ?.config
                            ?.hide_duration
                    ),

                available:
                    uniqueContractTypes.length >
                    0,
            };
        }
    );
};