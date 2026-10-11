import { CONTRACT_TYPES } from '@deriv/shared';

import type {
    AutomatedSignal,
    AutomatedTick,
    ContractDirection,
} from '../types/automated-trading.types';

const getDigit = (
    tick: AutomatedTick
): number | null => {
    const raw =
        tick.quoteString ??
        String(tick.quote);

    const pipSize = Number.isFinite(
        tick.pipSize
    )
        ? Number(tick.pipSize)
        : raw.includes('.')
        ? raw.split('.')[1].length
        : 0;

    if (
        !Number.isFinite(tick.quote) ||
        pipSize < 0
    ) {
        return null;
    }

    const fixed =
        tick.quote.toFixed(pipSize);

    const digits =
        fixed.replace(/\D/g, '');

    const digit = Number(
        digits.slice(-1)
    );

    return Number.isInteger(digit)
        ? digit
        : null;
};

export const getLastDigit =
    getDigit;

export type OverUnderStrategyOptions =
    {
        lookback?: number;
        minConfidence?: number;
        barrier?: number;
        direction?:
            | 'AUTO'
            | 'OVER'
            | 'UNDER';
    };

export class OverUnderStrategy {
    private readonly lookback: number;

    private readonly minConfidence: number;

    private readonly barrier?: number;

    private readonly direction:
        | 'AUTO'
        | 'OVER'
        | 'UNDER';

    constructor(
        options: OverUnderStrategyOptions = {}
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
            .map(getDigit)
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

        const average =
            digits.reduce(
                (sum, digit) =>
                    sum + digit,
                0
            ) / digits.length;

        const variance =
            digits.reduce(
                (sum, digit) =>
                    sum +
                    Math.abs(
                        digit -
                            average
                    ),
                0
            ) / digits.length;

        if (variance < 1.2) {
            return null;
        }

        let direction:
            | 'OVER'
            | 'UNDER';

        if (
            this.direction ===
            'AUTO'
        ) {
            direction =
                average >= 4.5
                    ? 'OVER'
                    : 'UNDER';
        } else {
            direction =
                this.direction;
        }

        const barrier =
            this.barrier ??
            (direction ===
            'OVER'
                ? 4
                : 5);

        if (
            barrier < 0 ||
            barrier > 9 ||
            !Number.isInteger(
                barrier
            )
        ) {
            return null;
        }

        const favourable =
            direction === 'OVER'
                ? digits.filter(
                      digit =>
                          digit >
                          barrier
                  ).length
                : digits.filter(
                      digit =>
                          digit <
                          barrier
                  ).length;

        const confidence =
            favourable /
            digits.length;

        if (
            confidence <
            this.minConfidence
        ) {
            return null;
        }

        const contractType =
            direction === 'OVER'
                ? CONTRACT_TYPES
                      .OVER_UNDER
                      .OVER
                : CONTRACT_TYPES
                      .OVER_UNDER
                      .UNDER;

        const latest =
            usable[
                usable.length - 1
            ];

        return {
            strategy:
                'OVER_UNDER',

            contractType,

            direction:
                direction as ContractDirection,

            barrier,

            confidence,

            reason: `${direction} ${barrier}: ${favourable}/${digits.length} recent digits satisfy the condition`,

            sourceEpoch:
                latest.epoch,
        };
    }
}

export default OverUnderStrategy;