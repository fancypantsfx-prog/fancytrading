import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fetchPremiumAccess, fetchTickInsights } from '@deriv/api';
import { processPurchase } from 'Stores/Modules/Trading/Actions/purchase';
import AutoTrading from '../auto-trading';
import { FancyTradingDialogContext } from '../fancy-trading-dialog-context';

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
let mockQuotePayout = 18;
let mockStrategyListError;
const mockSend = jest.fn(async (request) => {
    if (request.ticks_history) {
        return { pip_size: 2, history: {
            prices: Array.from({ length: 400 }, (_, index) => 100 + index),
            times: Array.from({ length: 400 }, (_, index) => 1800000000 + index),
        } };
    }
    if (request.proposal) return { proposal: { ask_price: request.amount, payout: mockQuotePayout } };
    if (request.auto_list_strategies && mockStrategyListError)
        return { error: { message: mockStrategyListError } };
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
const mockUnsubscribe = jest.fn();
const mockWS = {
    send: mockSend,
    subscribeProposal: jest.fn((request, respond) => {
        respond({ proposal: { id: 'streaming-proposal', ask_price: request.amount, payout: mockQuotePayout } });
        return { unsubscribe: mockUnsubscribe };
    }),
};
jest.mock('Stores/Modules/Trading/Actions/purchase', () => ({ processPurchase: jest.fn() }));
const mockHost = {
    client: { loginid: 'VRTC123', is_logged_in: true, is_authorize: true },
    common: { is_socket_opened: true },
    ui: { is_switching_account: false },
};
jest.mock('mobx-react-lite', () => ({ observer: (component) => component }));
jest.mock('@deriv/api', () => ({ fetchPremiumAccess: jest.fn(), fetchTickInsights: jest.fn() }));
jest.mock('@deriv/shared', () => ({
    getPlatformLogo: () => 'brand/platform-logo.svg',
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
    await screen.findByLabelText('Take profit *');
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Take profit *'), {target:{value:'100'}});
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Stop loss *'), {target:{value:'50'}});
    return screen.getByRole('dialog');
};
const setLimit = (menu, label, value) => {
    fireEvent.change(within(menu).getByLabelText(label + ' *'), { target: { value } });
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
    mockWS.subscribeProposal.mockClear();
    mockUnsubscribe.mockClear();
    processPurchase.mockReset().mockResolvedValue({ buy: { contract_id: 12345 } });
    localStorage.clear();
    fetchPremiumAccess.mockReset().mockResolvedValue({ access: 'free' });
    fetchTickInsights.mockReset();
    mockQuotePayout = 18;
    mockStrategyListError = undefined;
    mockHost.client.loginid = 'VRTC123';
    mockStrategy.supported_contract_types = ['CALL', 'PUT'];
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
    expect(within(menu).getByLabelText('Take profit *')).toHaveValue(55);
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
    expect(within(menu).getByLabelText('Take profit *')).toHaveValue(30);
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
        expect(request.strategy_parameters).toEqual({ initial_stake: 25, stake_list: [25, 20, 40], take_profit: 100, stop_loss: 50 });
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
        expect(request.strategy_parameters).toEqual({ initial_stake: '5.25', multiplier: 2, take_profit: 100, stop_loss: 50 });
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
    setLimit(menu, 'Take profit', '100');
    setLimit(menu, 'Stop loss', '50');
    fireEvent.change(stake, { target: { value: '7.5' } });
    fireEvent.click(within(menu).getByRole('button', { name: 'Start automatic trading' }));
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
it('optional zero-valued maximum defaults are omitted instead of submitted as positive limits', async () => {
    mockStrategy.parameters.max_rounds = { type: 'integer', default: 0 };
    render(<AutoTrading />);
    await waitReady();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('button', {name:'Done'}));
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

it('requires positive TP and SL with the actual live strategy schema', async () => {
 mockStrategy.parameters = {"$schema":"http://json-schema.org/draft-07/schema#","type":"object","required":["initial_stake","take_profit","stop_loss"],"additionalProperties":false,"properties":{"initial_stake":{"type":"string","description":"Stake used for the first contract and after a win."},"max_stake":{"type":"string","description":"Upper limit for stake multiplying. Must be >= initial_stake. If omitted, there is no upper limit."},"multiplier":{"type":"number","description":"Factor applied to the stake after each loss. Defaults to 2.","exclusiveMinimum":1,"maximum":10},"take_profit":{"type":"string","description":"Stop when total payout minus total stake reaches or exceeds this value. Must be > 0."},"stop_loss":{"type":"string","description":"Stop when total stake minus total payout reaches or exceeds this value. Must be > 0."},"max_contracts":{"type":"integer","description":"Stop after this many contracts have been purchased. Must be > 0. Zero or omitted means no limit."}}};
 render(<AutoTrading />); await waitReady();
 fireEvent.click(screen.getByRole('button', {name:'Automatic', exact:true}));
 fireEvent.click(screen.getByRole('button', {name:/Automatic settings/}));
 const menu = screen.getByRole('dialog');
 const tp = await within(menu).findByLabelText('Take profit *');
 const sl = within(menu).getByLabelText('Stop loss *');
 expect(tp).toBeEnabled(); expect(sl).toBeEnabled();
 expect(within(menu).queryByRole('switch', {name:'Enable stop loss'})).not.toBeInTheDocument();
 expect(within(menu).getByRole('button', {name:'Start automatic trading'})).toBeDisabled();
 fireEvent.change(tp,{target:{value:'20'}});
 fireEvent.change(sl,{target:{value:'0'}});
 expect(within(menu).getByRole('button', {name:'Start automatic trading'})).toBeDisabled();
 fireEvent.change(sl,{target:{value:'10'}});
 fireEvent.click(within(menu).getByRole('button', {name:'Start automatic trading'}));
 await waitFor(()=>expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({auto_start:1,strategy_parameters:{initial_stake:'10',take_profit:'20',stop_loss:'10'}})));
 expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

const reviewFancyTrade = async (candidate = 'CALL', automatic = true, recoverStatus = false) => {
    const sample = { hits: 30, count: 39 };
    fetchTickInsights.mockResolvedValue({
        access: { access: 'free' },
        currency: 'USD',
        ticks: 5,
        firstTick: 1800000000,
        lastTick: 1800000399,
        rows: [
            {
                candidate,
                stake: 10,
                payout: candidate === 'CALL' ? 18 : 11.592740743,
                estimated: candidate !== 'CALL',
                older: sample,
                recent: sample,
                historical: { hits: 60, count: 78 },
            },
        ],
    });
    render(
        <FancyTradingDialogContext.Provider value={{ open: true, setOpen: jest.fn() }}>
            <AutoTrading />
        </FancyTradingDialogContext.Provider>
    );
    await waitReady();
    if (candidate !== 'CALL')
        fireEvent.change(await screen.findByLabelText('Contract group'), { target: { value: 'accumulator' } });
    if (automatic) fireEvent.change(await screen.findByLabelText(/Run stop loss/), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan instruments' }));
    if (recoverStatus) {
        await screen.findByText('Strategy list temporarily unavailable');
        mockStrategyListError = undefined;
        fireEvent.click(await screen.findByRole('button', { name: 'Refresh automatic status' }));
    }
    const review = await screen.findByRole('button', {
        name: automatic ? (candidate === 'CALL' ? 'Review Rise' : 'Review 3% growth') : 'Buy Rise once',
    });
    await waitFor(() => expect(review).toBeEnabled());
    fireEvent.click(review);
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
};

it('starts the reviewed accumulator on confirmation with a fixed stake and separate contract and run limits', async () => {
    mockStrategy.supported_contract_types.push('ACCU');
    await reviewFancyTrade('3');
    const confirm = screen.getByRole('button', { name: 'Confirm and start run' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/Automatic run new-run started/);

    expect(mockSend.mock.calls.filter(([request]) => request.auto_start)).toEqual([
        [
            {
                auto_start: 1,
                strategy_id: 'martingale',
                contract_template: {
                    contract_type: 'ACCU',
                    currency: 'USD',
                    underlying_symbol: 'R_100',
                    amount: 10,
                    basis: 'stake',
                    growth_rate: 0.03,
                    limit_order: { take_profit: 1.59 },
                },
                strategy_parameters: { multiplier: 1, stop_loss: 25 },
            },
        ],
    ]);
});

it.each([
    [
        'an updated payout',
        () => {
            mockQuotePayout = 17;
        },
        'The quote changed',
    ],
    [
        'expired access',
        () => {
            fetchPremiumAccess.mockResolvedValueOnce({ access: 'locked' });
        },
        'FancyTrading access ended',
    ],
    [
        'an account change',
        () => {
            fetchPremiumAccess.mockImplementationOnce(async () => {
                mockHost.client.loginid = 'VRTC456';
                return { access: 'free' };
            });
        },
        'The account or market changed',
    ],
])('blocks a FancyTrading start with %s', async (_condition, change, message) => {
    await reviewFancyTrade();
    change();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and start run' }));
    const dialog = screen.getByRole('dialog', { name: 'FancyTrading' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
});

it('buys exactly one contract from a fresh streaming proposal with the reviewed stake', async () => {
    mockStrategy.supported_contract_types = [];
    await reviewFancyTrade('CALL', false);
    expect(screen.getByRole('region', { name: 'Review one contract' })).toHaveTextContent('The full stake is at risk.');
    expect(processPurchase).not.toHaveBeenCalled();

    const confirm = screen.getByRole('button', { name: 'Confirm and buy once' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await screen.findByText(/Contract 12345 purchased/);
    expect(mockWS.subscribeProposal).toHaveBeenCalledWith(
        {
            contract_type: 'CALL',
            currency: 'USD',
            underlying_symbol: 'R_100',
            amount: 10,
            basis: 'stake',
            duration: 5,
            duration_unit: 't',
            subscribe: 1,
        },
        expect.any(Function)
    );
    expect(processPurchase).toHaveBeenCalledTimes(1);
    expect(processPurchase).toHaveBeenCalledWith('streaming-proposal', 10);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls.some(([request]) => request.auto_start)).toBe(false);
});

it('blocks a one-off purchase when the streaming payout changes', async () => {
    await reviewFancyTrade('CALL', false);
    mockQuotePayout = 17;
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and buy once' }));
    expect(await within(screen.getByRole('dialog', { name: 'FancyTrading' })).findByRole('alert')).toHaveTextContent(
        'The quote changed'
    );
    expect(processPurchase).not.toHaveBeenCalled();
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
});

it('blocks a second one-off purchase after an unconfirmed broker response', async () => {
    await reviewFancyTrade('CALL', false);
    processPurchase.mockRejectedValueOnce(new Error('Connection closed'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and buy once' }));
    expect(await within(screen.getByRole('dialog', { name: 'FancyTrading' })).findByRole('alert')).toHaveTextContent(
        'Purchase status is unknown'
    );
    expect(screen.getByRole('button', { name: 'Confirm and buy once' })).toBeDisabled();
    expect(processPurchase).toHaveBeenCalledTimes(1);
});

it('recovers automatic status and starts the explicitly selected strategy with Deriv’s required limits', async () => {
    mockStrategyListError = 'Strategy list temporarily unavailable';
    mockStrategy.description = 'Increases the stake after each loss.';
    mockStrategy.parameters = {
        type: 'object',
        additionalProperties: false,
        required: ['initial_stake', 'take_profit', 'stop_loss'],
        properties: {
            initial_stake: { type: 'string' },
            multiplier: { type: 'number', exclusiveMinimum: 1, maximum: 10 },
            max_stake: { type: 'string' },
            take_profit: { type: 'string' },
            stop_loss: { type: 'string' },
        },
    };

    await reviewFancyTrade('CALL', true, true);
    const review = within(screen.getByRole('region', { name: 'Review automatic run' }));
    const confirm = review.getByRole('button', { name: 'Confirm and start run' });
    expect(confirm).toBeDisabled();
    fireEvent.change(review.getByLabelText('Automatic strategy'), { target: { value: 'martingale' } });
    expect(review.getByText('Increases the stake after each loss.')).toBeInTheDocument();
    fireEvent.change(review.getByLabelText('Stake multiplier'), { target: { value: '2' } });
    fireEvent.change(review.getByLabelText(/Maximum stake/), { target: { value: '20' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(review.getByLabelText(/Required run take profit/), { target: { value: '15' } });
    fireEvent.click(confirm);
    await screen.findByText(/Automatic run new-run started/);

    expect(mockSend.mock.calls.filter(([request]) => request.auto_start)).toEqual([
        [expect.objectContaining({
            strategy_id: 'martingale',
            strategy_parameters: { initial_stake: '10', multiplier: 2, max_stake: '20', take_profit: '15', stop_loss: '25' },
        })],
    ]);
});
