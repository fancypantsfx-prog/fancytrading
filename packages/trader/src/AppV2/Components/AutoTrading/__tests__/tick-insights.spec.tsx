import React from 'react';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fetchPremiumAccess, fetchStrategyFinder, fetchTickInsights } from '@deriv/api';
import { FancyTradingDialogContext } from '../fancy-trading-dialog-context';
import TickInsights from '../tick-insights';

configure({ asyncUtilTimeout: 8000 });
jest.setTimeout(15000);

let mockRateLimitProposal = false;
const mockSend = jest.fn(async (request: Record<string, unknown>) => {
    if (request.proposal && mockRateLimitProposal) return { error: { code: 'RateLimit' } };
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
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}>
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
jest.mock('@deriv/api', () => ({ fetchPremiumAccess: jest.fn(), fetchStrategyFinder: jest.fn(), fetchTickInsights: jest.fn() }));

const props = {
    symbol: '1HZ100V',
    currency: 'USD',
    initial_stake: 10,
    initial_ticks: 5,
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
    (fetchStrategyFinder as jest.Mock).mockResolvedValue({
        access: { access: 'free' },
        ticks: 5,
        updatedAt: Date.now(),
        marketsScanned: 1,
        rows: [{ candidate: 'PUT', symbol: '1HZ100V', historical: { hits: 6, count: 10 } }],
    });
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
});

it('scans the cached snapshot without Deriv requests and quotes only the selected trade', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Scan instruments' }));
    expect(await screen.findByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    expect(fetchStrategyFinder).toHaveBeenCalledWith(
        new URLSearchParams({ contract: 'rise_fall', ticks: '5', barrier: '5' }),
        expect.any(AbortSignal)
    );
    expect(mockSend).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Review automatic' }));
    expect(await screen.findByRole('region', { name: 'Review automatic run' })).toBeInTheDocument();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ proposal: 1, contract_type: 'PUT' }));
    expect(screen.getByRole('button', { name: 'Confirm and start run' })).toBeDisabled();
    expect(props.onBuy).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
});

it('loads the saved automatic settings for the matching account and currency', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    localStorage.setItem(props.preset_key, JSON.stringify({ stake: 12, ticks: 7, stopLoss: 24, takeProfit: 16 }));
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('spinbutton', { name: /Stake per contract/ })).toHaveValue(12);
    expect(screen.getByRole('spinbutton', { name: /Tick target/ })).toHaveValue(7);
    fireEvent.click(screen.getByRole('button', { name: 'Automatic settings' }));
    expect(screen.getByLabelText(/Run stop loss/)).toHaveValue(24);
    expect(screen.getByLabelText(/Run take profit/)).toHaveValue(16);
});

it('keeps market requests behind the access check', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'locked' });
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('FancyTrading insights are locked'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchStrategyFinder).not.toHaveBeenCalled();
});

it('stops queued quotes and reports the broker rate limit inside FancyTrading', async () => {
    mockRateLimitProposal = true;
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}>
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Scan instruments' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Get live quote' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Deriv is limiting requests.');
    expect(mockSend.mock.calls.filter(([payload]) => payload.proposal)).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
            proposal: 1,
            passthrough: { fancytrading_insights: true },
        })
    );
    expect(fetchTickInsights).not.toHaveBeenCalled();
});
