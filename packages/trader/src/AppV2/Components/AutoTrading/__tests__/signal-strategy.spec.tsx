import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SignalStrategy from '../signal-strategy';
import type { TInsightTrade } from '../tick-insights-data';

let mockTick: (value: unknown) => void;
let mockSettlement: (value: unknown) => void;
const mockWS = {
    setOnReconnect: jest.fn(),
    removeOnReconnect: jest.fn(),
    send: jest.fn(async () => ({ pip_size: 0 })),
    subscribeTicks: jest.fn((_symbol, callback) => {
        mockTick = callback;
        return { unsubscribe: jest.fn() };
    }),
    subscribeProposalOpenContract: jest.fn((_id, callback) => {
        mockSettlement = callback;
        return { unsubscribe: jest.fn() };
    }),
};

jest.mock('@deriv/shared', () => ({ useWS: () => mockWS, getDecimalPlaces: () => 2 }));

it.each([
    { demo: false, candidate: 'DIGITEVEN' },
    { demo: true, candidate: 'DIGITDIFF:7' },
])('waits for a streak and stops at the trade limit for $candidate (demo $demo)', async ({ demo, candidate }) => {
    jest.clearAllMocks();
    localStorage.clear();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
        this.removeAttribute('open');
    };
    Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: (_key: string, _options: object, callback: (lock: object) => Promise<void>) => callback({}) },
    });
    const buy = jest.fn(async (_trade: TInsightTrade, _signal: AbortSignal, beforePurchase: () => void) => {
        beforePurchase();
        return '123';
    });
    render(
        <SignalStrategy
            symbol='R_100'
            currency='USD'
            contract={candidate.split(':')[0]}
            account={{ id: 'CR123', demo }}
            initialStake={10}
            initialTicks={1}
            block=''
            buy={buy}
        />
    );
    const emit = (quote: number, epoch: number) => act(() => mockTick({ tick: { quote, epoch } }));
    await waitFor(() => expect(mockWS.subscribeTicks).toHaveBeenCalled(), { timeout: 3000 });
    emit(demo ? 107 : 101, 1);
    if (demo) {
        fireEvent.click(screen.getByRole('button', { name: 'Rules' }));
        fireEvent.change(screen.getByLabelText('Digit'), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Automatic settings' }));
    fireEvent.change(screen.getByLabelText('Maximum trades'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    const start = screen.getByRole('button', { name: demo ? 'Start on demo' : 'Start on real account' });
    if (!demo) {
        expect(start).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox'));
    }
    fireEvent.click(start);
    if (demo) {
        expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
        const [reconnect] = mockWS.setOnReconnect.mock.calls[0];
        act(() => reconnect());
        expect(screen.getByText('Run paused. Waiting for fresh ticks…')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Stop run' })).toBeInTheDocument();
        await waitFor(() => expect(mockWS.subscribeTicks).toHaveBeenCalledTimes(2), { timeout: 3000 });
    }
    emit(101, 2);
    emit(102, 3);
    emit(104, 4);
    expect(buy).not.toHaveBeenCalled();
    emit(106, 5);
    emit(108, 6);
    await waitFor(() => expect(mockWS.subscribeProposalOpenContract).toHaveBeenCalled(), { timeout: 3000 });
    expect(buy).toHaveBeenCalledTimes(1);
    expect(buy).toHaveBeenCalledWith(
        expect.objectContaining({ candidate, stake: 10 }),
        expect.anything(),
        expect.any(Function)
    );
    expect(localStorage.getItem('fancytrading-rule-purchase:CR123')).toBe('pending');
    act(() => mockSettlement({ proposal_open_contract: { contract_id: 123, is_sold: 1, profit: '8' } }));
    expect(await screen.findByText('Run finished. One of your limits was reached.')).toBeInTheDocument();
    expect(localStorage.getItem('fancytrading-rule-purchase:CR123')).toBeNull();
    emit(111, 7);
    expect(buy).toHaveBeenCalledTimes(1);
});

it('shows barrier rules and subscribes again when the trading connection returns', async () => {
    jest.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function () {
        this.setAttribute('open', '');
    };
    const buy = jest.fn();
    render(
        <SignalStrategy
            symbol='R_100'
            currency='USD'
            contract='DIGITOVER'
            account={{ id: 'CR123', demo: true }}
            initialStake={10}
            initialTicks={1}
            block=''
            buy={buy}
        />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rules' }));
    const watch = screen.getByLabelText('Watch for');
    expect(watch).toHaveValue('over');
    expect(watch).toHaveTextContent('Digits above the barrier');
    expect(watch).not.toHaveTextContent('Even digits');
    fireEvent.click(screen.getByRole('button', { name: 'Help for Rules' }));
    expect(screen.getByText(/Choose which tick movement/)).toBeVisible();

    await waitFor(() => expect(mockWS.subscribeTicks).toHaveBeenCalledTimes(1));
    const previous = mockTick;
    const [onReconnect] = mockWS.setOnReconnect.mock.calls[0];
    act(() => onReconnect());
    await waitFor(() => expect(mockWS.subscribeTicks).toHaveBeenCalledTimes(2));
    act(() => previous({ tick: { quote: 106, epoch: 1 } }));
    expect(screen.getByRole('button', { name: 'Start on demo' })).toBeDisabled();
    act(() => mockTick({ tick: { quote: 106, epoch: 2, underlying_symbol: 'R_100' } }));
    expect(screen.getByRole('button', { name: 'Start on demo' })).toBeEnabled();
    expect(buy).not.toHaveBeenCalled();
});
