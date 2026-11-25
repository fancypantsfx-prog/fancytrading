import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import RankedRunner from '../ranked-runner';
import { selectRankedTrade } from '../ranked-trade';

jest.mock('../ranked-trade', () => ({
    ...jest.requireActual('../ranked-trade'),
    fresh: () => true,
    rankedTradeKey: ({ symbol }: { symbol: string }) => symbol,
    selectRankedTrade: jest.fn(),
}));
const mockSend = jest.fn();
jest.mock('@deriv/shared', () => ({ getDecimalPlaces: () => 2, useWS: () => ({ send: mockSend }) }));
jest.mock('../tick-insights-data', () => ({
    ...jest.requireActual('../tick-insights-data'),
    waitForInsightRequest: (request: Promise<unknown>) => request,
}));

beforeEach(() => {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            request: (_: string, __: unknown, run: (lock: object) => Promise<void>) => run({}),
        },
    });
});

it('settles each purchase, doubles after a loss, and stops before risking more than the session budget', async () => {
    (selectRankedTrade as jest.Mock).mockImplementation(async (_, currency, stake) => ({
        rate: 0.7,
        time: Date.now(),
        trade: { symbol: 'R_50', candidate: 'CALL', currency, stake, ticks: 1, payout: stake * 2 },
    }));
    mockSend.mockImplementation(async ({ contract_id }) => ({
        proposal_open_contract: { contract_id, is_sold: 1, profit: contract_id === 1 ? -10 : -20 },
    }));
    let count = 0;
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return String(++count);
    });
    render(<RankedRunner currency='USD' stake={10} account='demo-test' block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '35' } });
    fireEvent.click(screen.getByText('Start trading'));
    await screen.findByText('Run stopped. Session P/L -30 USD');
    expect(buy.mock.calls.map(([trade]) => trade.stake)).toEqual([10, 20]);
    expect(localStorage.getItem('fancy-ranked-purchase:demo-test')).toBeNull();
});

it.each([
    ['automatic', 30, 10],
    ['automatic', 29, 9.66],
    ['semi-automatic', 29, 9.66],
] as const)('%s buys within the stop loss of %i before checking settlement', async (mode, loss, expectedStake) => {
    const markets = ['Market 1', 'Market 2', 'Market 3'];
    mockRankings(['CALL', 'CALL', 'CALL']);
    const bought: string[] = [];
    const buy = jest.fn(async (trade, _signal, guard) => {
        guard();
        bought.push(trade.symbol);
        const id = String(bought.length);
        await Promise.resolve();
        expect(bought).toEqual(markets);
        return id;
    });
    mockSend.mockClear();
    mockSend.mockImplementation(async ({ contract_id }) => {
        expect(bought).toEqual(markets);
        return { proposal_open_contract: { contract_id, is_sold: 1, profit: 2 } };
    });
    const account = `demo-batch-${mode}-${loss}`;
    render(<RankedRunner currency='USD' stake={10} account={account} block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: String(loss) } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Execution mode'), { target: { value: mode } });
    fireEvent.click(screen.getByText('Start trading'));
    if (mode === 'semi-automatic') {
        const buyAll = await screen.findByRole('button', { name: 'Buy all 3' });
        expect(buy).not.toHaveBeenCalled();
        fireEvent.click(buyAll);
    }
    await screen.findByText(`Run stopped. Session P/L ${markets.length * 2} USD`);
    expect(bought).toEqual(markets);
    expect(buy.mock.calls.map(([trade]) => trade.stake)).toEqual([expectedStake, expectedStake, expectedStake]);
    expect(mockSend).toHaveBeenCalledTimes(markets.length);
    expect(localStorage.getItem(`fancy-ranked-purchase:${account}`)).toBeNull();
});

it('skips a shortlist and buys only the selected contract from the next top three', async () => {
    const pick = (symbol: string) => ({
        rate: 2 / 3,
        expectedPayout: 12,
        time: Date.now(),
        trade: { symbol, candidate: 'CALL', currency: 'USD', stake: 10, ticks: 1, payout: 18 },
    });
    (selectRankedTrade as jest.Mock)
        .mockImplementationOnce(async (_send, _currency, _stake, _signal, _skipped, onCompared) => {
            const quotes = ['R_50', 'R_25', 'R_75', 'R_10'].map(pick);
            onCompared(quotes);
            return quotes[0];
        })
        .mockImplementationOnce(async (_send, _currency, _stake, _signal, skipped, onCompared) => {
            expect([...skipped]).toEqual(['R_50', 'R_25', 'R_75']);
            const quotes = ['R_100', 'R_200', 'R_300'].map(pick);
            onCompared(quotes);
            return quotes[0];
        });
    mockSend.mockResolvedValue({ proposal_open_contract: { contract_id: 1, is_sold: 1, profit: 8 } });
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return '1';
    });
    render(<RankedRunner currency='USD' stake={10} account='demo-review' block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Execution mode'), { target: { value: 'semi-automatic' } });
    fireEvent.click(screen.getByText('Start trading'));

    expect(await screen.findByRole('button', { name: /Buy R_50/ })).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader')).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: '66.7%' })).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: '12.00 USD' })).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /^Buy R_/ })).toHaveLength(3);
    expect(buy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    const third = await screen.findByRole('button', { name: /Buy R_300/ });
    expect(buy).not.toHaveBeenCalled();
    fireEvent.click(third);
    await screen.findByText('Run stopped. Session P/L 8 USD');
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy.mock.calls[0][0]).toMatchObject({ symbol: 'R_300' });
});

const mockRankings = (candidates: string[]) => {
    (selectRankedTrade as jest.Mock).mockImplementation(
        async (_send, currency, stake, _signal, _skipped, onCompared) => {
            const quotes = candidates.map((candidate, index) => ({
                rate: 0.6,
                expectedPayout: stake * 1.2,
                time: Date.now(),
                trade: { symbol: `Market ${index + 1}`, candidate, currency, stake, ticks: 1, payout: stake * 2 },
            }));
            onCompared(quotes);
            return quotes[0];
        }
    );
};

it.each([
    ['all', 45, 5, ['Market 1', 'Market 2', 'Market 3']],
    ['topTwo', 35, 7.5, ['Market 1', 'Market 2']],
    ['third', 25, 15, ['Market 3']],
] as const)(
    'preserves the %s selection after settlement and adjusts only the stake',
    async (ranks, loss, nextStake, markets) => {
        mockRankings(['CALL', 'DIGITEVEN', 'DIGITOVER:5']);
        const purchased: [string, number][] = [];
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: -purchased[contract_id - 1][1] },
        }));
        const buy = jest.fn(async (trade, _signal, guard) => {
            guard();
            purchased.push([trade.symbol, trade.stake]);
            return String(purchased.length);
        });
        render(<RankedRunner currency='USD' stake={10} account='follow-up' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: String(loss) } });
        fireEvent.change(screen.getByLabelText('Rank selection'), { target: { value: ranks } });
        fireEvent.click(screen.getByText('Start trading'));
        await screen.findByText(`Run stopped. Session P/L -${loss} USD`);
        expect(purchased).toEqual([
            ...markets.map(market => [market, 10]),
            ...markets.map(market => [market, nextStake]),
        ]);
    }
);

it.each([
    ['first', '', '', ['Market 1']],
    ['second', '', '', ['Market 2']],
    ['third', 'match_diff', '', ['Market 3']],
    ['topTwo', '', '', ['Market 1', 'Market 2']],
    ['topTwo', '', 'rise_fall', ['Market 2']],
    ['all', 'over_under', 'rise_fall', ['Market 2']],
])('enforces the %s rank selection with include %s and exclude %s', async (ranks, only, exclude, markets) => {
    mockRankings(['CALL', 'DIGITOVER:5', 'DIGITDIFF:5']);
    mockSend.mockImplementation(async ({ contract_id }) => ({
        proposal_open_contract: { contract_id, is_sold: 1, profit: 10 },
    }));
    let id = 0;
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return String(++id);
    });
    render(<RankedRunner currency='USD' stake={10} account='rank-filter' block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rank selection'), { target: { value: ranks } });
    fireEvent.change(screen.getByLabelText('Trade only'), { target: { value: only } });
    fireEvent.change(screen.getByLabelText('Do not trade'), { target: { value: exclude } });
    fireEvent.click(screen.getByText('Start trading'));
    await screen.findByText(`Run stopped. Session P/L ${markets.length * 10} USD`);
    expect(buy.mock.calls.map(([trade]) => trade.symbol)).toEqual(markets);
});
