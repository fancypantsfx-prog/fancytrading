import { fetchStrategyFinder } from '@deriv/api';
import { compareRecentTicks } from './tick-insights-data';
import type { TInsightTrade } from './tick-insights-data';

export const rankedTradeKey = ({ symbol, candidate, ticks }: Pick<TInsightTrade, 'symbol' | 'candidate' | 'ticks'>) =>
    JSON.stringify([symbol, candidate, ticks]);

type Row = { symbol: string; candidate: string; historical: { hits: number; count: number }; sampleAt: number };
export type RankedQuote = { trade: TInsightTrade; expectedPayout: number; rate: number; time: number };
export const fresh = (time: number) => time <= Date.now() && time >= Date.now() - 180000;
const groups = ['rise_fall', 'even_odd', 'over_under', 'match_diff'];

export async function selectRankedTrade(
    send: Parameters<typeof compareRecentTicks>[0],
    currency: string,
    stake: number,
    signal: AbortSignal,
    skipped?: ReadonlySet<string>,
    onCompared?: (quotes: RankedQuote[]) => void
) {
    const candidates: (Row & { ticks: number })[] = [];
    for (const ticks of [1, 3]) {
        for (const contract of groups) {
            const settings = new URLSearchParams({ contract, ticks: String(ticks), barrier: '5' });
            const scan = await fetchStrategyFinder<{ rows: Row[] }>(settings, signal);
            if (!scan) throw new Error('Strategy Finder access is required.');
            candidates.push(
                ...scan.rows
                    .filter(row => fresh(row.sampleAt) && row.historical.count > 0)
                    .slice(0, 2)
                    .map(row => ({ ...row, ticks }))
                    .filter(row => !skipped?.has(rankedTradeKey(row)))
            );
        }
    }
    const quotes: RankedQuote[] = [];
    const cache: NonNullable<Parameters<typeof compareRecentTicks>[3]> = new Map();
    for (const candidate of candidates) {
        const trade = {
            family: 'digital' as const,
            currency,
            stake,
            ticks: candidate.ticks,
            symbol: candidate.symbol,
            candidate: candidate.candidate,
        };
        const result = await compareRecentTicks(send, trade, signal, cache);
        const row = result?.rows.find(item => item.candidate === trade.candidate);
        const time = Number(result?.lastTick) * 1000;
        if (!fresh(time) || !row || row.estimated || row.stake !== stake || row.historical.count < 1) continue;
        const rate = row.historical.hits / row.historical.count;
        const expectedPayout = rate * row.payout;
        if (rate >= 0 && rate <= 1 && Number.isFinite(expectedPayout) && row.payout > stake) {
            quotes.push({ trade: { ...trade, payout: row.payout }, rate, expectedPayout, time });
        }
    }
    const ranked = quotes
        .filter(quote => fresh(quote.time))
        .sort((a, b) => b.expectedPayout - a.expectedPayout || b.rate - a.rate);
    if (signal.aborted) return undefined;
    onCompared?.(ranked);
    return ranked[0];
}
