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
    match_diff: ['DIGITMATCH:5'],
};
export type RankedContractGroup = keyof typeof contractsByGroup;
const differs = 'DIGITDIFF:5';

export const rankedContractGroup = (candidate: string) => {
    const type = candidate.split(':')[0];
    if (type === 'DIGITDIFF') return 'match_diff';
    return (Object.keys(contractsByGroup) as RankedContractGroup[]).find(group =>
        contractsByGroup[group].some(contract => contract.split(':')[0] === type)
    );
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
    includeDiffers = false
) {
    const shortlists = await Promise.all(
        durations.flatMap(ticks =>
            Object.keys(contractsByGroup).map(async contract => {
                const settings = new URLSearchParams({ contract, ticks: String(ticks), barrier: '5' });
                const scan = await fetchStrategyFinder<{ rows: Row[] }>(settings, signal);
                if (!scan) throw new Error('Strategy Finder access is required.');
                return scan.rows
                    .filter(
                        row =>
                            (includeDiffers || row.candidate.split(':')[0] !== 'DIGITDIFF') &&
                            row.historical.count > 0 &&
                            !skipped?.has(rankedTradeKey({ ...row, ticks }))
                    )
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
            const expectedPayout = rate * row.payout;
            if (rate >= 0 && rate <= 1 && Number.isFinite(expectedPayout) && row.payout > stake) {
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
    if (fallbackSymbol && !quotes.some(quote => fresh(quote.time))) {
        const contracts = Object.values(contractsByGroup).flat();
        if (includeDiffers) contracts.push(differs);
        await compareSetups(durations.map(ticks => ({ symbol: fallbackSymbol, ticks, contracts })));
    }
    const ranked = quotes
        .filter(quote => fresh(quote.time))
        .sort((a, b) => b.expectedPayout - a.expectedPayout || b.rate - a.rate);
    if (signal.aborted) return undefined;
    onCompared?.(ranked);
    return ranked[0];
}
