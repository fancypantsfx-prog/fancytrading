import BinarySocketGeneral from '../socket-general';

jest.mock('@deriv/shared', () => ({
    getPropertyValue: (response, keys) => keys.reduce((value, key) => value?.[key], response),
    mapErrorMessage: error => error.message,
}));
jest.mock('../oauth', () => ({}));
jest.mock('../ws-methods', () => ({}));
jest.mock('_common/base/server_time', () => ({}));
jest.mock('_common/base/socket_base', () => ({}));

it.each(['proposal', 'buy', 'proposal_open_contract'])('keeps a rate-limited %s request from blocking the page', msg_type => {
    const setError = jest.fn();
    const { onMessage } = BinarySocketGeneral.init({ client: {}, common: { setError } });

    onMessage({ msg_type, error: { code: 'RateLimit' } });

    expect(setError).not.toHaveBeenCalled();
});

it('still reports a fatal application ID error', () => {
    const setError = jest.fn();
    const { onMessage } = BinarySocketGeneral.init({ client: {}, common: { setError } });

    onMessage({ msg_type: 'proposal', error: { code: 'InvalidAppID', message: 'Invalid app ID' } });

    expect(setError).toHaveBeenCalledWith(true, { message: 'Invalid app ID' });
});
