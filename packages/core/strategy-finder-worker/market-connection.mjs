const DERIV_PUBLIC_WS = 'https://api.derivws.com/trading/v1/options/ws/public';

export const openMarketData = async (url = DERIV_PUBLIC_WS) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let response;
    try {
        response = await fetch(url, {
            headers: { Upgrade: 'websocket' },
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
    const socket = response.webSocket;
    if (!socket) throw new Error('Deriv market connection unavailable');

    let requestId = 0;
    let pending;
    socket.addEventListener('message', ({ data }) => {
        let result;
        try {
            result = JSON.parse(data);
        } catch {
            return;
        }
        if (pending && result.req_id === pending.id) pending.resolve(result);
    });
    socket.addEventListener('close', () => pending?.reject(new Error('Deriv market connection closed')));
    socket.addEventListener('error', () => pending?.reject(new Error('Deriv market connection failed')));
    socket.accept();

    return {
        close: () => socket.close(1000, 'Snapshot complete'),
        async send(payload) {
            const id = ++requestId;
            let timer;
            try {
                return await new Promise((resolve, reject) => {
                    pending = { id, resolve, reject };
                    timer = setTimeout(() => reject(new Error('Deriv market request timed out')), 8000);
                    socket.send(JSON.stringify({ ...payload, req_id: id }));
                });
            } finally {
                clearTimeout(timer);
                pending = undefined;
            }
        },
    };
};
