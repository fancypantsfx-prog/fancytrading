import OverUnderStrategy from './over-under.strategy';
import EvenOddStrategy from './even-odd.strategy';
import MatchesDiffersStrategy from './matches-differs.strategy';

import type {
    AutomatedSignal,
    AutomatedStrategyType,
    AutomatedTick,
    AutomatedTradeConfig,
} from '../types/automated-trading.types';

export interface AutomatedStrategy {
    evaluate(
        ticks: AutomatedTick[]
    ): AutomatedSignal | null;
}

type StrategyBuilder = (
    config: AutomatedTradeConfig
) => AutomatedStrategy;

const STRATEGY_BUILDERS: Partial<
    Record<
        AutomatedStrategyType,
        StrategyBuilder
    >
> = {
    OVER_UNDER: config =>
        new OverUnderStrategy({
            lookback:
                config.lookback,

            minConfidence:
                config.minConfidence,

            barrier:
                config.barrier,

            direction:
                config.direction ===
                    'OVER' ||
                config.direction ===
                    'UNDER'
                    ? config.direction
                    : 'AUTO',
        }),

    EVEN_ODD: config =>
        new EvenOddStrategy({
            lookback:
                config.lookback,

            minConfidence:
                config.minConfidence,

            direction:
                config.direction ===
                    'EVEN' ||
                config.direction ===
                    'ODD'
                    ? config.direction
                    : 'AUTO',
        }),

    MATCHES_DIFFERS: config =>
        new MatchesDiffersStrategy({
            lookback:
                config.lookback,

            minConfidence:
                config.minConfidence,

            barrier:
                config.barrier,

            direction:
                config.direction ===
                    'MATCH' ||
                config.direction ===
                    'DIFFER'
                    ? config.direction
                    : 'AUTO',
        }),
};

export const createAutomatedStrategy = (
    strategy:
        | AutomatedStrategyType
        | undefined,
    config: AutomatedTradeConfig
): AutomatedStrategy => {
    if (!strategy) {
        throw new Error(
            'No automation strategy selected.'
        );
    }

    const builder =
        STRATEGY_BUILDERS[strategy];

    if (!builder) {
        throw new Error(
            `Automation strategy "${strategy}" is not implemented yet.`
        );
    }

    return builder(config);
};

export const getImplementedStrategies =
    (): AutomatedStrategyType[] =>
        Object.keys(
            STRATEGY_BUILDERS
        ) as AutomatedStrategyType[];

export const isStrategyImplemented = (
    strategy: AutomatedStrategyType
) =>
    Boolean(
        STRATEGY_BUILDERS[strategy]
    );

export default createAutomatedStrategy;