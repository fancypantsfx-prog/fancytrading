import { fetchStrategyFinder } from '@deriv/api';
import { compareRecentTicks, IncompleteInsightHistory } from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

export const rankedTradeKey = ({ symbol, candidate, ticks }: Pick<TInsightTrade, 'symbol' | 'candidate' | 'ticks'>) =>
    JSON.stringify([symbol, candidate, ticks]);

type Row = { symbol: string; candidate: string; historical: { hits: number; count: number }; sampleAt: number };
export type RankedQuote = {
    trade: TInsightTrade;
    expectedPayout: number;
    adjustedNet: number | null;
    rate: number;
    time: number;
};
export type RankingMethod = 'adjusted' | 'standard';

export const rankQuotes = (quotes: RankedQuote[], method: RankingMethod) =>
    [...quotes].sort((a, b) =>
        method === 'standard'
            ? b.expectedPayout - a.expectedPayout || b.rate - a.rate
            : (b.adjustedNet ?? -Infinity) - (a.adjustedNet ?? -Infinity) || b.expectedPayout - a.expectedPayout
    );

export const qualifies = (quote: RankedQuote, method: RankingMethod) =>
    method === 'standard' || (quote.adjustedNet !== null && quote.adjustedNet > 0);

const minimumWindowSize = 50;
const lowerWinRate = ({ hits, count }: Row['historical']) => {
    const rate = hits / count;
    // One-sided 95% Wilson lower bound for a binomial proportion.
    const z = 1.6448536269514722;
    const adjustment = (z * z) / count;
    return (rate + adjustment / 2 - z * Math.sqrt((rate * (1 - rate) + adjustment / 4) / count)) / (1 + adjustment);
};
const validWindow = (sample?: Row['historical']): sample is Row['historical'] =>
    !!sample &&
    Number.isInteger(sample.count) &&
    sample.count >= minimumWindowSize &&
    Number.isInteger(sample.hits) &&
    sample.hits >= 0 &&
    sample.hits <= sample.count;
export const fresh = (time: number) => time <= Date.now() && time >= Date.now() - 180000;
const contractsByGroup = {
    rise_fall: ['CALL', 'PUT'],
    even_odd: ['DIGITEVEN', 'DIGITODD'],
    over_under: ['DIGITOVER:5', 'DIGITUNDER:5'],
    match_diff: ['DIGITMATCH:5', 'DIGITDIFF:5'],
};
const durations = [1, 3];

export async function selectRankedTrade(
    send: Parameters<typeof compareRecentTicks>[0],
    currency: string,
    stake: number,
    signal: AbortSignal,
    skipped?: ReadonlySet<string>,
    onCompared?: (quotes: RankedQuote[]) => void,
    fallbackSymbol?: string,
    method: RankingMethod = 'adjusted'
) {
    const shortlists = await Promise.all(
        durations.flatMap(ticks =>
            Object.keys(contractsByGroup).map(async contract => {
                const settings = new URLSearchParams({ contract, ticks: String(ticks), barrier: '5' });
                const scan = await fetchStrategyFinder<{ rows: Row[] }>(settings, signal);
                if (!scan) throw new Error('Strategy Finder access is required.');
                return scan.rows
                    .filter(row => row.historical.count > 0 && !skipped?.has(rankedTradeKey({ ...row, ticks })))
                    .sort((a, b) => Number(fresh(b.sampleAt)) - Number(fresh(a.sampleAt)))
                    .slice(0, 2)
                    .map(row => ({ ...row, ticks }));
            })
        )
    );
    const setups = new Map<string, { symbol: string; ticks: number; contracts: string[] }>();
    for (const { symbol, ticks, candidate } of shortlists.flat()) {
        const key = JSON.stringify([symbol, ticks]);
        const existing = setups.get(key);
        if (existing) existing.contracts.push(candidate);
        else setups.set(key, { symbol, ticks, contracts: [candidate] });
    }

    const quotes: RankedQuote[] = [];
    const checked = new Set<string>();
    const cache: NonNullable<Parameters<typeof compareRecentTicks>[3]> = new Map();
    const compare = async (symbol: string, ticks: number, contracts: string[]) => {
        if (signal.aborted) return;
        const available = contracts.filter(candidate => {
            const key = rankedTradeKey({ symbol, ticks, candidate });
            if (checked.has(key) || skipped?.has(key)) return false;
            checked.add(key);
            return true;
        });
        if (!available.length) return;
        const setup = { family: 'digital' as const, currency, stake, ticks, symbol };
        const result = await compareRecentTicks(send, { ...setup, candidates: available }, signal, cache).catch(
            error => {
                if (error instanceof IncompleteInsightHistory) return null;
                throw error;
            }
        );
        if (!result || signal.aborted) return;
        const time = Number(result.lastTick) * 1000;
        if (!fresh(time)) return;
        for (const row of result.rows) {
            if (!available.includes(row.candidate) || row.estimated || row.stake !== stake || row.historical.count < 1)
                continue;
            const rate = row.historical.hits / row.historical.count;
            const adjustedNet =
                validWindow(row.older) && validWindow(row.recent)
                    ? Math.min(lowerWinRate(row.older), lowerWinRate(row.recent)) * row.payout - stake
                    : null;
            const expectedPayout = rate * row.payout;
            if (rate >= 0 && rate <= 1 && Number.isFinite(expectedPayout) && row.payout > stake) {
                quotes.push({
                    trade: { ...setup, candidate: row.candidate, payout: row.payout },
                    rate,
                    expectedPayout,
                    adjustedNet,
                    time,
                });
            }
        }
    };

    // The shared insights queue still paces Deriv requests across concurrent comparisons.
    const compareSetups = async (batch: Iterable<{ symbol: string; ticks: number; contracts: string[] }>) => {
        const results = await Promise.allSettled(
            Array.from(batch, ({ symbol, ticks, contracts }) => compare(symbol, ticks, contracts))
        );
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
    };

    await compareSetups(setups.values());
    if (fallbackSymbol && !quotes.some(quote => qualifies(quote, method) && fresh(quote.time))) {
        const contracts = Object.values(contractsByGroup).flat();
        await compareSetups(durations.map(ticks => ({ symbol: fallbackSymbol, ticks, contracts })));
    }
    const ranked = rankQuotes(
        quotes.filter(quote => fresh(quote.time)),
        method
    );
    if (signal.aborted) return undefined;
    onCompared?.(ranked);
    return ranked.find(quote => qualifies(quote, method));
}
