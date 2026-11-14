export const TICK_INSIGHTS_FEATURE = 'tick-insights';
export const TICK_SAMPLE_SIZE = 400;

const toNumber = value =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
const positive = value => Number.isFinite(value) && value > 0;

const compareWindows = (prices, ticks, wins, continuous = false) => {
    const sample = (start, end) => {
        const outcomes = [];
        for (let entry = start; entry + ticks < end; entry += ticks) {
            outcomes.push(wins(entry, entry + ticks));
        }
        return outcomes;
    };
    const middle = Math.floor(prices.length / 2);
    const older = sample(0, middle);
    const recent = sample(middle, prices.length);
    const outcomes = continuous ? sample(0, prices.length) : [...older, ...recent];
    const summarize = trials => ({ hits: trials.filter(Boolean).length, count: trials.length });
    let winStreak = 0;
    let lossStreak = 0;
    let maxWins = 0;
    let maxLosses = 0;
    for (const win of outcomes) {
        winStreak = win ? winStreak + 1 : 0;
        lossStreak = win ? 0 : lossStreak + 1;
        maxWins = Math.max(maxWins, winStreak);
        maxLosses = Math.max(maxLosses, lossStreak);
    }
    return {
        older: summarize(older),
        recent: summarize(recent),
        historical: summarize(outcomes),
        outcomes,
        maxWins,
        maxLosses,
    };
};

const readAccumulatorRange = proposal => {
    const details = proposal.contract_details;
    const spot = toNumber(proposal.spot);
    const low = toNumber(details?.low_barrier);
    const high = toNumber(details?.high_barrier);
    if (positive(spot) && positive(low) && low < spot && high > spot && Number.isFinite(high)) {
        return { lower: (low - spot) / spot, upper: (high - spot) / spot };
    }

    const quotedPercentage = details?.tick_size_barrier_percentage;
    const percentage = typeof quotedPercentage === 'string' ? /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(quotedPercentage) : null;
    const width = percentage ? Number(percentage[1]) / 100 : NaN;
    return positive(width) && width < 1 ? { lower: -width, upper: width } : null;
};

const accumulatorOutcome = (prices, ticks, growth, stake, proposal, continuous) => {
    const range = readAccumulatorRange(proposal);
    const details = proposal.contract_details;
    const maxTicks = toNumber(details?.maximum_ticks);
    const maxPayout = toNumber(details?.maximum_payout);
    const payout = stake * (1 + growth / 100) ** ticks;
    if (!range || !Number.isInteger(maxTicks) || maxTicks < ticks || !positive(maxPayout) || payout > maxPayout) {
        return null;
    }

    const result = compareWindows(
        prices,
        ticks,
        (entry, exit) => {
            for (let index = entry; index < exit; index++) {
                const change = (prices[index + 1] - prices[index]) / prices[index];
                if (change <= range.lower || change >= range.upper) return false;
            }
            return true;
        },
        continuous
    );

    return { ...result, payout, estimated: true };
};

export const analyzeTickInsights = input => {
    const {
        prices: rawPrices,
        times: rawTimes,
        ticks,
        precision,
        quotes,
        family,
        currency,
        windowSize,
        candidate: selectedCandidate,
        candidates: selectedCandidates,
        historyOnly = false,
    } = input ?? {};
    const sampleSize = windowSize ?? TICK_SAMPLE_SIZE;
    if (
        !Array.isArray(rawPrices) ||
        ![20, 100, TICK_SAMPLE_SIZE].includes(sampleSize) ||
        rawPrices.length !== sampleSize ||
        !Array.isArray(rawTimes) ||
        rawTimes.length !== sampleSize ||
        !Number.isInteger(ticks) ||
        ticks < 1 ||
        ticks > 20 ||
        !['digital', 'accumulator'].includes(family) ||
        typeof currency !== 'string' ||
        !/^[A-Z]{3}$/.test(currency) ||
        (!historyOnly && (!quotes || typeof quotes !== 'object')) ||
        (historyOnly && family !== 'digital')
    )
        return null;

    const prices = rawPrices.map(toNumber);
    const times = rawTimes.map(toNumber);
    if (
        !prices.every(positive) ||
        !times.every((time, i) => Number.isSafeInteger(time) && time > 0 && (i === 0 || time >= times[i - 1]))
    ) {
        return null;
    }

    const usableDigits = Number.isInteger(precision) && precision >= 0 && precision <= 10;
    const digits = usableDigits ? prices.map(price => Number(price.toFixed(precision).slice(-1))) : [];
    const candidates = family === 'accumulator' ? ['1', '2', '3', '4', '5'] : ['CALL', 'PUT', 'DIGITEVEN', 'DIGITODD'];
    const outcomes = {
        CALL: (entry, exit) => prices[exit] > prices[entry],
        PUT: (entry, exit) => prices[exit] < prices[entry],
        DIGITEVEN: (_entry, exit) => digits[exit] % 2 === 0,
        DIGITODD: (_entry, exit) => digits[exit] % 2 === 1,
    };
    for (let digit = 0; digit <= 9; digit++) {
        if (digit < 9) outcomes[`DIGITOVER:${digit}`] = (_entry, exit) => digits[exit] > digit;
        if (digit > 0) outcomes[`DIGITUNDER:${digit}`] = (_entry, exit) => digits[exit] < digit;
        outcomes[`DIGITMATCH:${digit}`] = (_entry, exit) => digits[exit] === digit;
        outcomes[`DIGITDIFF:${digit}`] = (_entry, exit) => digits[exit] !== digit;
    }
    const available = family === 'accumulator' ? candidates : Object.keys(outcomes);
    if (selectedCandidate !== undefined && !available.includes(selectedCandidate)) return null;
    if (
        selectedCandidates !== undefined &&
        (!Array.isArray(selectedCandidates) ||
            selectedCandidates.length > 8 ||
            !selectedCandidates.every(value => available.includes(value)))
    )
        return null;

    const rows = [];
    for (const candidate of new Set(
        selectedCandidate === undefined ? (selectedCandidates ?? candidates) : [selectedCandidate]
    )) {
        if (historyOnly) {
            if (!usableDigits && candidate.startsWith('DIGIT')) continue;
            const { outcomes: _outcomes, ...statistics } = compareWindows(prices, ticks, outcomes[candidate], true);
            rows.push({ candidate, ...statistics });
            continue;
        }
        const proposal = quotes[candidate];
        const stake = toNumber(proposal?.ask_price);
        if (!positive(stake)) continue;
        if (family === 'accumulator') {
            const result = accumulatorOutcome(
                prices,
                ticks,
                Number(candidate),
                stake,
                proposal,
                windowSize !== undefined
            );
            if (result) rows.push({ candidate, stake, ...result });
            continue;
        }

        const payout = toNumber(proposal?.payout);
        if (!positive(payout) || payout <= stake || (!usableDigits && candidate.startsWith('DIGIT'))) continue;
        rows.push({
            candidate,
            stake,
            payout,
            estimated: false,
            breakEven: stake / payout,
            ...compareWindows(prices, ticks, outcomes[candidate], windowSize !== undefined),
        });
    }
    rows.sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
    return {
        currency,
        ticks,
        firstTick: times[0],
        lastTick: times.at(-1),
        rows: historyOnly
            ? rows
            : rows.map(row => {
                  const totalStaked = row.historical.count * row.stake;
                  const estimatedNet = row.historical.hits * row.payout - totalStaked;
                  return {
                      ...row,
                      totalStaked,
                      estimatedNet,
                      returnOnStake: totalStaked ? estimatedNet / totalStaked : null,
                  };
              }),
    };
};
