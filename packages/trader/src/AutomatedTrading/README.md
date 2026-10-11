# Fancy Automated Trading

This module runs automated Over/Under digit contracts through Fancy's existing Deriv WebSocket session.

It deliberately does **not** create another WebSocket, OAuth session, market list, or trading store.

## Start

```ts
import { automatedTradingEngine } from './AutomatedTrading';

await automatedTradingEngine.start({
    symbol: '1HZ100V',
    amount: 1,
    currency: 'USD',
    basis: 'stake',
    duration: 1,
    durationUnit: 't',
    lookback: 20,
    minConfidence: 0.6,
    direction: 'AUTO',
    maxTrades: 10,
    maxStake: 1,
    stopOnLoss: 5,
    stopOnProfit: 5,
    cooldownMs: 1000,
});
```

The engine:

1. verifies the symbol using the live `active_symbols` response;
2. reads live tick history from the existing Fancy socket;
3. subscribes to live ticks;
4. generates a real `DIGITOVER` or `DIGITUNDER` signal;
5. requests a real Deriv proposal;
6. buys the proposal through Fancy's existing purchase path;
7. obtains the real `contract_id`;
8. monitors the real `proposal_open_contract` stream;
9. records the actual profit/loss; and
10. enforces optional trade, stake, profit, loss, and cooldown limits.

The strategy is intentionally isolated from execution so additional strategies can be added without changing the Deriv connection layer.
