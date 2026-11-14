# Strategy Finder cache

Strategy Finder reads a shared snapshot of up to 400 recent ticks per open instrument. The scheduled Worker refreshes the snapshot every five minutes. Pages serves historical rankings from KV, and selecting a trade requests a live Deriv quote for the exact stake and contract.

1. Create a Workers KV namespace for Strategy Finder. Set its ID in the Worker's `wrangler.toml`.
2. Deploy the Worker from this directory using `npx wrangler deploy`. The configuration installs the five-minute schedule.
3. Bind the same namespace to the Fancy Trading Pages production project with the variable name `STRATEGY_FINDER_CACHE`. Use a separate namespace for staging if staging needs its own data.
4. Verify the Worker completed an initial run and wrote `strategy-finder:history:v1` before releasing the updated frontend. Check the route `/api/premium/tick-insights/scan?contract=rise_fall&ticks=5` from a session with access.

The scan returns a temporary unavailable message until the first snapshot is stored. Subsequent writes keep the snapshot without a KV expiration. The Worker preserves previously collected instruments during partial refreshes and honors Deriv rate-limit responses. The interface labels historical samples older than 30 minutes. A successful Worker run is required to replace a previously expiring snapshot. Background scans use the public market-data connection and store no account credentials.
