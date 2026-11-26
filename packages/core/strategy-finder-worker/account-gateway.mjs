import { openMarketData } from './market-connection.mjs';
import { normalizeMarketRequest } from './market-gateway.mjs';

const apiBase = 'https://api.derivws.com/trading/v1/options/accounts';
const result = (code, message) => ({ error: { code, message } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const connectAccount = async (account, authorization, appId) => {
    const response = await fetch(`${apiBase}/${encodeURIComponent(account)}/otp`, {
        method: 'POST',
        headers: { Authorization: authorization, 'Deriv-App-ID': appId },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Cannot open the authenticated Deriv connection.');
    const { data } = await response.json();
    const url = new URL(data?.url);
    if (
        url.protocol !== 'wss:' ||
        url.hostname !== 'api.derivws.com' ||
        url.port ||
        url.username ||
        url.password ||
        !url.pathname.startsWith('/trading/v1/options/ws/')
    )
        throw new Error('Invalid Deriv connection URL.');
    url.protocol = 'https:';
    return openMarketData(url.toString());
};

export const accountSessionName = async (account, authorization) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(authorization));
    return `${account}:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

export class FancyTradingAccount {
    constructor(state, env, connect = connectAccount) {
        this.storage = state.storage;
        this.appId = env.DERIV_APP_ID;
        this.connect = connect;
        this.queue = Promise.resolve();
        this.pending = 0;
        this.nextRequestAt = 0;
        this.cooldownUntil = 0;
    }

    async fetch(request) {
        const authorization = request.headers.get('Authorization');
        const input = await request.json().catch(() => null);
        if (
            !this.appId ||
            !/^Bearer \S{1,4096}$/i.test(authorization ?? '') ||
            typeof input?.account !== 'string' ||
            !/^[a-z0-9_:-]{1,64}$/i.test(input.account)
        ) {
            return Response.json(result('AccessDenied', 'An authorized Deriv account is required.'), { status: 403 });
        }
        if (this.pending >= 12)
            return Response.json(result('RateLimit', 'Too many account requests are queued.'), { status: 429 });

        this.pending++;
        const operation = this.queue.then(() => this.run(input, authorization));
        this.queue = operation.catch(() => undefined);
        try {
            return Response.json(await operation);
        } catch {
            this.close();
            return Response.json(
                result('AccountGatewayUnavailable', 'The authenticated Deriv connection is temporarily unavailable.'),
                { status: 502 }
            );
        } finally {
            this.pending--;
            if (!this.pending && this.connection) this.idleTimer = setTimeout(() => this.close(), 5000);
        }
    }

    async send(payload) {
        const remaining = this.nextRequestAt - Date.now();
        if (remaining > 0) await sleep(remaining);
        if (Date.now() < this.cooldownUntil) return result('RateLimit', 'Deriv is temporarily limiting requests.');
        this.nextRequestAt = Date.now() + 400;
        const response = await this.connection.send(payload);
        if (response.error?.code === 'RateLimit') this.cooldownUntil = Date.now() + 60000;
        return response;
    }

    async run(input, authorization) {
        clearTimeout(this.idleTimer);
        if (Date.now() < this.cooldownUntil) return result('RateLimit', 'Deriv is temporarily limiting requests.');
        if (input.operation === 'settlement' && Number.isSafeInteger(input.contractId) && input.contractId > 0) {
            this.connection ??= await this.connect(input.account, authorization, this.appId);
            return this.send({ proposal_open_contract: 1, contract_id: input.contractId });
        }

        const [template] = normalizeMarketRequest(input.template) ?? [];
        const { requestId, expiresAt, payout } = input;
        if (
            input.operation !== 'buy' ||
            !template?.proposal ||
            template.contract_type === 'ACCU' ||
            typeof requestId !== 'string' ||
            !/^[a-f0-9]{32}$/i.test(requestId) ||
            !Number.isFinite(expiresAt) ||
            expiresAt > Date.now() + 20000 ||
            !(Number.isFinite(payout) && payout > 0)
        ) {
            return result('InvalidTrade', 'Invalid contract request.');
        }
        const key = `purchase:${requestId}`;
        const previous = await this.storage.get(key);
        if (previous) return previous;
        if (Date.now() >= expiresAt) return result('QuoteExpired', 'The purchase request expired.');

        this.connection ??= await this.connect(input.account, authorization, this.appId);
        const quote = await this.send({ ...template, subscribe: 1 });
        try {
            if (quote.error) return { error: quote.error };
            const proposal = quote.proposal;
            if (!proposal?.id || Number(proposal.ask_price) !== template.amount || Number(proposal.payout) !== payout) {
                return {
                    ...result('QuoteChanged', 'The Deriv quote changed.'),
                    payout: Number(proposal?.payout) || payout,
                };
            }
            const wait = this.nextRequestAt - Date.now();
            if (wait > 0) await sleep(wait);
            if (Date.now() >= expiresAt) return result('QuoteExpired', 'The purchase request expired.');

            const unknown = result('PurchaseUnknown', 'Purchase status is unknown. Check Positions or Reports.');
            await this.storage.put(key, unknown);
            let order;
            try {
                order = await this.send({ buy: proposal.id, price: template.amount });
            } catch {
                this.close();
                return unknown;
            }
            const outcome = order.error
                ? { error: order.error }
                : order.buy?.contract_id
                  ? { buy: { contract_id: order.buy.contract_id, longcode: order.buy.longcode } }
                  : unknown;
            await this.storage.put(key, outcome);
            return outcome;
        } finally {
            if (quote.subscription?.id && this.connection) {
                if (Date.now() < this.cooldownUntil) this.close();
                else await this.send({ forget: quote.subscription.id }).catch(() => this.close());
            }
        }
    }

    close() {
        clearTimeout(this.idleTimer);
        this.connection?.close();
        this.connection = undefined;
    }
}
