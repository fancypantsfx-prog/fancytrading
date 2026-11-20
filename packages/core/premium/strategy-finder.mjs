export const SCAN_CACHE_KEY = 'strategy-finder:history:v1';
export const CONTRACT_LIST_MAX_AGE_MS = 10 * 60 * 1000;

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

const tickDuration = value => Number(/^(\d+)t$/i.exec(value ?? '')?.[1]);
const supportedTypes = new Set(Object.values(finderContracts).flat());

export const finderTickContracts = contracts =>
    contracts.flatMap(contract => {
        const { contract_type: type, start_type: start, contract_category: category } = contract;
        const minimum = tickDuration(contract.min_contract_duration);
        const maximum = tickDuration(contract.max_contract_duration);
        const barrierRiseFall = Number(contract.barriers) > 0 && finderContracts.rise_fall.includes(type);
        if (
            (start && start !== 'spot') ||
            category === 'higherlower' ||
            barrierRiseFall ||
            !supportedTypes.has(type) ||
            !(minimum >= 0 && maximum >= Math.max(minimum, 1))
        ) return [];
        return [{ type, minimum, maximum }];
    });

export const finderSupportsDuration = (contracts, candidate, ticks) =>
    contracts?.some(({ type, minimum, maximum }) =>
        type === candidate.split(':')[0] && ticks >= minimum && ticks <= maximum
    ) ?? false;

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

export const finderRankingKey = (group, ticks, barrier) =>
    [group, ticks, ['over_under', 'match_diff'].includes(group) ? barrier : ''].join('/');

export const prepareFinderRankings = (markets, listings, now) => {
    const rankings = {};
    for (const group of Object.keys(finderContracts)) {
        const barriers = ['over_under', 'match_diff'].includes(group) ? Array.from({ length: 10 }, (_, i) => i) : [0];
        for (let ticks = 1; ticks <= 20; ticks++) {
            for (const barrier of barriers) {
                const rows = [];
                const candidates = finderCandidates(group, barrier);
                for (const market of markets) {
                    const listing = listings.get(market.symbol);
                    const summary = market.summaries?.[ticks - 1];
                    if (!summary || !market.groups.includes(group) || !(listing?.checkedAt + CONTRACT_LIST_MAX_AGE_MS > now)) continue;
                    for (const candidate of candidates) {
                        if (!finderSupportsDuration(listing.contracts, candidate, ticks)) continue;
                        const historical = finderHistorical(summary, candidate);
                        if (historical) rows.push({ symbol: market.symbol, label: market.label, candidate, historical, sampleAt: market.lastTick * 1000 });
                    }
                }
                rows.sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
                rankings[finderRankingKey(group, ticks, barrier)] = rows;
            }
        }
    }
    return rankings;
};
