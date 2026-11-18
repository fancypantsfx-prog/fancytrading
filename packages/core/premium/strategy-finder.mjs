export const SCAN_CACHE_KEY = 'strategy-finder:history:v1';
export const SCAN_STALE_AFTER_MS = 3 * 60 * 1000;

export const finderSampleExpiry = ({ lastTick, times, collectedAt }) =>
    Math.min((lastTick ?? times?.at(-1)) * 1000, collectedAt) + SCAN_STALE_AFTER_MS;

export const finderContracts = {
    rise_fall: ['CALL', 'PUT'],
    even_odd: ['DIGITEVEN', 'DIGITODD'],
    over_under: ['DIGITOVER', 'DIGITUNDER'],
    match_diff: ['DIGITMATCH', 'DIGITDIFF'],
};

export const finderCandidates = (contract, barrier) => {
    const types = Object.hasOwn(finderContracts, contract) ? finderContracts[contract] : undefined;
    if (!types) return [];
    if (contract === 'rise_fall' || contract === 'even_odd') return types;
    if (!Number.isInteger(barrier) || barrier < 0 || barrier > 9) return [];
    return types
        .filter(type => !(type === 'DIGITOVER' && barrier === 9) && !(type === 'DIGITUNDER' && barrier === 0))
        .map(type => `${type}:${barrier}`);
};

// Store one compact summary per duration. Digit counts serve both barrier and match contracts.
export const summarizeFinderMarket = ({ prices, times, precision }) => {
    if (prices.length !== 400 || times.length !== prices.length) return undefined;
    const values = prices.map(Number);
    if (values.some(value => !Number.isFinite(value) || value <= 0)) return undefined;
    const digits =
        Number.isInteger(precision) && precision >= 0 && precision <= 10
            ? values.map(value => Number(value.toFixed(precision).slice(-1)))
            : undefined;
    return Array.from({ length: 20 }, (_, index) => {
        const duration = index + 1;
        let rise = 0;
        let fall = 0;
        let count = 0;
        const histogram = digits ? Array(10).fill(0) : null;
        for (let exit = duration; exit < values.length; exit += duration) {
            if (values[exit] > values[exit - duration]) rise++;
            if (values[exit] < values[exit - duration]) fall++;
            if (histogram) histogram[digits[exit]]++;
            count++;
        }
        return { count, rise, fall, histogram };
    });
};

export const finderHistorical = ({ count, rise, fall, histogram }, candidate) => {
    if (candidate === 'CALL') return { hits: rise, count };
    if (candidate === 'PUT') return { hits: fall, count };
    if (!histogram) return undefined;
    const [type, value] = candidate.split(':');
    const digit = Number(value);
    let hits;
    switch (type) {
        case 'DIGITEVEN':
            hits = histogram.reduce((sum, frequency, index) => (index % 2 === 0 ? sum + frequency : sum), 0);
            break;
        case 'DIGITODD':
            hits = histogram.reduce((sum, frequency, index) => (index % 2 === 1 ? sum + frequency : sum), 0);
            break;
        case 'DIGITOVER':
            hits = histogram.slice(digit + 1).reduce((sum, frequency) => sum + frequency, 0);
            break;
        case 'DIGITUNDER':
            hits = histogram.slice(0, digit).reduce((sum, frequency) => sum + frequency, 0);
            break;
        case 'DIGITMATCH':
            hits = histogram[digit];
            break;
        case 'DIGITDIFF':
            hits = count - histogram[digit];
            break;
    }
    return { hits, count };
};
