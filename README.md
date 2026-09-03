# Pi New API Balance

A general-purpose Pi package for displaying balances and usage from one or more [New API](https://github.com/QuantumNous/new-api) providers in Pi and Pi Web.

## Features

- Selects the New API instance from the active Pi model provider ID.
- Supports multiple New API instances from one configuration file.
- Refreshes every 60 seconds, after each turn, and after model changes.
- Uses `ctx.ui.setStatus()`, which is rendered by Pi Web.
- Reuses each provider's configured API key for token-level usage fallback.
- Uses New API management credentials for account-level balance when configured.
- Provides `/new-api-balance [provider-id]` for manual refresh and details.
- Shows a floating deduction effect (`▼-$0.32` badge in the status line plus a toast) whenever a refresh detects the balance dropped.

## Configuration

Configuration is stored at `~/.pi/agent/new-api-balance.json`:

```json
{
  "refreshMs": 60000,
  "deltaFloatMs": 10000,
  "providers": {
    "my-provider": {
      "name": "My New API",
      "baseUrl": "https://new-api.example.com",
      "userId": "$MY_NEW_API_USER_ID",
      "accessToken": "$MY_NEW_API_ACCESS_TOKEN"
    }
  }
}
```

`deltaFloatMs` controls how long the deduction badge stays in the status line (default `10000`, minimum `1000`). The deduction is shown only in the bottom status bar; no floating toast notification is emitted. The first refresh after session start only establishes the baseline and never shows a deduction.

The key under `providers` must match the provider ID in Pi's `models.json`. `baseUrl` may be omitted when Pi's provider auth resolves it. `userId` and `accessToken` may be literal values or `$ENV_VAR` references.

Without management credentials, the package queries `/dashboard/billing/subscription` and `/dashboard/billing/usage` with the provider's existing API key. With management credentials, it queries `/api/user/self` for the actual account balance.

## Management

Use Pi Web's plugin settings or run `pi config` to enable or disable the package extension.

```bash
pi list
pi remove /Users/qiuwen/.pi/agent/local/pi-new-api-balance
```
