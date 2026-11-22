import React from 'react';
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { fetchPremiumAccess, fetchStrategyFinder, fetchTickInsights } from '@deriv/api';
import { FancyTradingDialogContext } from '../fancy-trading-dialog-context';
import TickInsights from '../tick-insights';

configure({ asyncUtilTimeout: 8000 });
jest.setTimeout(15000);

let mockRateLimitProposal = false;
let mockUnavailableSymbol = '';
const mockSend = jest.fn(async (request: Record<string, unknown>) => {
    if (request.active_symbols)
        return { active_symbols: [{ underlying_symbol: 'R_50' }, { underlying_symbol: '1HZ100V' }] };
    if (request.proposal && request.underlying_symbol === mockUnavailableSymbol) {
        return { error: { code: 'ContractUnavailable' } };
    }
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
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} initial_candidate='DIGITOVER:4' />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('button', { name: 'Compare (0)' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add setup' }));
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
jest.mock('@deriv/api', () => ({
    fetchPremiumAccess: jest.fn(),
    fetchStrategyFinder: jest.fn(),
    fetchTickInsights: jest.fn(),
}));

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
    mockRateLimitProposal = false;
    mockUnavailableSymbol = '';
    (fetchStrategyFinder as jest.Mock).mockResolvedValue({
        access: { access: 'free' },
        ticks: 5,
        updatedAt: Date.now(),
        marketsScanned: 1,
        rows: [{ sampleAt: Date.now() - 600000, candidate: 'PUT', symbol: '1HZ100V', historical: { hits: 6, count: 10 } }],
    });
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
});

it('removes a setup from its result and clears the remaining selections', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Compare (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add setup' }));
    const heading = await screen.findByRole('heading', { name: /Fall.*5 ticks/ });
    fireEvent.click(within(heading.closest('article') as HTMLElement).getByRole('button', { name: 'Remove setup' }));
    expect(screen.getByRole('button', { name: 'Compare (1)' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Fall.*5 ticks/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByRole('button', { name: 'Compare (0)' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Fancy Strategy Finder' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to Compare' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Compare' }));
    expect(screen.getByRole('button', { name: 'Compare (0)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fancy Strategy Finder' })).toHaveAttribute('aria-pressed', 'true');
});

it('loads older cloud rankings without broker verification on load or refresh', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Sample time/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cloud snapshot updated/)).not.toBeInTheDocument();
    expect(fetchStrategyFinder).toHaveBeenCalledWith(
        new URLSearchParams({ contract: 'rise_fall', ticks: '5', barrier: '5' }),
        expect.any(AbortSignal)
    );
    const initialRequests = (fetchStrategyFinder as jest.Mock).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rankings' }));
    await waitFor(() => expect(fetchStrategyFinder).toHaveBeenCalledTimes(initialRequests + 1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh rankings' })).toBeEnabled());
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
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
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
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('FancyTrading insights are locked'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchStrategyFinder).not.toHaveBeenCalled();
});

it('does not start a browser market scan when the prepared rankings are unavailable', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    (fetchStrategyFinder as jest.Mock).mockRejectedValueOnce(new Error('Cache unavailable'));
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Rankings are temporarily unavailable');
    expect(mockSend).not.toHaveBeenCalled();
    expect(fetchTickInsights).not.toHaveBeenCalled();
});

it('waits for the next cloud snapshot without starting a local scan', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    (fetchStrategyFinder as jest.Mock).mockResolvedValueOnce({
        access: { access: 'free' }, ticks: 5, updatedAt: 0, marketsScanned: 0, rows: [],
    });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByText(/No ranked contracts are available/)).toBeInTheDocument();
    expect(mockSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rankings' }));
    expect(await screen.findByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    expect(mockSend).not.toHaveBeenCalled();
});

it('refreshes the cloud snapshot when a mobile browser restores the page', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    fireEvent(window, new Event('pageshow'));
    expect(screen.getByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    await waitFor(() => expect(fetchStrategyFinder).toHaveBeenCalledTimes(2));
    expect(mockSend).not.toHaveBeenCalled();
});

it('shows qualifying ranked rows beyond the first seven without requesting proposals', async () => {
    mockUnavailableSymbol = 'CRASH200';
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    (fetchStrategyFinder as jest.Mock).mockResolvedValue({
        access: { access: 'free' }, ticks: 5, rows: [
            ...Array.from({ length: 21 }, (_, i) => ({ candidate: 'CALL', symbol: String(i), historical: { hits: 89, count: 100 } })),
            { candidate: 'CALL', symbol: 'AT_THRESHOLD', historical: { hits: 90, count: 100 } },
            { candidate: 'PUT', symbol: 'ABOVE_THRESHOLD', historical: { hits: 99, count: 100 } },
            { candidate: 'PUT', symbol: '1HZ100V', historical: { hits: 6, count: 10 } },
        ],
    });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    expect(await screen.findByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    expect(screen.getAllByRole('rowheader')).toHaveLength(22);
    expect(screen.queryByRole('rowheader', { name: /AT_THRESHOLD|ABOVE_THRESHOLD/ })).not.toBeInTheDocument();
    expect(mockSend).not.toHaveBeenCalled();
});

it('shows prepared rows immediately when the finder opens', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    const panel = (open: boolean) => (
        <FancyTradingDialogContext.Provider
            value={{ open, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    const { rerender } = render(panel(false));
    expect(await screen.findByText(/1HZ100V.*Fall/, { selector: 'th[scope="row"]' })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: /Fall/ })).not.toBeInTheDocument();
    rerender(panel(true));
    expect(screen.getByRole('rowheader', { name: /Fall/ })).toBeInTheDocument();
    expect(mockSend).not.toHaveBeenCalled();
});

it('keeps the broker rate-limit message inside the trade panel', async () => {
    (fetchPremiumAccess as jest.Mock).mockResolvedValue({ access: 'free' });
    render(
        <FancyTradingDialogContext.Provider
            value={{ open: true, setOpen: jest.fn(), signalOpen: false, setSignalOpen: jest.fn() }}
        >
            <TickInsights {...props} />
        </FancyTradingDialogContext.Provider>
    );
    const quote = await screen.findByRole('button', { name: 'Get live quote' });
    expect(mockSend).not.toHaveBeenCalled();
    mockRateLimitProposal = true;
    fireEvent.click(quote);
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
