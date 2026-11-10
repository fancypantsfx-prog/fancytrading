import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchPremiumAccess, fetchTickInsights } from '@deriv/api';
import TickInsights from '../tick-insights';

const mockSend = jest.fn(async (request: Record<string, unknown>) => {
    if (request.ticks_history) {
        return {
            pip_size: 2,
            history: {
                prices: Array.from({ length: 400 }, (_, i) => 100 + i),
                times: Array.from({ length: 400 }, (_, i) => 1800000000 + i),
            },
        };
    }
    return { proposal: { ask_price: 10, payout: 18 } };
});
jest.mock('@deriv/shared', () => ({ useWS: () => ({ send: mockSend }) }));
jest.mock('@deriv/api', () => ({ fetchPremiumAccess: jest.fn(), fetchTickInsights: jest.fn() }));

const props = { symbol: '1HZ100V', currency: 'USD', initial_stake: 10, initial_ticks: 5, is_accumulator: false };

beforeEach(() => {
    jest.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
});

it('compares the selected market and filters quoted payouts without executing trades', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    const sample = { hits: 30, count: 39 };
    (fetchTickInsights as jest.Mock).mockResolvedValue({
        access: { access: 'free' },
        currency: 'USD',
        ticks: 5,
        firstTick: 1800000000,
        lastTick: 1800000399,
        rows: [
            {
                candidate: 'CALL',
                stake: 10,
                payout: 18,
                older: sample,
                recent: sample,
                historical: { hits: 60, count: 78 },
            },
            {
                candidate: 'PUT',
                stake: 10,
                payout: 20,
                older: sample,
                recent: sample,
                historical: { hits: 60, count: 78 },
            },
        ],
    });
    render(<TickInsights {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '400-Tick Trade Insights' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Compare trades' }));

    expect(await screen.findByRole('rowheader', { name: 'Rise' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Minimum total payout/), { target: { value: '19' } });
    expect(screen.queryByRole('rowheader', { name: 'Rise' })).toBeNull();
    expect(screen.getByRole('rowheader', { name: 'Fall' })).toBeInTheDocument();
    expect(mockSend).toHaveBeenCalledWith({ ticks_history: '1HZ100V', end: 'latest', count: 400, style: 'ticks' });
    expect(mockSend.mock.calls.every(([request]) => request.proposal || request.ticks_history)).toBe(true);
    expect(fetchTickInsights).toHaveBeenCalledWith(
        expect.objectContaining({ prices: expect.any(Array), ticks: 5, precision: 2 }),
        expect.any(AbortSignal)
    );
});

it('keeps market requests behind the access check', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'locked' });
    render(<TickInsights {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '400-Tick Trade Insights' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Trade Insights is locked'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchTickInsights).not.toHaveBeenCalled();
});
