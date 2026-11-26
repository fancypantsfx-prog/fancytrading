# Strategy Finder cache

Strategy Finder reads a shared snapshot of up to 400 recent ticks per open instrument. The scheduled Worker refreshes the snapshot every minute. Pages serves historical rankings from KV, and selecting a trade requests a live Deriv quote for the exact stake and contract.

1. Confirm the production Pages project binds the KV namespace from `wrangler.toml` as `STRATEGY_FINDER_CACHE`. Use a separate namespace and Worker for staging if needed.
2. Run the **Deploy Strategy Finder Worker** workflow from the release source. It uses `CLOUDFLARE_ACCOUNT_ID` and a Workers deploy token in `CLOUDFLARE_WORKERS_API_TOKEN`. The existing `CLOUDFLARE_API_TOKEN` also works if it can deploy Workers. For a CLI deployment, run `npx wrangler deploy` from this directory.
3. Check the Worker logs for `Strategy Finder snapshot written` with a positive `refreshed` count before releasing the Pages changes through the production release workflow.
4. Check `/api/premium/tick-insights/scan?contract=rise_fall&ticks=5` from a session with access on the updated site. Check that Finder shows only rows with successful Deriv quotes for the selected account and trade settings.

The Worker rotates through open instruments and retains their latest available tick samples. Pages uses Deriv's duration limits when a current contract list is available. The finder reads the prepared historical rankings from Pages. Finder verifies candidates in small batches using live Deriv quotes. Trade review requests a new quote for the exact account, stake, and barrier. Purchase confirmation uses a fresh proposal.

## FancyTrading gateway

Deploy the Worker before binding it to Pages. In each Pages environment, add a service binding named `FANCY_TRADING_BACKEND` pointing to the corresponding Worker. The existing Finder KV binding still provides the prepared rankings. The gateway shares public market history, symbol lists, precision and ranking quotes across visitors. Every purchase gets a fresh quote over the selected account's authenticated Deriv connection.

Set `DERIV_APP_ID` on the Worker to the Deriv application ID used by that environment. Set `FANCY_TRADING_ORDERS=enabled` on the corresponding Pages environment to route FancyTrading digital purchases and ranked settlement checks through the gateway. Validate the account path on a demo account before setting it in production. The browser controls when a ranked run starts and stops, and the Worker submits orders in response to authorized requests from the panel.

Run the gateway and Finder tests with:

```sh
node --test packages/core/premium/tick-insights.test.mjs packages/core/strategy-finder-worker/gateway.test.mjs
```
