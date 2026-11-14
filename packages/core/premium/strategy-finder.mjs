export const SCAN_CACHE_KEY = 'strategy-finder:history:v1';
export const SCAN_MAX_AGE_MS = 30 * 60 * 1000;

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
