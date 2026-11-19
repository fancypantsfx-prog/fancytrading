import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { redirectToSignUp } from '@deriv/shared';
import Help from '../help';

jest.mock('@deriv/shared', () => ({
    getPlatformLogo: () => 'brand/platform-logo.svg',
    redirectToSignUp: jest.fn(),
    routes: { index: '/' },
}));
jest.mock('@deriv/stores', () => ({
    observer: component => component,
    useStore: () => ({ client: { is_logged_in: false } }),
}));

it('runs the tutorial and sends account creation through the shared registration handler', () => {
    render(
        <MemoryRouter initialEntries={['/help#tutorial']}>
            <Help />
        </MemoryRouter>
    );
    const tutorial = within(screen.getByRole('region', { name: 'Trading tutorial' }));
    expect(tutorial.getByRole('heading', { name: 'Open your demo account' })).toBeInTheDocument();
    fireEvent.click(tutorial.getByRole('button', { name: 'Create a Deriv account' }));
    expect(redirectToSignUp).toHaveBeenCalledTimes(1);
    for (const title of ['Find a contract', 'Compare setups', 'Try Fancy Probs']) {
        fireEvent.click(tutorial.getByRole('button', { name: 'Next step' }));
        expect(tutorial.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(tutorial.getByRole('link', { name: 'Open trading' })).toHaveAttribute('href', '/');
    fireEvent.click(tutorial.getByRole('button', { name: 'Restart tutorial' }));
    expect(tutorial.getByRole('heading', { name: 'Open your demo account' })).toBeInTheDocument();
});
