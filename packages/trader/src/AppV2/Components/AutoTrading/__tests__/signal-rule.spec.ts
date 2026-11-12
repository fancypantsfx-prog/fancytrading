import { evaluateSignalRule, signalDigits } from '../signal-rule';
import type { TSignalSettings } from '../signal-rule';

const settings: TSignalSettings = {
    family: 'match',
    choice: 'second',
    digitChoice: 'fixed',
    digit: 7,
    condition: 'always',
    watch: 'odd',
    watchDigit: 5,
    target: 4,
    pattern: '007',
    comparison: 'minimum',
    upper: 100,
    negate: false,
    memory: 1,
};

const stream = (digits: number[]) => digits.map(digit => ({ digit, price: digit }));

it('selects fixed, least frequent, most frequent and random digits for Matches or Differs', () => {
    const sample = stream([...Array(18).fill(6), 0, 3]);
    expect(evaluateSignalRule(sample, settings).candidates).toEqual(['DIGITDIFF:7']);
    expect(evaluateSignalRule(sample, { ...settings, digitChoice: 'rarest' }).candidates).toEqual(['DIGITDIFF:1']);
    expect(evaluateSignalRule(sample, { ...settings, digitChoice: 'frequent', choice: 'first' }).candidates).toEqual([
        'DIGITMATCH:6',
    ]);
    expect(
        evaluateSignalRule(sample, { ...settings, digitChoice: 'random', choice: 'random' }).candidates
    ).toHaveLength(20);
    expect(evaluateSignalRule(sample.slice(1), { ...settings, digitChoice: 'rarest' }).ready).toBe(false);
});

it('only allows barriers that can win and alternates on the settled trade count', () => {
    const barrier = { ...settings, family: 'barrier', choice: 'alternate' } as const;
    expect(signalDigits('barrier', 'alternate')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(evaluateSignalRule(stream([4]), barrier).candidates).toEqual(['DIGITOVER:7']);
    expect(evaluateSignalRule(stream([4]), barrier, 1).candidates).toEqual(['DIGITUNDER:7']);
    expect(evaluateSignalRule(stream([4]), { ...barrier, digit: 9 }).ready).toBe(false);
});

it('uses price changes for Rise and Fall and waits for a direction after a tie', () => {
    const rule = { ...settings, family: 'direction', choice: 'same' } as const;
    expect(evaluateSignalRule(stream([9, 1]), rule).candidates).toEqual(['PUT']);
    expect(evaluateSignalRule(stream([9, 1]), { ...rule, choice: 'opposite' }).candidates).toEqual(['CALL']);
    expect(evaluateSignalRule(stream([1, 1]), rule).ready).toBe(false);
});

it('supports a maximum selected-digit frequency, including zero, after the window fills', () => {
    const rule = { ...settings, condition: 'frequency', watch: 'selected', comparison: 'maximum', target: 0 } as const;
    expect(evaluateSignalRule(stream(Array(19).fill(8)), rule).ready).toBe(false);
    expect(evaluateSignalRule(stream(Array(20).fill(8)), rule).ready).toBe(true);
    expect(evaluateSignalRule(stream([...Array(19).fill(8), 7]), rule).ready).toBe(false);
});

it('recognizes an exact digit sequence with leading zeros and checks recent observations', () => {
    const rule = { ...settings, condition: 'pattern', memory: 3 } as const;
    expect(evaluateSignalRule(stream([0, 0, 7, 5, 5]), rule).ready).toBe(true);
    expect(evaluateSignalRule(stream([0, 0, 7, 5, 5, 5]), rule).ready).toBe(false);
    expect(evaluateSignalRule(stream([0, 0]), { ...rule, negate: true }).ready).toBe(false);
});
