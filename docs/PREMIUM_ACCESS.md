# Premium access

FancyTrading uses the existing Deriv login to verify ownership of an Options account. A paid grant applies to one feature and follows the user across the Options accounts returned by their Deriv session. Grant access using any one of those Options account IDs. Features start locked unless they have an explicit free launch mode. A public preview lets anyone try the feature from its start time until its end time.

## Set up Cloudflare

1. Create a D1 database for premium access and run [the schema](../packages/core/premium/schema.sql) in its console.
2. In the FancyTrading Pages project's settings, bind that database as `PREMIUM_DB` for production. Use a separate D1 database with the same schema for staging or preview deployments.
3. Deploy through the existing Pages release workflow. Check that `GET /api/premium/example-feature` returns `{"access":"locked"}` for a signed-out visitor.

See the [Cloudflare Pages binding instructions](https://developers.cloudflare.com/pages/functions/bindings/#d1-databases).

## Manage access

Run these statements in the D1 console for the relevant environment. Replace the example feature key and account ID with the actual values. After confirming payment, grant or renew access for a specific feature. This example sets the expiry to 30 days from now.

```sql
INSERT INTO premium_grants (feature, account_id, expires_at)
VALUES ('example-feature', 'REPLACE_WITH_OPTIONS_ACCOUNT_ID', unixepoch('now', '+30 days'))
ON CONFLICT (feature, account_id) DO UPDATE SET expires_at = excluded.expires_at;
```

Revoke a grant immediately.

```sql
DELETE FROM premium_grants
WHERE feature = 'example-feature' AND account_id = 'REPLACE_WITH_OPTIONS_ACCOUNT_ID';
```

Open a two-hour public preview immediately. To schedule a preview, use `unixepoch('YYYY-MM-DD HH:MM:SS+03:00')` with the desired local start and end times. Setting a window replaces the previous window for that feature.

```sql
INSERT INTO premium_previews (feature, starts_at, ends_at)
VALUES ('example-feature', unixepoch(), unixepoch('now', '+2 hours'))
ON CONFLICT (feature) DO UPDATE SET starts_at = excluded.starts_at, ends_at = excluded.ends_at;
```

Close or cancel a preview early.

```sql
DELETE FROM premium_previews WHERE feature = 'example-feature';
```

## FancyTrading

Open **FancyTrading** from the trading panel beside the Manual and Automatic modes. It launches free. To require paid access, set the Pages environment variable `TICK_INSIGHTS_ACCESS` to `paid` and redeploy with the `PREMIUM_DB` binding. Use `tick-insights` as the feature key for grants and preview windows. The analysis endpoint checks access on every comparison.

The comparison uses the active market's 400 latest ticks and requests fresh Deriv payout quotes at the entered stake. Rise, Fall, Even and Odd results use the selected tick duration. Accumulator results replay the currently quoted range, compare available growth rates at the selected target, and show an estimated compounded payout. Quotes that Deriv rejects, or accumulator targets beyond quoted limits, are omitted. The two 200-tick halves are scored separately using trials that share no price moves within each half. The figures describe the sample and the quotes at comparison time.

A connected user can enter a stake and run stop loss, choose a row, and confirm a fixed-stake automatic run on the account shown in the review. Some Deriv strategies also require a run take profit. The stop loss must cover at least one stake. For Accumulators, the estimated profit at the chosen tick target becomes the take-profit amount on each contract. A fresh access check and proposal precede execution. Manage or stop a run in **Automatic settings**. Already open contracts can still settle after the run stops.

See [Deriv's tick history API](https://developers.deriv.com/docs/data/ticks-history/), [price proposal API](https://developers.deriv.com/docs/trading/proposal/), and [trading terms](https://deriv.com/terms-and-conditions/trading-terms).

## Add a premium feature

Choose a feature key of up to 64 lowercase letters, digits, or hyphens. In the frontend, import from `@deriv/api` and call `fetchPremiumAccess(feature)` to display the appropriate locked, paid, or preview state. During a public preview the endpoint returns `preview` for everyone. Allowed responses include `expiresAt` in Unix seconds. Refresh the display after expiry and on account changes.

In each server handler that serves protected data or performs a premium action, call `getPremiumAccess(request, env, feature)` with the handler's fixed feature key. Proceed only for `paid` or `preview`. Return a locked response for `locked` and an unavailable response if the check throws. Use `premiumResponse` for JSON responses so personalized results are uncached. Keep premium logic or data that requires protection behind that server check.

Grants are currently managed manually in D1. Checkout and automatic payment verification are separate integrations.
