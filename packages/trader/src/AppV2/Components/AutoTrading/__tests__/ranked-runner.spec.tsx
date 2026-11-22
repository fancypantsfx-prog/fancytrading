import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import RankedRunner from '../ranked-runner';
import { selectRankedTrade } from '../ranked-trade';

jest.mock('../ranked-trade', () => ({ fresh: () => true, selectRankedTrade: jest.fn() }));
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
