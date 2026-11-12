import { resetDemoBalance } from '../accounts-api';

jest.mock('@deriv/shared', () => ({
    getApiV4BaseUrl: () => 'https://api.deriv.com',
    getAppId: () => 123,
}));

jest.mock('../oauth', () => ({
    getStoredToken: () => 'test-token',
}));

describe('resetDemoBalance', () => {
    const originalFetch = global.fetch;
    const fetchMock = jest.fn();

    beforeEach(() => {
        fetchMock.mockReset();
        global.fetch = fetchMock;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('accepts a successful empty response and sends no custom amount', async () => {
        const json = jest.fn().mockRejectedValue(new SyntaxError('Empty response'));
        fetchMock.mockResolvedValue({ ok: true, status: 200, json });

        await expect(resetDemoBalance('DEM123')).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.deriv.com/trading/v1/options/accounts/DEM123/reset-demo-balance',
            {
                method: 'POST',
                headers: { 'Deriv-App-ID': '123', Authorization: 'Bearer test-token' },
            }
        );
        expect(json).not.toHaveBeenCalled();
    });

    it('reports a rejected reset', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 403 });

        await expect(resetDemoBalance('DEM123')).rejects.toThrow('403');
    });
});
