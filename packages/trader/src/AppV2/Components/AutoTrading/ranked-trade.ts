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
    fallbackSymbol?: string
) {
    const candidates: (Row & { ticks: number })[] = [];
    for (const ticks of durations) {
        for (const contract of Object.keys(contractsByGroup)) {
            const settings = new URLSearchParams({ contract, ticks: String(ticks), barrier: '5' });
            const scan = await fetchStrategyFinder<{ rows: Row[] }>(settings, signal);
            if (!scan) throw new Error('Strategy Finder access is required.');
            candidates.push(
                ...scan.rows
                    .filter(row => row.historical.count > 0 && !skipped?.has(rankedTradeKey({ ...row, ticks })))
                    .sort((a, b) => Number(fresh(b.sampleAt)) - Number(fresh(a.sampleAt)))
                    .slice(0, 2)
                    .map(row => ({ ...row, ticks }))
            );
        }
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

    for (const { symbol, ticks, candidate } of candidates) {
        await compare(symbol, ticks, [candidate]);
    }
    if (fallbackSymbol && !quotes.some(quote => fresh(quote.time))) {
        const contracts = Object.values(contractsByGroup).flat();
        for (const ticks of durations) await compare(fallbackSymbol, ticks, contracts);
    }
    const ranked = quotes
        .filter(quote => fresh(quote.time))
        .sort((a, b) => b.expectedPayout - a.expectedPayout || b.rate - a.rate);
    if (signal.aborted) return undefined;
    onCompared?.(ranked);
    return ranked[0];
}
