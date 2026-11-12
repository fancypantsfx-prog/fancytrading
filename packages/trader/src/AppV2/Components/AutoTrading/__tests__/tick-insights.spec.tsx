import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fetchPremiumAccess, fetchTickInsights } from '@deriv/api';
import { FancyTradingDialogContext } from '../fancy-trading-dialog-context';
import TickInsights from '../tick-insights';

const mockSend = jest.fn(async (request: Record<string, unknown>) => {
    if (request.ticks_history) {
        const count = Number(request.count);
        return {
            pip_size: 2,
            history: {
                prices: Array.from({ length: count }, (_, i) => 100 + i),
                times: Array.from({ length: count }, (_, i) => 1800000000 + i),
            },
        };
    }
    return { proposal: { ask_price: 10, payout: 18 } };
});

it('stars a finder result and applies multiple durations to both comparison setups', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    (fetchTickInsights as jest.Mock).mockImplementation(async ({ ticks, candidate }) => ({
        access: { access: 'free' },
        currency: 'USD',
        ticks,
        firstTick: 1800000000,
        lastTick: 1800000099,
        rows: [
            {
                candidate: candidate ?? 'PUT',
                stake: 10,
                payout: 20,
                estimatedNet: 20,
                returnOnStake: 0.2,
                historical: { hits: 6, count: 10 },
                older: { hits: 3, count: 5 },
                recent: { hits: 3, count: 5 },
                maxWins: 3,
                maxLosses: 2,
            },
        ],
    }));
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn() }}>
            <TickInsights {...props} initial_candidate='DIGITOVER:4' />
        </FancyTradingDialogContext.Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Scan instruments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare (2)' }));
    fireEvent.change(screen.getByLabelText('Duration in ticks'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add duration' }));
    const heading = await screen.findByRole('heading', { name: /Fall · 1 ticks/ });
    const result = within(heading.closest('article') as HTMLElement);
    expect(await result.findByText(/Max consecutive losses/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Digit Over 4 · 5 ticks/ })).toBeInTheDocument();
    fireEvent.click(result.getByRole('button', { name: 'Buy once' }));
    expect(screen.getByRole('region', { name: 'Review one contract' })).toHaveTextContent('1 ticks');
    expect(props.onBuy).not.toHaveBeenCalled();
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
    getStrategies: () => [{ id: '__fixed_stake__', label: 'Fixed stake', requiresTakeProfit: false, maxStake: false }],
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
    fireEvent.click(await screen.findByRole('button', { name: 'Scan instruments' }));

    expect(await screen.findByRole('rowheader', { name: /Rise/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh comparison' }));
    await waitFor(() => expect(fetchTickInsights).toHaveBeenCalledTimes(2));
    expect(props.onBuy).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Minimum total payout/), { target: { value: '19' } });
    expect(screen.queryByRole('rowheader', { name: /Rise/ })).toBeNull();
    expect(screen.getByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review Fall' }));
    expect(screen.getByRole('region', { name: 'Review automatic run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm and start run' })).toBeDisabled();
    expect(screen.getByText('Enter a run stop loss at least as large as the quoted stake.')).toBeInTheDocument();
    expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back to comparison' }));
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
    expect(
        mockSend.mock.calls.every(([request]) => request.active_symbols || request.proposal || request.ticks_history)
    ).toBe(true);
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
