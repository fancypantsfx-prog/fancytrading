import type {
    AutomatedSignal,
    AutomatedTick,
} from '../types/automated-trading.types';

import { getLastDigit } from './over-under.strategy';

export type EvenOddStrategyOptions = {
    lookback?: number;
    minConfidence?: number;
    direction?:
        | 'AUTO'
        | 'EVEN'
        | 'ODD';
};

export class EvenOddStrategy {
    private readonly lookback: number;

    private readonly minConfidence: number;

    private readonly direction:
        | 'AUTO'
        | 'EVEN'
        | 'ODD';

    constructor(
        options: EvenOddStrategyOptions = {}
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

        const evenCount =
            digits.filter(
                digit =>
                    digit % 2 === 0
            ).length;

        const oddCount =
            digits.length -
            evenCount;

        const evenConfidence =
            evenCount /
            digits.length;

        const oddConfidence =
            oddCount /
            digits.length;

        let direction:
            | 'EVEN'
            | 'ODD';

        if (
            this.direction ===
            'AUTO'
        ) {
            direction =
                evenConfidence >=
                oddConfidence
                    ? 'EVEN'
                    : 'ODD';
        } else {
            direction =
                this.direction;
        }

        const confidence =
            direction === 'EVEN'
                ? evenConfidence
                : oddConfidence;

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

        const contractType =
            direction === 'EVEN'
                ? 'DIGITEVEN'
                : 'DIGITODD';

        const favourable =
            direction === 'EVEN'
                ? evenCount
                : oddCount;

        return {
            strategy:
                'EVEN_ODD',

            contractType,

            direction,

            confidence,

            reason: `${direction}: ${favourable}/${digits.length} recent digits satisfy the condition`,

            sourceEpoch:
                latest.epoch,
        };
    }
}

export default EvenOddStrategy;