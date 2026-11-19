# Strategy Finder cache

Strategy Finder reads a shared snapshot of up to 400 recent ticks per open instrument. The scheduled Worker refreshes the snapshot every minute. Pages serves historical rankings from KV, and selecting a trade requests a live Deriv quote for the exact stake and contract.

1. Confirm the production Pages project binds the KV namespace from `wrangler.toml` as `STRATEGY_FINDER_CACHE`. Use a separate namespace and Worker for staging if needed.
2. Run the **Deploy Strategy Finder Worker** workflow from the release source. It uses `CLOUDFLARE_ACCOUNT_ID` and a Workers deploy token in `CLOUDFLARE_WORKERS_API_TOKEN`. The existing `CLOUDFLARE_API_TOKEN` also works if it can deploy Workers. For a CLI deployment, run `npx wrangler deploy` from this directory.
3. Check the Worker logs for `Strategy Finder snapshot written` with a positive `refreshed` count before releasing the Pages changes through the production release workflow.
4. Check `/api/premium/tick-insights/scan?contract=rise_fall&ticks=5` from a session with access on the updated site. Check that reopening Finder performs no Deriv WebSocket requests until a row is selected.

The Worker rotates through open instruments and retains their latest available tick samples. Pages uses Deriv's duration limits when a current contract list is available. The finder reads the prepared historical rankings from Pages and shows the sample time. Trade review requests the exact account, stake, and barrier quote from Deriv. Purchase confirmation uses a fresh proposal.
