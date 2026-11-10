import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fetchPremiumAccess, fetchTickInsights } from '@deriv/api';
import { FancyTradingDialogContext } from '../fancy-trading-dialog-context';
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
jest.mock('@deriv/shared', () => ({
    useWS: () => ({ send: mockSend }),
    getPlatformLogo: () => 'brand/platform-logo.svg',
    getDecimalPlaces: () => 2,
}));
jest.mock('@deriv/api', () => ({ fetchPremiumAccess: jest.fn(), fetchTickInsights: jest.fn() }));

const props = {
    symbol: '1HZ100V',
    currency: 'USD',
    initial_stake: 10,
    initial_ticks: 5,
    is_accumulator: false,
    account_label: 'Demo · VRTC123',
    execution_block: '',
    purchase_block: '',
    preset_key: 'test-fancy-preset:VRTC123:USD',
    onBuy: jest.fn(),
    supportsContract: () => true,
    onStart: jest.fn(),
};

beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
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
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Compare trades' }));

    expect(await screen.findByRole('rowheader', { name: 'Rise' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh comparison' }));
    await waitFor(() => expect(fetchTickInsights).toHaveBeenCalledTimes(2));
    expect(props.onBuy).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Minimum total payout/), { target: { value: '19' } });
    expect(screen.queryByRole('rowheader', { name: 'Rise' })).toBeNull();
    expect(screen.getByRole('rowheader', { name: 'Fall' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review Fall' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a run stop loss');
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Run stop loss/), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save automatic preset' }));
    expect(JSON.parse(localStorage.getItem(props.preset_key) ?? 'null')).toEqual({ stake: 10, ticks: 5, stopLoss: 25 });
    fireEvent.click(screen.getByRole('button', { name: 'Review Fall' }));
    expect(screen.getByRole('region', { name: 'Review automatic run' })).toHaveTextContent('Demo · VRTC123');
    expect(props.onStart).not.toHaveBeenCalled();
    props.onStart.mockResolvedValue('run-demo');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and start run' }));
    await screen.findByText(/Automatic run run-demo started/);
    expect(props.onStart).toHaveBeenCalledTimes(1);
    expect(props.onStart).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: 'PUT', ticks: 5, stake: 10, stopLoss: 25, payout: 20 }),
        expect.any(AbortSignal)
    );
    expect(mockSend).toHaveBeenCalledWith({ ticks_history: '1HZ100V', end: 'latest', count: 400, style: 'ticks' });
    expect(mockSend.mock.calls.every(([request]) => request.proposal || request.ticks_history)).toBe(true);
    expect(fetchTickInsights).toHaveBeenCalledWith(
        expect.objectContaining({ prices: expect.any(Array), ticks: 5, precision: 2 }),
        expect.any(AbortSignal)
    );
});

it('loads the saved automatic settings for the matching account and currency', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    localStorage.setItem(props.preset_key, JSON.stringify({ stake: 12, ticks: 7, stopLoss: 24, takeProfit: 16 }));
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByLabelText(/Stake per contract/)).toHaveValue(12);
    expect(screen.getByLabelText(/Tick target/)).toHaveValue(7);
    expect(screen.getByLabelText(/Run stop loss/)).toHaveValue(24);
    expect(screen.getByLabelText(/Run take profit/)).toHaveValue(16);
});

it('keeps market requests behind the access check', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'locked' });
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('FancyTrading insights are locked'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchTickInsights).not.toHaveBeenCalled();
});
