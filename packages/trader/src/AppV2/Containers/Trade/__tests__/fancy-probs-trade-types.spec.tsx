import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import FancyProbsTradeTypes from '../fancy-probs-trade-types';

it('offers only supported contract families from the current market', () => {
    const onSelect = jest.fn();
    render(
        <FancyProbsTradeTypes
            value='accumulator'
            onSelect={onSelect}
            tradeTypes={[
                { value: 'accumulator', text: 'Accumulators' },
                { value: 'multiplier', text: 'Multipliers' },
                { value: 'rise_fall', text: 'Rise / Fall' },
                { value: 'even_odd', text: 'Even / Odd' },
            ]}
        />
    );
    expect(onSelect).toHaveBeenCalledWith('rise_fall');
    expect(screen.queryByRole('option', { name: /Accumulators|Multipliers/ })).not.toBeInTheDocument();
    const contracts = screen.getByRole('combobox', { name: 'Fancy Probs contract' });
    expect(screen.getByRole('option', { name: 'Rise / Fall' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Even / Odd' })).toBeInTheDocument();
    fireEvent.change(contracts, { target: { value: 'even_odd' } });
    expect(onSelect).toHaveBeenLastCalledWith('even_odd');
});

it('reports a failed contract switch inside Fancy Probs', async () => {
    const onSelect = jest.fn().mockRejectedValue(new Error('Contract unavailable'));
    render(
        <FancyProbsTradeTypes
            value='accumulator'
            onSelect={onSelect}
            tradeTypes={[{ value: 'rise_fall', text: 'Rise / Fall' }]}
        />
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not select this contract');
    expect(onSelect).toHaveBeenCalledTimes(1);
});
