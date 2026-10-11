import type {
    AutomatedSignal,
    AutomatedTick,
} from '../types/automated-trading.types';

import { getLastDigit } from './over-under.strategy';

export type MatchesDiffersStrategyOptions =
    {
        lookback?: number;
        minConfidence?: number;
        barrier?: number;
        direction?:
            | 'AUTO'
            | 'MATCH'
            | 'DIFFER';
    };

export class MatchesDiffersStrategy {
    private readonly lookback: number;

    private readonly minConfidence: number;

    private readonly barrier?: number;

    private readonly direction:
        | 'AUTO'
        | 'MATCH'
        | 'DIFFER';

    constructor(
        options: MatchesDiffersStrategyOptions = {}
    ) {
        this.lookback = Math.max(
            5,
            options.lookback ?? 20
        );

        this.minConfidence = Math.min(
            1,
            Math.max(
                0.5,
                options.minConfidence ??
                    0.6
            )
        );

        this.barrier =
            options.barrier;

        this.direction =
            options.direction ??
            'AUTO';
    }

    evaluate(
        ticks: AutomatedTick[]
    ): AutomatedSignal | null {
        const usable = ticks.slice(
            -this.lookback
        );

        if (
            usable.length <
            this.lookback
        ) {
            return null;
        }

        const digits = usable
            .map(getLastDigit)
            .filter(
                (
                    digit
                ): digit is number =>
                    digit !== null
            );

        if (
            digits.length <
            this.lookback
        ) {
            return null;
        }

        const barrier =
            this.barrier ??
            digits[
                digits.length - 1
            ];

        if (
            barrier < 0 ||
            barrier > 9 ||
            !Number.isInteger(
                barrier
            )
        ) {
            return null;
        }

        const matches =
            digits.filter(
                digit =>
                    digit ===
                    barrier
            ).length;

        const differs =
            digits.length -
            matches;

        const matchConfidence =
            matches /
            digits.length;

        const differConfidence =
            differs /
            digits.length;

        let direction:
            | 'MATCH'
            | 'DIFFER';

        if (
            this.direction ===
            'AUTO'
        ) {
            direction =
                matchConfidence >=
                differConfidence
                    ? 'MATCH'
                    : 'DIFFER';
        } else {
            direction =
                this.direction;
        }

        const confidence =
            direction === 'MATCH'
                ? matchConfidence
                : differConfidence;

        if (
            confidence <
            this.minConfidence
        ) {
            return null;
        }

        const latest =
            usable[
                usable.length - 1
            ];

        return {
            strategy:
                'MATCHES_DIFFERS',

            contractType:
                direction === 'MATCH'
                    ? 'DIGITMATCH'
                    : 'DIGITDIFF',

            direction,

            barrier,

            confidence,

            reason:
                direction === 'MATCH'
                    ? `MATCH ${barrier}: ${matches}/${digits.length} recent digits matched the barrier`
                    : `DIFFER ${barrier}: ${differs}/${digits.length} recent digits differed from the barrier`,

            sourceEpoch:
                latest.epoch,
        };
    }
}

export default MatchesDiffersStrategy;