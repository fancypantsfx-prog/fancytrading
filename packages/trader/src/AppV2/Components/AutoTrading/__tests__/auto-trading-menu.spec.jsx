import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AutoTrading from '../auto-trading';

const mockStrategy = {
    strategy_id: 'martingale',
    display_name: 'Martingale',
    supported_contract_types: ['CALL', 'PUT'],
    parameters: { multiplier: { type: 'number', default: 2 }, max_stake: { type: 'number', default: 40 } },
};
const mockTrade = {
    amount: 10,
    currency: 'USD',
    symbol: 'R_100',
    duration: 5,
    duration_unit: 't',
    basis: 'stake',
    trade_types: { CALL: {}, PUT: {} },
    contract_type: 'rise_fall',
    trade_type_tab: 'CALL',
    proposal_info: {},
    is_trade_enabled_v2: true,
};
let mockRuns = [];
const mockSend = jest.fn(async (request) => {
    if (request.auto_list_strategies)
        return { auto_list_strategies: { strategies: JSON.parse(JSON.stringify([mockStrategy])) } };
    if (request.auto_list) return { auto_list: { runs: mockRuns } };
    if (request.auto_start)
        return {
            auto_start: {
                run_id: 'new-run',
                status: 'running',
                strategy_id: 'martingale',
                start_time: 100,
                strategy_parameters: request.strategy_parameters,
                contract_template: request.contract_template,
            },
        };
    if (request.auto_stop) return { auto_stop: { ...mockRuns[0], status: 'stopped' } };
    return {};
});
const mockWS = { send: mockSend };
const mockHost = {
    client: { loginid: 'VRTC123', is_logged_in: true, is_authorize: true },
    common: { is_socket_opened: true },
    ui: { is_switching_account: false },
};
jest.mock('mobx-react-lite', () => ({ observer: (component) => component }));
jest.mock('@deriv/shared', () => ({
    useWS: () => mockWS,
    getSymbolDisplayName: (symbol) => symbol,
    getContractTypeDisplay: (type) => type,
}));
jest.mock('@deriv/stores', () => ({ useStore: () => mockHost }));
jest.mock('Stores/useTraderStores', () => ({ useTraderStore: () => mockTrade }));
jest.mock('AppV2/Utils/trade-types-utils', () => ({ getDisplayedContractTypes: () => ['CALL', 'PUT'] }));
jest.mock('AppV2/Utils/trade-params-utils', () => ({
    getProposalRequestObject: ({ trade_type }) => ({
        proposal: 1,
        contract_type: trade_type,
        currency: mockTrade.currency,
        underlying_symbol: mockTrade.symbol,
        amount: mockTrade.amount,
        basis: mockTrade.basis,
        duration: mockTrade.duration,
        duration_unit: mockTrade.duration_unit,
    }),
}));
jest.mock('AppV2/Components/PurchaseButton', () => ({
    __esModule: true,
    default: (props) => (
        <button type='button' onClick={props.onPurchaseSuccess}>
            Manual purchase
        </button>
    ),
}));

const waitReady = () => waitFor(() => expect(mockSend).toHaveBeenCalledWith({ auto_list: 1 }));
const openMenu = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('open'));
    await screen.findByLabelText('Take profit');
    return screen.getByRole('dialog');
};
beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
    };
});
beforeEach(() => {
    mockSend.mockClear();
    mockRuns = [];
    mockTrade.amount = 10;
    mockTrade.symbol = 'R_100';
    mockTrade.duration = 5;
    mockTrade.trade_type_tab = 'CALL';
});
it('preserves the manual purchase component and success callback', async () => {
    const success = jest.fn();
    render(<AutoTrading onPurchaseSuccess={success} />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Manual purchase' }));
    expect(success).toHaveBeenCalledTimes(1);
});
it('opens a dialog menu and closes with Done without placing a trade', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).getByRole('heading', { name: 'Risk management' })).toBeInTheDocument();
    expect(within(menu).queryByText('Your trade settings')).not.toBeInTheDocument();
    expect(within(menu).queryByLabelText('Contract direction')).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(menu).not.toHaveAttribute('open'));
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
});
it('uses changed manual settings with the configured run limits in auto_start', async () => {
    const view = render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByLabelText('Take profit'), { target: { value: '30' } });
    fireEvent.change(within(menu).getByLabelText('Stop loss'), { target: { value: '20' } });
    mockTrade.amount = 25;
    mockTrade.duration = 7;
    mockTrade.symbol = 'R_50';
    mockTrade.trade_type_tab = 'PUT';
    view.rerender(<AutoTrading />);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(menu).not.toHaveAttribute('open'));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    await waitFor(() =>
        expect(mockSend).toHaveBeenCalledWith({
            auto_start: 1,
            strategy_id: 'martingale',
            contract_template: {
                amount: 25,
                basis: 'stake',
                currency: 'USD',
                underlying_symbol: 'R_50',
                contract_type: 'PUT',
                duration: 7,
                duration_unit: 't',
            },
            strategy_parameters: { multiplier: 2, max_stake: 40, take_profit: 30, stop_loss: 20 },
        })
    );
});
it('preserves risk edits through a strategy refresh', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByLabelText('Take profit'), { target: { value: '55' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(menu).getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(within(menu).getByLabelText('Take profit')).toHaveValue(55);
});
it('shows unavailable cooldown honestly without sending invented options', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).getByText('Cooldown is not available with this strategy.')).toBeInTheDocument();
    expect(within(menu).queryByLabelText('Cooldown in seconds')).not.toBeInTheDocument();
});
it('blocks a maximum stake below the stake from Manual', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByLabelText('Maximum stake'), { target: { value: '5' } });
    expect(within(menu).getByRole('alert')).toHaveTextContent('Maximum stake must cover');
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Start automatic trading' })).toBeDisabled();
});
it('keeps Stop available for an existing run while the selected market is closed', async () => {
    mockRuns = [
        {
            run_id: 'existing-run',
            status: 'running',
            strategy_id: 'martingale',
            contract_template: { amount: 10, currency: 'USD', underlying_symbol: 'R_100', contract_type: 'CALL' },
            strategy_parameters: {},
        },
    ];
    render(<AutoTrading is_market_closed />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('button', { name: 'Close automatic settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith({ auto_stop: 1, run_id: 'existing-run' }));
});

it('No martingale preserves run limits and sends a fixed 1x stake multiplier', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.change(within(menu).getByLabelText('Take profit'), { target: { value: '30' } });
    fireEvent.change(within(menu).getByLabelText('Stop loss'), { target: { value: '20' } });
    fireEvent.change(within(menu).getByLabelText('Stake method'), { target: { value: '__fixed_stake__' } });
    await waitFor(() => expect(within(menu).queryByLabelText('Martingale multiplier')).not.toBeInTheDocument());
    expect(within(menu).getByLabelText('Take profit')).toHaveValue(30);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    await waitFor(() =>
        expect(mockSend.mock.calls.find(([request]) => request.auto_start)?.[0].strategy_parameters).toEqual({
            multiplier: 1,
            max_stake: 40,
            take_profit: 30,
            stop_loss: 20,
        })
    );
});

it('scrolling a focused risk input releases it instead of changing its value', async () => {
    render(<AutoTrading />); await waitReady(); const menu = await openMenu();
    const input = within(menu).getByLabelText('Stop loss');
    input.focus(); expect(input).toHaveFocus();
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input).not.toHaveFocus();
});
