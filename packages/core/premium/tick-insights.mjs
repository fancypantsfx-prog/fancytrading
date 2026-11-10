export const TICK_INSIGHTS_FEATURE = 'tick-insights';
export const TICK_SAMPLE_SIZE = 400;

const toNumber = value =>
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '') ? Number(value) : NaN;
const positive = value => Number.isFinite(value) && value > 0;

const compareWindows = (prices, ticks, wins) => {
    const sample = (start, end) => {
        let hits = 0;
        let count = 0;
        for (let entry = start; entry + ticks < end; entry += ticks) {
            if (wins(entry, entry + ticks)) hits++;
            count++;
        }
        return { hits, count };
    };
    const middle = prices.length / 2;
    const older = sample(0, middle);
    const recent = sample(middle, prices.length);
    return {
        older,
        recent,
        historical: { hits: older.hits + recent.hits, count: older.count + recent.count },
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

const accumulatorOutcome = (prices, ticks, growth, stake, proposal) => {
    const range = readAccumulatorRange(proposal);
    const details = proposal.contract_details;
    const maxTicks = toNumber(details?.maximum_ticks);
    const maxPayout = toNumber(details?.maximum_payout);
    const payout = stake * (1 + growth / 100) ** ticks;
    if (!range || !Number.isInteger(maxTicks) || maxTicks < ticks || !positive(maxPayout) || payout > maxPayout) {
        return null;
    }

    const result = compareWindows(prices, ticks, (entry, exit) => {
        for (let index = entry; index < exit; index++) {
            const change = (prices[index + 1] - prices[index]) / prices[index];
            if (change <= range.lower || change >= range.upper) return false;
        }
        return true;
    });

    return { ...result, payout, estimated: true };
};

export const analyzeTickInsights = input => {
    const { prices: rawPrices, times: rawTimes, ticks, precision, quotes, family, currency } = input ?? {};
    if (
        !Array.isArray(rawPrices) ||
        rawPrices.length !== TICK_SAMPLE_SIZE ||
        !Array.isArray(rawTimes) ||
        rawTimes.length !== TICK_SAMPLE_SIZE ||
        !Number.isInteger(ticks) ||
        ticks < 1 ||
        ticks > 20 ||
        !['digital', 'accumulator'].includes(family) ||
        typeof currency !== 'string' ||
        !/^[A-Z]{3}$/.test(currency) ||
        !quotes ||
        typeof quotes !== 'object'
    )
        return null;

    const prices = rawPrices.map(toNumber);
    const times = rawTimes.map(toNumber);
    if (
        !prices.every(positive) ||
        !times.every((time, i) => Number.isSafeInteger(time) && time > (times[i - 1] ?? 0))
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

    const rows = [];
    for (const candidate of candidates) {
        const proposal = quotes[candidate];
        const stake = toNumber(proposal?.ask_price);
        if (!positive(stake)) continue;
        if (family === 'accumulator') {
            const result = accumulatorOutcome(prices, ticks, Number(candidate), stake, proposal);
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
            ...compareWindows(prices, ticks, outcomes[candidate]),
        });
    }
    rows.sort((a, b) => b.historical.hits / b.historical.count - a.historical.hits / a.historical.count);
    return { currency, ticks, firstTick: times[0], lastTick: times.at(-1), rows };
};
