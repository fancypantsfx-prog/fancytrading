# Strategy Finder cache

Strategy Finder reads a shared snapshot of up to 400 recent ticks per open instrument. The scheduled Worker refreshes the snapshot every minute. Pages serves historical rankings from KV, and selecting a trade requests a live Deriv quote for the exact stake and contract.

1. Create a Workers KV namespace for Strategy Finder. Set its ID in the Worker's `wrangler.toml`.
2. Deploy the Worker from this directory using `npx wrangler deploy`. The configuration installs the one-minute schedule.
3. Bind the same namespace to the Fancy Trading Pages production project with the variable name `STRATEGY_FINDER_CACHE`. Use a separate namespace for staging if staging needs its own data.
4. Verify the Worker completed an initial run and wrote `strategy-finder:history:v1`. Check the route `/api/premium/tick-insights/scan?contract=rise_fall&ticks=5` from a session with access.

The Worker rotates through open instruments and preserves previous samples while they are fresh. Pages expires each ranking three minutes after its collection time or newest tick, whichever is earlier. The finder checks up to 24 ranked contracts and displays up to 12 successful live quotes for the exact stake, duration and barrier. If no shared ranking can be quoted, the finder samples up to three eligible markets through the current account connection. A separate live quote is required when opening trade review, and purchase confirmation uses a fresh proposal. Background scans use public market data.
