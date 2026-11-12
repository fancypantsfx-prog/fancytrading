import { runInAction } from 'mobx';

import { fetchAccounts, resetDemoBalance } from '../../Services/accounts-api';
import ClientStore from '../client-store';

jest.mock('@deriv/shared', () => ({
    getAccountType: () => globalThis.localStorage.getItem('account_type'),
    getTrustedDomainName: () => 'localhost',
    removeCookies: jest.fn(),
}));
jest.mock('Services', () => ({}));
jest.mock('_common/base/socket_base', () => ({}));
jest.mock('../../Services/oauth', () => ({
    getStoredToken: () => 'test-token',
}));
jest.mock('../../Services/accounts-api', () => ({
    fetchAccounts: jest.fn(),
    resetDemoBalance: jest.fn(),
}));

describe('resetVirtualBalance', () => {
    let client;
    let notifications;

    beforeEach(() => {
        resetDemoBalance.mockReset();
        fetchAccounts.mockReset();
        fetchAccounts.mockResolvedValue([{ account_id: 'DEM123', balance: 10000 }]);
        localStorage.setItem('account_type', 'demo');
        notifications = {
            removeNotificationByKey: jest.fn(),
            removeNotificationMessage: jest.fn(),
            resetVirtualBalanceNotification: jest.fn(),
        };
        client = new ClientStore({ notifications });
        runInAction(() => {
            client.current_account = { loginid: 'DEM123', balance: 100 };
            client.setLoginId('DEM123');
        });
    });

    afterEach(() => {
        localStorage.removeItem('account_type');
    });

    it('prevents duplicate requests and dismisses the notification after a successful reset', async () => {
        let completeReset;
        resetDemoBalance.mockReturnValue(
            new Promise(resolve => {
                completeReset = resolve;
            })
        );

        const reset = client.resetVirtualBalance();
        await client.resetVirtualBalance();

        expect(client.is_resetting_virtual_balance).toBe(true);
        expect(resetDemoBalance).toHaveBeenCalledTimes(1);
        expect(resetDemoBalance).toHaveBeenCalledWith('DEM123');
        expect(notifications.removeNotificationMessage).not.toHaveBeenCalled();

        completeReset();
        await reset;

        expect(client.is_resetting_virtual_balance).toBe(false);
        expect(client.balance).toBe('10000');
        expect(notifications.removeNotificationMessage).toHaveBeenCalledWith({
            key: 'reset_virtual_balance',
            should_show_again: true,
        });
    });

    it('keeps the notification available for retry if the reset fails', async () => {
        resetDemoBalance.mockRejectedValueOnce(new Error('Request failed'));

        await client.resetVirtualBalance();

        expect(client.virtual_balance_reset_failed).toBe(true);
        expect(client.is_resetting_virtual_balance).toBe(false);
        expect(notifications.removeNotificationMessage).not.toHaveBeenCalled();
    });

    it('skips the reset when the active account is real', async () => {
        localStorage.setItem('account_type', 'real');
        runInAction(() => {
            client.current_account = { loginid: 'CR123', balance: 100 };
            client.setLoginId('CR123');
        });

        await client.resetVirtualBalance();

        expect(resetDemoBalance).not.toHaveBeenCalled();
    });
});
