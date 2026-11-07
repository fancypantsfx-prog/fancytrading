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
    getDecimalPlaces: () => 2,
    getSymbolDisplayName: (symbol) => symbol,
    getContractTypeDisplay: (type) => type,
}));
jest.mock('@deriv/stores', () => ({ useStore: () => mockHost }));
jest.mock('Stores/useTraderStores', () => ({ useTraderStore: () => mockTrade }));
jest.mock('AppV2/Utils/trade-types-utils', () => ({ getDisplayedContractTypes: () => ['CALL', 'PUT'] }));
jest.mock('AppV2/Utils/trade-params-utils', () => ({
    getProposalRequestObject: ({ trade_type, new_values = {} }) => ({
        proposal: 1,
        contract_type: trade_type,
        currency: mockTrade.currency,
        underlying_symbol: mockTrade.symbol,
        amount: new_values.amount ?? mockTrade.amount,
        basis: new_values.basis ?? mockTrade.basis,
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
    fireEvent.click(screen.getByRole('button', { name: /Automatic settings/ }));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('open'));
    await screen.findByLabelText('Take profit');
    return screen.getByRole('dialog');
};
const setLimit = (menu, label, value) => {
    const toggle = within(menu).getByRole('switch', { name: 'Enable ' + label.toLowerCase() });
    if (toggle.getAttribute('aria-checked') !== 'true') fireEvent.click(toggle);
    fireEvent.change(within(menu).getByLabelText(label), { target: { value } });
};
const startAndConfirm = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    const warning = screen.queryByRole('alertdialog');
    if (warning) fireEvent.click(within(warning).getByRole('button', { name: 'Start without stop loss' }));
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
    mockStrategy.strategy_id = 'martingale';
    mockStrategy.parameters = {
        multiplier: { type: 'number', default: 2 },
        max_stake: { type: 'number', default: 40 },
    };
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
    setLimit(menu, 'Take profit', '30');
    setLimit(menu, 'Stop loss', '20');
    mockTrade.amount = 25;
    mockTrade.duration = 7;
    mockTrade.symbol = 'R_50';
    mockTrade.trade_type_tab = 'PUT';
    view.rerender(<AutoTrading />);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(menu).not.toHaveAttribute('open'));
    startAndConfirm();
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
    setLimit(menu, 'Take profit', '55');
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
    setLimit(menu, 'Take profit', '30');
    setLimit(menu, 'Stop loss', '20');
    fireEvent.change(within(menu).getByLabelText('Stake method'), { target: { value: '__fixed_stake__' } });
    await waitFor(() => expect(within(menu).queryByLabelText('Martingale multiplier')).not.toBeInTheDocument());
    expect(within(menu).getByLabelText('Take profit')).toHaveValue(30);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    startAndConfirm();
    await waitFor(() =>
        expect(mockSend.mock.calls.find(([request]) => request.auto_start)?.[0].strategy_parameters).toEqual({
            multiplier: 1,
            max_stake: 40,
            take_profit: 30,
            stop_loss: 20,
        })
    );
});

it('focused numeric inputs change with the wheel and stay within numeric steps', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    const input = within(menu).getByLabelText('Martingale multiplier');
    input.focus();
    fireEvent.wheel(input, { deltaY: -100 });
    expect(input).toHaveFocus();
    expect(input).toHaveValue(2.1);
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input).toHaveValue(2);
});

it('profit and loss limits start off and are omitted from auto_start', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).getByRole('switch', { name: 'Enable take profit' })).toHaveAttribute('aria-checked', 'false');
    expect(within(menu).getByLabelText('Take profit')).toBeDisabled();
    expect(within(menu).getByLabelText('Stop loss')).toBeDisabled();
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    startAndConfirm();
    await waitFor(() =>
        expect(mockSend.mock.calls.find(([request]) => request.auto_start)?.[0].strategy_parameters).toEqual({
            multiplier: 2,
            max_stake: 40,
        })
    );
});
it('enabled blank limits block Start until filled or switched off', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('switch', { name: 'Enable take profit' }));
    expect(within(menu).getByLabelText('Take profit')).toBeEnabled();
    expect(within(menu).getByRole('alert')).toHaveTextContent('Enter take profit or switch it off');
    fireEvent.click(within(menu).getByRole('switch', { name: 'Enable take profit' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Start automatic trading' })).toBeEnabled();
});
it('turning a limit off removes its previous amount from the request', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    setLimit(menu, 'Take profit', '30');
    setLimit(menu, 'Stop loss', '20');
    fireEvent.click(within(menu).getByRole('switch', { name: 'Enable take profit' }));
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    startAndConfirm();
    await waitFor(() =>
        expect(mockSend.mock.calls.find(([request]) => request.auto_start)?.[0].strategy_parameters).toEqual({
            multiplier: 2,
            max_stake: 40,
            stop_loss: 20,
        })
    );
});
it('plus, minus and keyboard arrows adjust numeric controls without floating point drift', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    const input = within(menu).getByLabelText('Martingale multiplier');
    fireEvent.click(within(menu).getByRole('button', { name: 'Increase martingale multiplier' }));
    expect(input).toHaveValue(2.1);
    fireEvent.click(within(menu).getByRole('button', { name: 'Decrease martingale multiplier' }));
    expect(input).toHaveValue(2);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue(2.1);
});
it('initial stake and stake-list first entry come from Manual without a second input', async () => {
    mockStrategy.strategy_id = 'stake_list';
    mockStrategy.parameters = {
        initial_stake: { type: 'number', default: 999 },
        stake_list: { type: 'array', items: { type: 'number' }, default: [10, 20, 40] },
    };
    const view = render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).queryByLabelText('Initial stake')).not.toBeInTheDocument();
    expect(within(menu).getByLabelText('Recovery stakes')).toHaveValue('[20,40]');
    mockTrade.amount = 25;
    view.rerender(<AutoTrading />);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    startAndConfirm();
    await waitFor(() => {
        const request = mockSend.mock.calls.find(([request]) => request.auto_start)?.[0];
        expect(request.contract_template.amount).toBe(25);
        expect(request.strategy_parameters).toEqual({ initial_stake: 25, stake_list: [25, 20, 40] });
    });
});

it('Automatic only switches mode; settings open from their own button', async () => {
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Automatic settings/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Automatic settings/ }));
    expect(screen.getByRole('dialog')).toHaveAttribute('open');
});

it('can start with the live text-typed initial_stake inherited from Manual', async () => {
    mockTrade.amount = 5;
    mockStrategy.parameters = {
        type: 'object',
        required: ['initial_stake'],
        properties: { initial_stake: { type: 'string' }, multiplier: { type: 'number', default: 2 } },
    };
    const view = render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).queryByLabelText('Initial stake')).not.toBeInTheDocument();
    expect(within(menu).queryByText(/Parameters.initial_stake/)).not.toBeInTheDocument();
    mockTrade.amount = 5.25;
    view.rerender(<AutoTrading />);
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    const start = screen.getByRole('button', { name: 'Start automatic trading' });
    expect(start).toBeEnabled();
    startAndConfirm();
    await waitFor(() => {
        const request = mockSend.mock.calls.find(([request]) => request.auto_start)?.[0];
        expect(request.contract_template.amount).toBe(5.25);
        expect(request.strategy_parameters).toEqual({ initial_stake: '5.25', multiplier: 2 });
    });
});

it('automatic stake is the first input and drives both request stake fields', async () => {
    mockStrategy.parameters.initial_stake = { type: 'string' };
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    expect(screen.queryByRole('spinbutton', { name: /Automatic stake/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Automatic settings/ }));
    const menu = screen.getByRole('dialog');
    const stake = within(menu).getByRole('spinbutton', { name: /Automatic stake/ });
    expect(within(menu).getAllByRole('spinbutton')[0]).toBe(stake);
    expect(stake).toHaveValue(10);
    fireEvent.change(stake, { target: { value: '7.5' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Start automatic trading' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start without stop loss' }));
    await waitFor(() => {
        const request = mockSend.mock.calls.find(([request]) => request.auto_start)?.[0];
        expect(request.contract_template.amount).toBe(7.5);
        expect(request.strategy_parameters.initial_stake).toBe('7.5');
    });
});
it('blank or zero automatic stake blocks Start before a request', async () => {
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: /Automatic settings/ }));
    const menu = screen.getByRole('dialog');
    const stake = within(menu).getByRole('spinbutton', { name: /Automatic stake/ });
    for (const value of ['', '0']) {
        fireEvent.change(stake, { target: { value } });
        expect(within(menu).getByRole('button', { name: 'Start automatic trading' })).toBeDisabled();
        expect(within(menu).getByRole('alert')).toHaveTextContent('Automatic stake must be greater than 0');
    }
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
});
it('no stop loss requires confirmation and Cancel sends nothing', async () => {
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    const warning = screen.getByRole('alertdialog');
    expect(warning).toHaveTextContent('Start without a stop loss?');
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
    fireEvent.click(within(warning).getByRole('button', { name: 'Cancel' }));
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
});
it('explicit no-stop-loss confirmation starts exactly one run', async () => {
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start without stop loss' }));
    await waitFor(() => expect(mockSend.mock.calls.filter(([request]) => request.auto_start)).toHaveLength(1));
});
it('a positive run stop loss starts without the heads-up', async () => {
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    setLimit(menu, 'Stop loss', '20');
    fireEvent.click(within(menu).getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(mockSend.mock.calls.filter(([request]) => request.auto_start)).toHaveLength(1));
});
it('changed settings invalidate a pending no-stop-loss confirmation', async () => {
    const view = render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Start automatic trading' }));
    mockTrade.amount = 15;
    view.rerender(<AutoTrading />);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Start without stop loss' }));
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('Trade settings changed');
});
it('optional zero-valued maximum defaults are omitted instead of submitted as positive limits', async () => {
    mockStrategy.parameters.max_rounds = { type: 'integer', default: 0 };
    render(<AutoTrading />);
    await waitReady();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic', exact: true }));
    startAndConfirm();
    await waitFor(() => {
        const request = mockSend.mock.calls.find(([request]) => request.auto_start)?.[0];
        expect(request).toBeDefined();
        expect(request.strategy_parameters).not.toHaveProperty('max_rounds');
    });
});

it('decimal-string stop loss is editable and starts without an unnecessary warning', async () => {
    mockStrategy.parameters.stop_loss = { type: 'string' };
    mockStrategy.parameters.max_stake = { type: 'string', default: '0.00' };
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    expect(within(menu).getByLabelText('Maximum stake')).toHaveValue(null);
    setLimit(menu, 'Stop loss', '20.00');
    fireEvent.click(within(menu).getByRole('button', { name: 'Start automatic trading' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => {
        const request = mockSend.mock.calls.find(([request]) => request.auto_start)?.[0];
        expect(request.strategy_parameters.stop_loss).toBe('20.00');
        expect(request.strategy_parameters).not.toHaveProperty('max_stake');
    });
});
