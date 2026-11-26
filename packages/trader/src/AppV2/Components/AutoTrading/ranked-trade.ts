import { fetchStrategyFinder } from '@deriv/api';
import { compareRecentTicks, IncompleteInsightHistory } from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

export const rankedTradeKey = ({ symbol, candidate, ticks }: Pick<TInsightTrade, 'symbol' | 'candidate' | 'ticks'>) =>
    JSON.stringify([symbol, candidate, ticks]);

type Row = { symbol: string; candidate: string; historical: { hits: number; count: number }; sampleAt: number };
export type RankedQuote = { trade: TInsightTrade; expectedPayout: number; rate: number; time: number };
export const fresh = (time: number) => time <= Date.now() && time >= Date.now() - 180000;
const contractsByGroup = {
    rise_fall: ['CALL', 'PUT'],
    even_odd: ['DIGITEVEN', 'DIGITODD'],
    over_under: ['DIGITOVER:5', 'DIGITUNDER:5'],
};
export type RankedContractGroup = keyof typeof contractsByGroup;

export const rankedContractGroup = (candidate: string) => {
    const type = candidate.split(':')[0];
    return (Object.keys(contractsByGroup) as RankedContractGroup[]).find(group =>
        contractsByGroup[group].some(contract => contract.split(':')[0] === type)
    );
};

const durations = [1, 3];
export const RISE_FALL_FALLBACK_TICKS = 5;

export async function selectRankedTrade(
    send: Parameters<typeof compareRecentTicks>[0],
    currency: string,
    stake: number,
    signal: AbortSignal,
    skipped?: ReadonlySet<string>,
    onCompared?: (quotes: RankedQuote[]) => void,
    fallbackSymbol?: string,
    repeat: readonly TInsightTrade[] = []
) {
    const searchDurations = [...durations, RISE_FALL_FALLBACK_TICKS];
    const shortlists = await Promise.all(
        searchDurations.flatMap(ticks => {
            const groups = ticks === RISE_FALL_FALLBACK_TICKS ? ['rise_fall'] : Object.keys(contractsByGroup);
            return groups.map(async contract => {
                const settings = new URLSearchParams({ contract, ticks: String(ticks), barrier: '5' });
                const scan = await fetchStrategyFinder<{ rows: Row[] }>(settings, signal);
                if (!scan) throw new Error('Strategy Finder access is required.');
                return scan.rows
                    .filter(
                        row =>
                            rankedContractGroup(row.candidate) === contract &&
                            row.historical.count > 0 &&
                            !skipped?.has(rankedTradeKey({ ...row, ticks }))
                    )
                    .sort((a, b) => Number(fresh(b.sampleAt)) - Number(fresh(a.sampleAt)))
                    .slice(0, 2)
                    .map(row => ({ ...row, ticks }));
            });
        })
    );
    const setups = new Map<string, { symbol: string; ticks: number; contracts: string[] }>();
    for (const { symbol, ticks, candidate } of [...repeat, ...shortlists.flat()]) {
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
            const expectedPayout = rate * row.payout;
            if (rate >= 0 && rate <= 1 && Number.isFinite(expectedPayout) && row.payout > 0) {
                quotes.push({
                    trade: { ...setup, candidate: row.candidate, payout: row.payout },
                    rate,
                    expectedPayout,
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
    if (fallbackSymbol) {
        const fallbacks = [];
        if (!quotes.length) {
            const contracts = Object.values(contractsByGroup).flat();
            fallbacks.push(...durations.map(ticks => ({ symbol: fallbackSymbol, ticks, contracts })));
        }
        if (!quotes.some(({ trade }) => rankedContractGroup(trade.candidate) === 'rise_fall')) {
            fallbacks.push({
                symbol: fallbackSymbol,
                ticks: RISE_FALL_FALLBACK_TICKS,
                contracts: contractsByGroup.rise_fall,
            });
        }
        await compareSetups(fallbacks);
    }
    const ranked = quotes
        .filter(quote => fresh(quote.time))
        .sort((a, b) => b.expectedPayout - a.expectedPayout || b.rate - a.rate);
    if (signal.aborted) return undefined;
    onCompared?.(ranked);
    return ranked[0];
}
