import { fetchStrategyFinder } from '@deriv/api';
import { compareRecentTicks } from '../tick-insights-data';
import { selectRankedTrade } from '../ranked-trade';

jest.mock('@deriv/api', () => ({ fetchStrategyFinder: jest.fn() }));
jest.mock('../tick-insights-data', () => ({ compareRecentTicks: jest.fn() }));

it('chooses the highest expected payout with fresh data, even over a higher hit rate', async () => {
    const now = Date.now();
    const row = (symbol: string) => ({
        symbol,
        candidate: 'CALL',
        historical: { hits: 5, count: 10 },
        sampleAt: now - 240000,
    });
    (fetchStrategyFinder as jest.Mock).mockImplementation(async params => ({
        rows: params.get('contract') === 'rise_fall' ? [row('A'), row('B')] : [],
    }));
    (compareRecentTicks as jest.Mock).mockImplementation(async (_, trade) => ({
        lastTick: trade.ticks === 1 ? (now - 190000) / 1000 : Math.floor(now / 1000),
        rows: [
            {
                ...trade,
                candidate: trade.candidates[0],
                estimated: false,
                historical: { hits: trade.symbol === 'A' ? 90 : 70, count: 100 },
                payout: trade.ticks === 1 ? 100 : trade.symbol === 'A' ? 11 : 18,
            },
        ],
    }));
    const pick = await selectRankedTrade(jest.fn(), 'USD', 10, new AbortController().signal);
    expect(pick?.trade).toMatchObject({ symbol: 'B', ticks: 3, payout: 18 });
    (compareRecentTicks as jest.Mock).mockResolvedValue({
        lastTick: Math.floor(now / 1000),
        rows: [{ candidate: 'CALL', stake: 10, payout: 11, estimated: false, historical: { hits: 90, count: 100 } }],
    });
    expect(await selectRankedTrade(jest.fn(), 'USD', 10, new AbortController().signal)).toMatchObject({
        expectedPayout: 9.9,
    });
});

it('checks live contracts on the selected market when Finder has no rows', async () => {
    (fetchStrategyFinder as jest.Mock).mockResolvedValue({ rows: [] });
    (compareRecentTicks as jest.Mock).mockImplementation(async (_, trade) => ({
        lastTick: Math.floor(Date.now() / 1000),
        rows: [
            {
                candidate: 'DIGITEVEN',
                stake: trade.stake,
                payout: 19,
                estimated: false,
                historical: { hits: 62, count: 100 },
            },
        ],
    }));
    const pick = await selectRankedTrade(
        jest.fn(),
        'USD',
        10,
        new AbortController().signal,
        undefined,
        undefined,
        'R_100'
    );
    expect(pick?.trade).toMatchObject({ symbol: 'R_100', candidate: 'DIGITEVEN', payout: 19 });
});
