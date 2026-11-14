export type TSignalTick = { digit: number; price: number };
export type TSignalFamily = 'parity' | 'direction' | 'match' | 'barrier';
export type TSignalChoice = 'first' | 'second' | 'same' | 'opposite' | 'alternate' | 'random';
export type TDigitChoice = 'fixed' | 'rarest' | 'frequent' | 'random';
export type TCondition = 'always' | 'streak' | 'frequency' | 'pattern';
export type TWatch =
    | 'even'
    | 'odd'
    | 'rise'
    | 'fall'
    | 'digit'
    | 'over'
    | 'under'
    | 'selected'
    | 'different'
    | 'different_digit';
export type TComparison = 'minimum' | 'maximum' | 'range';

export type TSignalSettings = {
    family: TSignalFamily;
    choice: TSignalChoice;
    digitChoice: TDigitChoice;
    digit: number;
    condition: TCondition;
    watch: TWatch;
    watchDigit: number;
    target: number;
    pattern: string;
    comparison: TComparison;
    upper: number;
    negate: boolean;
    memory: number;
};

export const signalContracts = {
    parity: ['DIGITEVEN', 'DIGITODD'],
    direction: ['CALL', 'PUT'],
    match: ['DIGITMATCH', 'DIGITDIFF'],
    barrier: ['DIGITOVER', 'DIGITUNDER'],
} as const;

const digits = Array.from({ length: 10 }, (_, digit) => digit);

export const signalDigits = (family: TSignalFamily, choice: TSignalChoice) =>
    digits.filter(
        digit => family !== 'barrier' || ((digit > 0 || choice === 'first') && (digit < 9 || choice === 'second'))
    );

const direction = (tick: TSignalTick, previous?: TSignalTick) => {
    if (!previous || tick.price === previous.price) return undefined;
    return tick.price > previous.price ? 'rise' : 'fall';
};

const watchMatches = (watch: TWatch, tick: TSignalTick, previous: TSignalTick | undefined, digit: number) => {
    switch (watch) {
        case 'even':
            return tick.digit % 2 === 0;
        case 'odd':
            return tick.digit % 2 === 1;
        case 'rise':
        case 'fall':
            return direction(tick, previous) === watch;
        case 'digit':
        case 'selected':
            return tick.digit === digit;
        case 'different_digit':
        case 'different':
            return tick.digit !== digit;
        case 'over':
            return tick.digit > digit;
        case 'under':
            return tick.digit < digit;
    }
};

export const evaluateSignalRule = (ticks: TSignalTick[], settings: TSignalSettings, completed = 0) => {
    const { family, choice, digitChoice, digit, condition, watch, watchDigit, target, pattern } = settings;
    const last = ticks.at(-1);
    const previous = ticks.at(-2);
    const contracts = signalContracts[family];
    let sides: readonly string[] = contracts;
    if (choice === 'first' || choice === 'second' || choice === 'alternate') {
        const index = choice === 'alternate' ? completed % 2 : choice === 'first' ? 0 : 1;
        sides = [contracts[index]];
    }
    if (choice === 'same' || choice === 'opposite') {
        const observed =
            family === 'direction' && last
                ? direction(last, previous)
                : last && (last.digit % 2 === 0 ? 'even' : 'odd');
        const followsFirst = observed === 'rise' || observed === 'even';
        sides = observed ? [contracts[Number((choice === 'same') !== followsFirst)]] : [];
    }
    let candidates = sides;
    if (family === 'barrier') {
        candidates = signalDigits(family, choice).includes(digit) ? sides.map(side => `${side}:${digit}`) : [];
    }
    if (family === 'match') {
        let selected = [digit];
        if (digitChoice === 'random') selected = digits;
        if (digitChoice === 'rarest' || digitChoice === 'frequent') {
            const counts = digits.map(value => ticks.slice(-20).filter(tick => tick.digit === value).length);
            const extreme = digitChoice === 'rarest' ? Math.min(...counts) : Math.max(...counts);
            selected = ticks.length >= 20 ? [counts.indexOf(extreme)] : [];
        }
        candidates = sides.flatMap(side => selected.map(value => `${side}:${value}`));
    }

    const startAt = Number(watch === 'rise' || watch === 'fall');
    const eligible = Math.max(0, ticks.length - startAt);
    const observedDigit =
        watch === 'selected' || watch === 'different' ? Number(candidates[0]?.split(':')[1] ?? NaN) : watchDigit;
    const matches = (index: number) => watchMatches(watch, ticks[index], ticks[index - 1], observedDigit);
    const measure = (end: number) => {
        let reading = 0;
        let available = false;
        if (condition === 'streak') {
            available = end - startAt >= target;
            for (let index = end - 1; index >= Math.max(startAt, end - 20) && matches(index); index--) reading++;
        }
        if (condition === 'frequency') {
            available = end - startAt >= 20;
            for (let index = Math.max(startAt, end - 20); index < end; index++) {
                if (matches(index)) reading += 5;
            }
        }
        if (condition === 'pattern') {
            available = /^[0-9]{1,20}$/.test(pattern) && end >= pattern.length;
            reading = Number(
                available &&
                    ticks
                        .slice(end - pattern.length, end)
                        .map(tick => tick.digit)
                        .join('') === pattern
            );
        }
        const holds =
            condition === 'pattern'
                ? reading === 1
                : condition === 'frequency' && settings.comparison === 'maximum'
                  ? reading <= target
                  : reading >= target &&
                    (condition !== 'frequency' || settings.comparison !== 'range' || reading <= settings.upper);
        return { reading, ready: available && holds !== settings.negate };
    };
    const { reading } = measure(ticks.length);
    const conditionReady =
        condition === 'always' ||
        (Number.isFinite(observedDigit) &&
            Array.from(
                { length: Math.min(settings.memory, ticks.length) },
                (_, offset) => measure(ticks.length - offset).ready
            ).some(Boolean));
    const ready = !!last && candidates.length > 0 && conditionReady;
    return { candidates, reading, eligible, ready };
};
