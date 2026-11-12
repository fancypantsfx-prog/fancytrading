import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SignalStrategy from '../signal-strategy';
import type { TInsightTrade } from '../tick-insights-data';

let mockTick: (value: unknown) => void;
let mockSettlement: (value: unknown) => void;
const mockWS = {
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
            account={{ id: 'CR123', demo }}
            initialStake={10}
            initialTicks={1}
            block=''
            buy={buy}
        />
    );
    const emit = (quote: number, epoch: number) => act(() => mockTick({ tick: { quote, epoch } }));
    await waitFor(() => expect(mockWS.subscribeTicks).toHaveBeenCalled(), { timeout: 3000 });
    emit(100, 1);
    if (demo) {
        fireEvent.change(screen.getByLabelText('What to buy'), { target: { value: 'match' } });
        fireEvent.change(screen.getByLabelText('Which side'), { target: { value: 'second' } });
        fireEvent.change(screen.getByLabelText('Digit'), { target: { value: '7' } });
    }
    fireEvent.change(screen.getByLabelText('Maximum trades'), { target: { value: '1' } });
    const start = screen.getByRole('button', { name: demo ? 'Start on demo' : 'Start on real account' });
    if (!demo) {
        expect(start).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox'));
    }
    fireEvent.click(start);
    emit(101, 2);
    emit(103, 3);
    emit(105, 4);
    expect(buy).not.toHaveBeenCalled();
    emit(107, 5);
    emit(109, 6);
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
