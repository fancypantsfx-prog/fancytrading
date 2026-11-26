import React from 'react';
import { act, configure, fireEvent, render, screen } from '@testing-library/react';
import RankedRunner from '../ranked-runner';
import { selectRankedTrade } from '../ranked-trade';
import { getInsightCooldown, InsightRateLimitError, InsightRequestTimeout, sendInsightRequest } from '../tick-insights-data';

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
    getInsightCooldown: jest.fn(jest.requireActual('../tick-insights-data').getInsightCooldown),
    sendInsightRequest: jest.fn((send, payload) => send(payload)),
    waitForInsightRequest: (request: Promise<unknown>) => request,
}));

configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            request: (_: string, __: unknown, run: (lock: object) => Promise<void>) => run({}),
        },
    });
});

const finishRun = async (duration: number, status: string) => {
    jest.useFakeTimers();
    try {
        await act(async () => fireEvent.click(screen.getByText('Start trading')));
        await act(async () => jest.advanceTimersByTimeAsync(duration));
        expect(screen.getByText(status)).toBeInTheDocument();
    } finally {
        jest.useRealTimers();
    }
};

it.each([
    ['fixed', [10, 10, 10, 4.99]],
    ['martingale', [10, 20, 4.99]],
])('settles each purchase and adjusts the stake using %s', async (method, expectedStakes) => {
    (selectRankedTrade as jest.Mock).mockImplementation(async (_, currency, stake) => ({
        rate: 0.7,
        expectedPayout: stake * 1.4,
        time: Date.now(),
        trade: { symbol: 'R_50', candidate: 'CALL', currency, stake, ticks: 1, payout: stake * 2 },
    }));
    const stakes: number[] = [];
    mockSend.mockImplementation(async ({ contract_id }) => ({
        proposal_open_contract: { contract_id, is_sold: 1, profit: -stakes[contract_id - 1] },
    }));
    const buy = jest.fn(async (trade, _signal, guard) => {
        guard();
        stakes.push(trade.stake);
        return String(stakes.length);
    });
    render(<RankedRunner currency='USD' stake={10} account='demo-test' block='' buy={buy} />);
    expect(screen.getByLabelText('Strategy')).toHaveValue('fixed');
    fireEvent.change(screen.getByLabelText('Strategy'), { target: { value: method } });
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '35' } });
    await finishRun(39000, 'Run stopped. Session P/L -34.99 USD');
    expect(stakes).toEqual(expectedStakes);
    expect(localStorage.getItem('fancy-ranked-purchase:demo-test')).toBeNull();
});

it.each([
    ['automatic', 30, 9.99],
    ['automatic', 29, 9.66],
    ['automatic', 5, 1.66],
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
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '31' } });
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

it.each([true, false])(
    'reuses the winning contract in its selected rank when a fresh quote is available (%s)',
    async available => {
        const contract = { symbol: 'R_25', candidate: 'DIGITOVER:5', currency: 'USD', stake: 10, ticks: 3, payout: 18 };
        const quote = (symbol: string, payout = 18) => ({
            rate: 0.6,
            expectedPayout: payout * 0.6,
            time: Date.now(),
            trade: { ...contract, symbol, payout },
        });
        (selectRankedTrade as jest.Mock)
            .mockImplementationOnce(async (_send, _currency, _stake, _signal, _skipped, onCompared) => {
                const quotes = [quote('R_50'), quote(contract.symbol), quote('R_75')];
                onCompared(quotes);
                return quotes[0];
            })
            .mockImplementationOnce(
                async (_send, _currency, _stake, _signal, _skipped, onCompared, _symbol, repeat) => {
                    expect(repeat).toEqual([contract]);
                    const quotes = [quote('R_10'), quote('R_100'), quote('R_200')];
                    if (available) quotes.push(quote(contract.symbol, 16));
                    onCompared(quotes);
                    return quotes[0];
                }
            );
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: 2 },
        }));
        let id = 0;
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return String(++id);
        });
        render(<RankedRunner currency='USD' stake={10} account='repeat-winner' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '8' } });
        fireEvent.change(screen.getByLabelText('Rank selection'), { target: { value: 'second' } });
        jest.useFakeTimers();
        try {
            await act(async () => fireEvent.click(screen.getByText('Start trading')));
            await act(async () => jest.advanceTimersByTimeAsync(14000));
            expect(buy).toHaveBeenCalledTimes(3);
            expect(screen.getByRole('timer')).toHaveTextContent('Next request in 25 s');
            await act(async () => jest.advanceTimersByTimeAsync(24999));
            expect(buy).toHaveBeenCalledTimes(3);
            await act(async () => jest.advanceTimersByTimeAsync(1));
            expect(screen.getByText('Run stopped. Session P/L 8 USD')).toBeInTheDocument();
        } finally {
            jest.useRealTimers();
        }
        expect(buy.mock.calls.map(([trade]) => trade)).toEqual([
            contract,
            contract,
            contract,
            available ? { ...contract, payout: 16 } : { ...contract, symbol: 'R_100' },
        ]);
    }
);

const mockRankings = (candidates: string[], expectedReturns = candidates.map(() => 1.2)) => {
    (selectRankedTrade as jest.Mock).mockImplementation(
        async (_send, currency, stake, _signal, _skipped, onCompared) => {
            const quotes = candidates.map((candidate, index) => ({
                rate: 0.6,
                expectedPayout: stake * expectedReturns[index],
                time: Date.now(),
                trade: { symbol: `Market ${index + 1}`, candidate, currency, stake, ticks: 1, payout: stake * 2 },
            }));
            onCompared(quotes);
            return quotes[0];
        }
    );
};

it.each([
    ['all', 45, [4.99], -44.97, ['Market 1', 'Market 2', 'Market 3']],
    ['topTwo', 35, [7.49], -34.98, ['Market 1', 'Market 2']],
    ['third', 25, [10, 4.99], -24.99, ['Market 3']],
] as const)(
    'preserves the %s selection after settlement and adjusts only the stake',
    async (ranks, loss, nextStakes, net, markets) => {
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
        await finishRun(14000, `Run stopped. Session P/L ${net} USD`);
        expect(purchased).toEqual([
            ...markets.map(market => [market, 10]),
            ...nextStakes.flatMap(next => markets.map(market => [market, next])),
        ]);
    }
);

it.each([
    ['first', '', '', ['Market 1']],
    ['second', '', '', ['Market 2']],
    ['third', 'even_odd', '', ['Market 3']],
    ['topTwo', '', '', ['Market 1', 'Market 2']],
    ['topTwo', '', 'rise_fall', ['Market 2']],
    ['all', 'over_under', '', ['Market 2']],
])('enforces the %s rank selection with include %s and exclude %s', async (ranks, only, exclude, markets) => {
    mockRankings(['CALL', 'DIGITOVER:5', 'DIGITEVEN']);
    mockSend.mockImplementation(async ({ contract_id }) => ({
        proposal_open_contract: { contract_id, is_sold: 1, profit: 10 },
    }));
    let id = 0;
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return String(++id);
    });
    render(<RankedRunner currency='USD' stake={10} account='rank-filter' block='' buy={buy} />);
    expect(screen.queryByRole('option', { name: 'Matches / Differs' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Rank selection'), { target: { value: ranks } });
    if (only) {
        fireEvent.change(screen.getByLabelText('Trade only'), { target: { value: only } });
        expect(screen.queryByLabelText('Do not trade')).not.toBeInTheDocument();
    }
    if (exclude) {
        fireEvent.change(screen.getByLabelText('Do not trade'), { target: { value: exclude } });
        expect(screen.queryByLabelText('Trade only')).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByText('Start trading'));
    await screen.findByText(`Run stopped. Session P/L ${markets.length * 10} USD`);
    expect(buy.mock.calls.map(([trade]) => trade.symbol)).toEqual(markets);
});

it.each(['automatic', 'semi-automatic'])(
    'executes all selected contracts with a negative estimated net payout in %s mode',
    async mode => {
        mockRankings(['CALL', 'DIGITOVER:5', 'DIGITEVEN'], [0.8, 0.7, 0.5]);
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: 10 },
        }));
        let id = 0;
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return String(++id);
        });
        render(<RankedRunner currency='USD' stake={10} account='positive-batch' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '40' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '10' } });
        fireEvent.change(screen.getByLabelText('Execution mode'), { target: { value: mode } });
        fireEvent.click(screen.getByText('Start trading'));
        if (mode === 'semi-automatic') {
            fireEvent.click(await screen.findByRole('button', { name: 'Buy all 3' }));
        }
        await screen.findByText('Run stopped. Session P/L 30 USD');
        expect(buy.mock.calls.map(([trade]) => trade.symbol)).toEqual(['Market 1', 'Market 2', 'Market 3']);
    }
);

it('keeps the combined stake below the stop loss after a profitable round', async () => {
    mockRankings(['CALL', 'DIGITOVER:5', 'DIGITEVEN']);
    mockSend.mockImplementation(async ({ contract_id }) => ({
        proposal_open_contract: { contract_id, is_sold: 1, profit: 2 },
    }));
    let id = 0;
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return String(++id);
    });
    render(<RankedRunner currency='USD' stake={10} account='absolute-limit' block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '10' } });
    await finishRun(7000, 'Run stopped. Session P/L 12 USD');
    expect(buy.mock.calls.map(([trade]) => trade.stake)).toEqual(Array(6).fill(9.99));
});

it.each([false, true])(
    'pauses on a rate limit without leaving an unresolved purchase (submitted: %s)',
    async submitted => {
        jest.useFakeTimers();
        try {
            mockRankings(['CALL']);
            const buy = jest.fn(async (_trade, _signal, guard) => {
                if (submitted) guard();
                throw new InsightRateLimitError();
            });
            const { unmount } = render(
                <RankedRunner currency='USD' stake={10} account='quote-limit' block='' buy={buy} />
            );
            fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
            fireEvent.click(screen.getByText('Start trading'));
            await screen.findByText('Deriv is limiting quotes. Retrying when the limit clears.');
            expect(buy).toHaveBeenCalledTimes(1);
            expect(localStorage.getItem('fancy-ranked-purchase:quote-limit')).toBeNull();
            unmount();
            await jest.runOnlyPendingTimersAsync();
        } finally {
            jest.useRealTimers();
        }
    }
);

it('checks an open contract again after a settlement rate limit before continuing', async () => {
    jest.useFakeTimers();
    try {
        mockRankings(['CALL']);
        (sendInsightRequest as jest.Mock).mockRejectedValueOnce(new InsightRateLimitError());
        mockSend.mockResolvedValue({ proposal_open_contract: { contract_id: 1, is_sold: 1, profit: 10 } });
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return '1';
        });
        render(<RankedRunner currency='USD' stake={10} account='settlement-limit' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '10' } });
        fireEvent.click(screen.getByText('Start trading'));
        await screen.findByText('Run stopped. Session P/L 10 USD');
        expect(buy).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('fancy-ranked-purchase:settlement-limit')).toBeNull();
    } finally {
        jest.useRealTimers();
    }
});

it('counts down a quote timeout and waits seven seconds after settlement before the next round', async () => {
    jest.useFakeTimers();
    try {
        mockRankings(['CALL']);
        const compare = jest.mocked(selectRankedTrade);
        compare.mockClear();
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: 2 },
        }));
        let id = 0;
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return String(++id);
        });
        buy.mockRejectedValueOnce(new InsightRequestTimeout());
        render(<RankedRunner currency='USD' stake={10} account='quote-timeout' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Initial stake/), { target: { value: '7.50' } });
        expect(screen.getByLabelText(/Take profit/)).toHaveValue(22.5);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '4' } });
        await act(async () => fireEvent.click(screen.getByText('Start trading')));
        expect(screen.getByText('The quote request timed out. Retrying shortly.')).toBeInTheDocument();
        expect(screen.getByRole('timer')).toHaveTextContent('Next request in 2 s');
        expect(localStorage.getItem('fancy-ranked-purchase:quote-timeout')).toBeNull();

        await act(async () => jest.advanceTimersByTimeAsync(1999));
        expect(compare).toHaveBeenCalledTimes(1);
        await act(async () => jest.advanceTimersByTimeAsync(1));
        expect(compare).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Preparing the next trade round.')).toBeInTheDocument();
        expect(screen.getByText('Round 1 P/L: 2.00 USD. Session P/L: 2.00 USD.')).toBeInTheDocument();
        expect(screen.getByLabelText(/Initial stake/)).toBeDisabled();

        await act(async () => jest.advanceTimersByTimeAsync(6999));
        expect(compare).toHaveBeenCalledTimes(1);
        await act(async () => jest.advanceTimersByTimeAsync(1));
        expect(compare).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Run stopped. Session P/L 4 USD')).toBeInTheDocument();
        expect(screen.getByText('Round 2 P/L: 2.00 USD. Session P/L: 4.00 USD.')).toBeInTheDocument();
        expect(buy.mock.calls.map(([trade]) => trade.stake)).toEqual([7.5, 7.5, 7.5]);
    } finally {
        jest.useRealTimers();
    }
});

it('replaces only losing ranks with unused eligible contracts from the same analysis', async () => {
    jest.useFakeTimers();
    try {
        mockRankings(['CALL', 'PUT', 'DIGITEVEN', 'CALL', 'PUT']);
        const compare = jest.mocked(selectRankedTrade);
        compare.mockClear();
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: contract_id % 2 ? 3 : -1 },
        }));
        let id = 0;
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return String(++id);
        });
        render(<RankedRunner currency='USD' stake={5} account='alternate-losses' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '30' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '6' } });
        fireEvent.change(screen.getByLabelText('Rank selection'), { target: { value: 'topTwo' } });
        fireEvent.change(screen.getByLabelText('Trade only'), { target: { value: 'rise_fall' } });
        const toggle = screen.getByRole('switch', { name: 'Replace losing contracts between rounds' });
        expect(toggle).toHaveAttribute('aria-checked', 'false');
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        await act(async () => fireEvent.click(screen.getByText('Start trading')));
        await act(async () => jest.advanceTimersByTimeAsync(14000));
        expect(screen.getByText('Run stopped. Session P/L 6 USD')).toBeInTheDocument();
        expect(compare).toHaveBeenCalledTimes(1);
        expect(buy.mock.calls.map(([trade]) => trade.symbol)).toEqual([
            'Market 1', 'Market 2', 'Market 1', 'Market 4', 'Market 1', 'Market 5',
        ]);
    } finally {
        jest.useRealTimers();
    }
});

it('stops and leaves a pending purchase record if a timeout happens after submission', async () => {
    mockRankings(['CALL']);
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        throw new InsightRequestTimeout('Purchase status is unknown.');
    });
    const key = 'fancy-ranked-purchase:purchase-timeout';
    try {
        render(<RankedRunner currency='USD' stake={10} account='purchase-timeout' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
        fireEvent.click(screen.getByText('Start trading'));
        await screen.findByText('Purchase status is unknown.');
        expect(buy).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('timer')).not.toBeInTheDocument();
        expect(localStorage.getItem(key)).toBe('["pending"]');
    } finally {
        localStorage.removeItem(key);
    }
});

it('pauses a settled run during a disconnect and resumes the same rankings when account readiness returns', async () => {
    jest.useFakeTimers();
    try {
        mockRankings(['CALL']);
        const compare = jest.mocked(selectRankedTrade);
        compare.mockClear();
        mockSend.mockImplementation(async ({ contract_id }) => ({
            proposal_open_contract: { contract_id, is_sold: 1, profit: 2 },
        }));
        let id = 0;
        const buy = jest.fn(async (_trade, _signal, guard) => {
            guard();
            return String(++id);
        });
        const props = { currency: 'USD', stake: 10, account: 'reconnect-between-rounds', buy };
        const { rerender } = render(<RankedRunner {...props} block='' />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '4' } });
        await act(async () => fireEvent.click(screen.getByText('Start trading')));
        expect(buy).toHaveBeenCalledTimes(1);

        rerender(<RankedRunner {...props} block='Socket disconnected' reconnecting />);
        await act(async () => jest.advanceTimersByTimeAsync(9000));
        expect(screen.getByText('Waiting for Deriv to reconnect before the next round.')).toBeInTheDocument();
        expect(buy).toHaveBeenCalledTimes(1);

        rerender(<RankedRunner {...props} block='' />);
        await act(async () => jest.advanceTimersByTimeAsync(1000));
        expect(buy).toHaveBeenCalledTimes(2);
        expect(compare).toHaveBeenCalledTimes(1);
        expect(screen.getByText('Run stopped. Session P/L 4 USD')).toBeInTheDocument();
    } finally {
        jest.useRealTimers();
    }
});

it.each([false, true])('counts down the exact cooldown and handles stopping during the wait (%s)', async stop => {
    jest.useFakeTimers();
    const cooldown = jest.mocked(getInsightCooldown);
    let deadline = 0;
    cooldown.mockImplementation(() => Math.max(0, deadline - performance.now()));
    try {
        mockRankings(['CALL']);
        const buy = jest
            .fn(async (_trade, _signal, guard) => {
                guard();
                return '1';
            })
            .mockImplementationOnce(async () => {
                deadline = performance.now() + 2500;
                throw new InsightRateLimitError();
            });
        mockSend.mockResolvedValue({ proposal_open_contract: { contract_id: 1, is_sold: 1, profit: 2 } });
        render(<RankedRunner currency='USD' stake={10} account='countdown' block='' buy={buy} />);
        fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '20' } });
        fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '2' } });
        await act(async () => fireEvent.click(screen.getByText('Start trading')));
        expect(screen.getByRole('timer')).toHaveTextContent('Next request in 3 s');

        await act(async () => jest.advanceTimersByTimeAsync(1000));
        expect(screen.getByRole('timer')).toHaveTextContent('Next request in 2 s');
        expect(buy).toHaveBeenCalledTimes(1);
        if (stop) {
            await act(async () => fireEvent.click(screen.getByText('Stop run')));
            expect(screen.getByText('Run stopped. Session P/L 0 USD')).toBeInTheDocument();
            await act(async () => jest.advanceTimersByTimeAsync(1500));
            expect(buy).toHaveBeenCalledTimes(1);
        } else {
            await act(async () => jest.advanceTimersByTimeAsync(1499));
            expect(buy).toHaveBeenCalledTimes(1);
            await act(async () => jest.advanceTimersByTimeAsync(1));
            expect(buy).toHaveBeenCalledTimes(2);
            expect(screen.getByText('Run stopped. Session P/L 2 USD')).toBeInTheDocument();
        }
        expect(screen.queryByRole('timer')).not.toBeInTheDocument();
    } finally {
        cooldown.mockImplementation(jest.requireActual('../tick-insights-data').getInsightCooldown);
        jest.useRealTimers();
    }
});
