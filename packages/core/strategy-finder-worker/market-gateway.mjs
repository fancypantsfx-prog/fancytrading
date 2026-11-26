import { openMarketData } from './market-connection.mjs';

const symbolPattern = /^[a-z0-9_]{1,40}$/i;
const contractTypes = new Set([
    'CALL',
    'PUT',
    'DIGITEVEN',
    'DIGITODD',
    'DIGITOVER',
    'DIGITUNDER',
    'DIGITMATCH',
    'DIGITDIFF',
    'ACCU',
]);
const spacing = 400;
const maxPending = 24;
const maxCached = 512;
const errorResponse = (code, message, status) => Response.json({ error: { code, message } }, { status });
const rateLimited = () =>
    errorResponse('RateLimit', 'Shared market data is temporarily busy. Please try again shortly.', 429);

export const normalizeMarketRequest = input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.subscribe) return;
    if (input.ticks_history) {
        const { ticks_history, count } = input;
        if (
            typeof ticks_history === 'string' &&
            symbolPattern.test(ticks_history) &&
            input.end === 'latest' &&
            input.style === 'ticks' &&
            [20, 100, 400].includes(count)
        ) {
            return [{ ticks_history, count: 400, end: 'latest', style: 'ticks' }, 2000, count];
        }
        return;
    }
    if (typeof input.ticks === 'string' && symbolPattern.test(input.ticks)) return [{ ticks: input.ticks }, 2000];
    if (input.active_symbols === 'brief') return [{ active_symbols: 'brief' }, 30000];
    if (input.proposal !== 1) return;

    const { amount, basis, currency, underlying_symbol, contract_type, duration, duration_unit, barrier, growth_rate } =
        input;
    if (
        basis !== 'stake' ||
        !(Number.isFinite(amount) && amount > 0 && amount <= 1000000) ||
        typeof currency !== 'string' ||
        !/^[A-Z0-9]{2,12}$/.test(currency) ||
        typeof underlying_symbol !== 'string' ||
        !symbolPattern.test(underlying_symbol) ||
        !contractTypes.has(contract_type)
    )
        return;

    const proposal = { proposal: 1, amount, basis, currency, underlying_symbol, contract_type };
    if (contract_type === 'ACCU') {
        if (![0.01, 0.02, 0.03, 0.04, 0.05].includes(growth_rate)) return;
        return [{ ...proposal, growth_rate }, 2000];
    }
    if (duration_unit !== 't' || !Number.isInteger(duration) || duration < 1 || duration > 20) return;
    if (/^DIGIT(?:OVER|UNDER|MATCH|DIFF)$/.test(contract_type)) {
        if (typeof barrier !== 'string' || !/^\d$/.test(barrier)) return;
        return [{ ...proposal, duration, duration_unit, barrier }, 2000];
    }
    return [{ ...proposal, duration, duration_unit }, 2000];
};

export class FancyMarketData {
    constructor(_state, _env, connect = openMarketData) {
        this.connect = connect;
        this.queue = Promise.resolve();
        this.pending = new Map();
        this.cache = new Map();
        this.nextRequestAt = 0;
        this.cooldownUntil = 0;
    }

    async fetch(request) {
        if (request.method !== 'POST') return errorResponse('MethodNotAllowed', 'Use POST.', 405);
        const input = await request.json().catch(() => null);
        const normalized = normalizeMarketRequest(input);
        if (!normalized) return errorResponse('InvalidMarketRequest', 'Unsupported market data request.', 400);

        const [payload, ttl, count] = normalized;
        const key = JSON.stringify(payload);
        let result = this.cache.get(key);
        if (result?.expiresAt <= Date.now()) {
            this.cache.delete(key);
            result = undefined;
        }
        let data = result?.data;
        if (!data) {
            let pending = this.pending.get(key);
            if (!pending) {
                if (this.pending.size >= maxPending || Date.now() < this.cooldownUntil) return rateLimited();
                pending = this.queue.then(() => this.request(payload));
                this.queue = pending.catch(() => undefined);
                this.pending.set(key, pending);
                pending
                    .then(
                        response => {
                            if (!response.error) {
                                this.cache.set(key, { data: response, expiresAt: Date.now() + ttl });
                                if (this.cache.size > maxCached) this.cache.delete(this.cache.keys().next().value);
                            }
                        },
                        () => undefined
                    )
                    .finally(() => this.pending.delete(key));
            }
            try {
                data = await pending;
            } catch {
                return errorResponse(
                    'MarketDataUnavailable',
                    'The Deriv market data connection is temporarily unavailable.',
                    502
                );
            }
        }

        if (data.error?.code === 'RateLimit') return Response.json(data, { status: 429 });
        if (count && Array.isArray(data.history?.prices) && Array.isArray(data.history?.times)) {
            data = {
                ...data,
                history: { prices: data.history.prices.slice(-count), times: data.history.times.slice(-count) },
            };
        }
        return Response.json(data);
    }

    async request(payload) {
        const wait = this.nextRequestAt - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        if (Date.now() < this.cooldownUntil)
            return { error: { code: 'RateLimit', message: 'Deriv is limiting market requests.' } };
        clearTimeout(this.idleTimer);
        try {
            this.connection ??= await this.connect();
            this.nextRequestAt = Date.now() + spacing;
            const response = await this.connection.send(payload);
            if (response.error?.code === 'RateLimit') this.cooldownUntil = Date.now() + 60000;
            return response;
        } catch (error) {
            this.close();
            throw error;
        } finally {
            if (this.connection) this.idleTimer = setTimeout(() => this.close(), 5000);
        }
    }

    close() {
        clearTimeout(this.idleTimer);
        this.connection?.close();
        this.connection = undefined;
    }
}
