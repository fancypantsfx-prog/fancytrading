import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import RankedRunner from '../ranked-runner';
import { selectRankedTrade } from '../ranked-trade';

jest.mock('../ranked-trade', () => ({
    fresh: () => true,
    rankedTradeKey: ({ symbol }: { symbol: string }) => symbol,
    selectRankedTrade: jest.fn(),
}));
const mockSend = jest.fn();
jest.mock('@deriv/shared', () => ({ getDecimalPlaces: () => 2, useWS: () => ({ send: mockSend }) }));
jest.mock('../tick-insights-data', () => ({ waitForInsightRequest: (request: Promise<unknown>) => request }));

it('settles each purchase, doubles after a loss, and stops before risking more than the session budget', async () => {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            request: (_: string, __: unknown, run: (lock: object) => Promise<void>) => run({}),
        },
    });
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

it('skips a contract without buying and waits for confirmation on the next one', async () => {
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
            request: (_: string, __: unknown, run: (lock: object) => Promise<void>) => run({}),
        },
    });
    const pick = (symbol: string) => ({
        rate: 0.5,
        expectedPayout: 9,
        time: Date.now(),
        trade: { symbol, candidate: 'CALL', currency: 'USD', stake: 10, ticks: 1, payout: 18 },
    });
    (selectRankedTrade as jest.Mock)
        .mockImplementationOnce(async (_send, _currency, _stake, _signal, _skipped, onCompared) => {
            const quotes = ['R_50', 'R_25', 'R_75', 'R_10'].map(pick);
            onCompared(quotes);
            return quotes[0];
        })
        .mockResolvedValueOnce(pick('R_100'));
    mockSend.mockResolvedValue({ proposal_open_contract: { contract_id: 1, is_sold: 1, profit: 8 } });
    const buy = jest.fn(async (_trade, _signal, guard) => {
        guard();
        return '1';
    });
    render(<RankedRunner currency='USD' stake={10} account='demo-review' block='' buy={buy} />);
    fireEvent.change(screen.getByLabelText(/Stop loss/), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText(/Take profit/), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Execution mode'), { target: { value: 'semi-automatic' } });
    fireEvent.click(screen.getByText('Start trading'));

    expect(await screen.findByText(/R_50 .* CALL/)).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader')).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: '50%' })).toHaveLength(3);
    expect(screen.getAllByRole('cell', { name: '9.00 USD' })).toHaveLength(3);
    expect(buy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText(/R_100 .* CALL/)).toBeInTheDocument();
    expect(buy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm trade' }));
    await screen.findByText('Run stopped. Session P/L 8 USD');
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy.mock.calls[0][0]).toMatchObject({ symbol: 'R_100' });
});
