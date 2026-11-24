import { fetchStrategyFinder } from '@deriv/api';
import { compareRecentTicks } from '../tick-insights-data';
import { selectRankedTrade } from '../ranked-trade';

jest.mock('@deriv/api', () => ({ fetchStrategyFinder: jest.fn() }));
jest.mock('../tick-insights-data', () => ({ compareRecentTicks: jest.fn() }));

it('ranks fresh contracts by conservative net and skips a positive raw estimate with a weak recent sample', async () => {
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
                historical: { hits: trade.symbol === 'A' ? 160 : 144, count: 200 },
                older: { hits: trade.symbol === 'A' ? 95 : 72, count: 100 },
                recent: { hits: trade.symbol === 'A' ? 65 : 72, count: 100 },
                payout: trade.ticks === 1 ? 100 : trade.symbol === 'A' ? 18 : 19,
            },
        ],
    }));
    const pick = await selectRankedTrade(jest.fn(), 'USD', 10, new AbortController().signal);
    expect(pick?.trade).toMatchObject({ symbol: 'B', ticks: 3, payout: 19 });
    const standard = await selectRankedTrade(
        jest.fn(),
        'USD',
        10,
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        'standard'
    );
    expect(standard?.trade).toMatchObject({ symbol: 'A', ticks: 3, payout: 18 });
    (compareRecentTicks as jest.Mock).mockResolvedValue({
        lastTick: Math.floor(now / 1000),
        rows: [
            {
                candidate: 'CALL',
                stake: 10,
                payout: 18,
                estimated: false,
                historical: { hits: 145, count: 200 },
                older: { hits: 95, count: 100 },
                recent: { hits: 50, count: 100 },
            },
        ],
    });
    expect(await selectRankedTrade(jest.fn(), 'USD', 10, new AbortController().signal)).toBeUndefined();
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
                historical: { hits: 140, count: 200 },
                older: { hits: 70, count: 100 },
                recent: { hits: 70, count: 100 },
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

it('loads all Finder shortlists concurrently and analyzes contracts on the same market and duration together', async () => {
    const finder = fetchStrategyFinder as jest.Mock;
    const compare = compareRecentTicks as jest.Mock;
    finder.mockClear();
    compare.mockClear();
    let releaseScan!: (value: { rows: unknown[] }) => void;
    const pendingScan = new Promise<{ rows: unknown[] }>(resolve => {
        releaseScan = resolve;
    });
    finder.mockImplementation(() => pendingScan);
    compare.mockResolvedValue(null);

    const pending = selectRankedTrade(jest.fn(), 'USD', 10, new AbortController().signal);
    expect(finder).toHaveBeenCalledTimes(8);

    releaseScan({
        rows: ['CALL', 'PUT'].map(candidate => ({
            symbol: 'R_100',
            candidate,
            historical: { hits: 5, count: 10 },
            sampleAt: Date.now(),
        })),
    });
    await pending;
    expect(compare).toHaveBeenCalledTimes(2);
    expect(compare.mock.calls.map(([, setup]) => [setup.ticks, setup.candidates])).toEqual([
        [1, ['CALL', 'PUT']],
        [3, ['CALL', 'PUT']],
    ]);
});
