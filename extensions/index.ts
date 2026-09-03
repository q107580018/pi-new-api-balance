import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "new-api-balance";
const DEFAULT_REFRESH_MS = 60_000;
const CONFIG_FILE = "new-api-balance.json";

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  userId?: number | string;
  accessToken?: string;
  currencySymbol?: string;
  lowBalanceThreshold?: number;
}

interface BalanceConfig {
  refreshMs?: number;
  /** How long the deduction delta badge stays in the status line (ms). */
  deltaFloatMs?: number;
  providers?: Record<string, ProviderConfig>;
}

interface NewApiStatus {
  quota_per_unit?: number;
  quota_display_type?: string;
  currency_symbol?: string;
  usd_exchange_rate?: number;
  system_name?: string;
}

interface NewApiUser {
  quota?: number;
  used_quota?: number;
  request_count?: number;
  username?: string;
}

interface BalanceSnapshot {
  providerId: string;
  remaining?: number;
  used: number;
  requests?: number;
  symbol: string;
  displayName: string;
  username?: string;
  unlimited?: boolean;
  source: "account" | "token";
  lowBalanceThreshold: number;
  refreshedAt: Date;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

function resolveValue(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return String(value);
  if (!value) return undefined;

  const match = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  if (!match) return value;
  return process.env[match[1] ?? match[2] ?? ""];
}

async function loadConfig(): Promise<BalanceConfig> {
  try {
    const config = JSON.parse(await readFile(configPath(), "utf8")) as BalanceConfig;
    if (!config.providers || typeof config.providers !== "object") {
      throw new Error('expected a "providers" object');
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { providers: {} };
    throw new Error(`Invalid config ${configPath()}: ${(error as Error).message}`);
  }
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return value.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => undefined)) as
    | { message?: string; error?: { message?: string } }
    | undefined;

  if (!response.ok) {
    const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function unwrapData<T>(body: unknown): T {
  if (!body || typeof body !== "object") throw new Error("New API returned an invalid response");
  const record = body as {
    success?: boolean;
    message?: string;
    data?: T;
    error?: { message?: string };
  };
  if (record.error?.message) throw new Error(record.error.message);
  if (record.success === false) throw new Error(record.message || "New API request failed");
  return (record.data ?? body) as T;
}

function currencyInfo(status: NewApiStatus, provider: ProviderConfig): {
  symbol: string;
  accountMultiplier: number;
} {
  const isCny = status.quota_display_type === "CNY";
  return {
    symbol: provider.currencySymbol || status.currency_symbol || (isCny ? "CNY " : "$"),
    accountMultiplier: isCny ? Number(status.usd_exchange_rate) || 1 : 1,
  };
}

async function fetchSnapshot(
  ctx: ExtensionContext,
  providerId: string,
  provider: ProviderConfig,
): Promise<BalanceSnapshot> {
  const auth = await ctx.modelRegistry.getProviderAuth(providerId);
  const modelBaseUrl = ctx.model?.provider === providerId
    ? (ctx.model as typeof ctx.model & { baseUrl?: string }).baseUrl
    : undefined;
  const baseUrl = normalizeBaseUrl(provider.baseUrl || auth?.auth.baseUrl || modelBaseUrl);
  if (!baseUrl) throw new Error(`configure baseUrl for provider "${providerId}"`);

  const accessToken = resolveValue(provider.accessToken);
  const userId = resolveValue(provider.userId);
  const statusBody = await getJson(`${baseUrl}/api/status`, {});
  const status = unwrapData<NewApiStatus>(statusBody);
  const { symbol, accountMultiplier } = currencyInfo(status, provider);
  const displayName = provider.name || status.system_name?.trim() || providerId;
  const lowBalanceThreshold = Number(provider.lowBalanceThreshold) || 5;

  if (accessToken && userId) {
    const userBody = await getJson(`${baseUrl}/api/user/self`, {
      Authorization: accessToken,
      "New-Api-User": userId,
    });
    const user = unwrapData<NewApiUser>(userBody);
    const quotaPerUnit = Number(status.quota_per_unit) || 500_000;

    return {
      providerId,
      remaining: ((Number(user.quota) || 0) / quotaPerUnit) * accountMultiplier,
      used: ((Number(user.used_quota) || 0) / quotaPerUnit) * accountMultiplier,
      requests: Number(user.request_count) || 0,
      symbol,
      displayName,
      username: user.username,
      source: "account",
      lowBalanceThreshold,
      refreshedAt: new Date(),
    };
  }

  const apiKey = auth?.auth.apiKey;
  if (!apiKey) {
    throw new Error(`provider "${providerId}" has no API key or management credentials`);
  }

  const [subscriptionBody, usageBody] = await Promise.all([
    getJson(`${baseUrl}/dashboard/billing/subscription`, {
      Authorization: `Bearer ${apiKey}`,
    }),
    getJson(`${baseUrl}/dashboard/billing/usage`, {
      Authorization: `Bearer ${apiKey}`,
    }),
  ]);
  const subscription = unwrapData<{ hard_limit_usd?: number }>(subscriptionBody);
  const usage = unwrapData<{ total_usage?: number }>(usageBody);
  const limit = Number(subscription.hard_limit_usd) || 0;
  const used = (Number(usage.total_usage) || 0) / 100;
  const unlimited = limit >= 100_000_000;

  return {
    providerId,
    remaining: unlimited ? undefined : Math.max(0, limit - used),
    used,
    symbol,
    displayName,
    unlimited,
    source: "token",
    lowBalanceThreshold,
    refreshedAt: new Date(),
  };
}

function money(symbol: string, amount: number): string {
  return `${symbol}${amount.toFixed(2)}`;
}

function renderStatus(ctx: ExtensionContext, snapshot: BalanceSnapshot, delta?: number): string {
  const remaining = snapshot.unlimited
    ? "Token 无上限"
    : `余额 ${money(snapshot.symbol, snapshot.remaining ?? 0)}`;
  const requests = snapshot.requests === undefined ? "" : ` · ${snapshot.requests} 次`;
  const text = `${snapshot.displayName} ${remaining} · 已用 ${money(snapshot.symbol, snapshot.used)}${requests}`;
  const isLow = snapshot.remaining !== undefined && snapshot.remaining <= snapshot.lowBalanceThreshold;
  const colored = ctx.ui.theme.fg(isLow ? "warning" : "success", text);
  if (delta === undefined) return colored;
  // Use explicit ANSI red/reset codes so Pi Web's AnsiText renderer displays the deduction in red.
  const badge = ` \x1b[31m▼-${money(snapshot.symbol, delta)}\x1b[0m`;
  return colored + badge;
}

function deductionDelta(
  previous: BalanceSnapshot | undefined,
  current: BalanceSnapshot,
): number | undefined {
  if (!previous) return undefined;
  if (previous.remaining === undefined || current.remaining === undefined) return undefined;
  const delta = previous.remaining - current.remaining;
  return delta > 1e-9 ? delta : undefined;
}

function notification(snapshot: BalanceSnapshot): string {
  return `${snapshot.displayName}${snapshot.username ? ` (${snapshot.username})` : ""}\n` +
    `Provider: ${snapshot.providerId}\n` +
    `${snapshot.unlimited ? "Token 额度: 无上限" : `余额: ${money(snapshot.symbol, snapshot.remaining ?? 0)}`}\n` +
    `累计使用: ${money(snapshot.symbol, snapshot.used)}\n` +
    (snapshot.requests === undefined ? "" : `请求数: ${snapshot.requests}\n`) +
    `数据来源: ${snapshot.source === "account" ? "New API 账户" : "当前 API Token"}\n` +
    `刷新时间: ${snapshot.refreshedAt.toLocaleString()}`;
}

export default function newApiBalance(pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let currentContext: ExtensionContext | undefined;
  const inFlight = new Map<string, Promise<BalanceSnapshot>>();
  const lastSnapshots = new Map<string, BalanceSnapshot>();
  const floatTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function showDeltaFloat(
    ctx: ExtensionContext,
    snapshot: BalanceSnapshot,
    delta: number,
    config: BalanceConfig,
  ): void {
    ctx.ui.setStatus(STATUS_KEY, renderStatus(ctx, snapshot, delta));

    const existing = floatTimers.get(snapshot.providerId);
    if (existing) clearTimeout(existing);
    const floatMs = Math.max(1_000, Number(config.deltaFloatMs) || 10_000);
    const timeout = setTimeout(() => {
      floatTimers.delete(snapshot.providerId);
      const latest = lastSnapshots.get(snapshot.providerId);
      if (currentContext?.hasUI && latest && currentContext.model?.provider === snapshot.providerId) {
        currentContext.ui.setStatus(STATUS_KEY, renderStatus(currentContext, latest));
      }
    }, floatMs);
    timeout.unref?.();
    floatTimers.set(snapshot.providerId, timeout);
  }

  async function refresh(
    ctx: ExtensionContext,
    requestedProviderId?: string,
    notify = false,
  ): Promise<void> {
    if (!ctx.hasUI) return;

    try {
      const config = await loadConfig();
      const providerId = requestedProviderId || ctx.model?.provider;
      const provider = providerId ? config.providers?.[providerId] : undefined;
      if (!providerId || !provider) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        if (notify) {
          ctx.ui.notify(
            providerId
              ? `Provider "${providerId}" is not configured in ${configPath()}`
              : "No active model provider",
            "warning",
          );
        }
        return;
      }

      let request = inFlight.get(providerId);
      if (!request) {
        request = fetchSnapshot(ctx, providerId, provider).finally(() => {
          inFlight.delete(providerId);
        });
        inFlight.set(providerId, request);
      }
      const snapshot = await request;
      const previous = lastSnapshots.get(providerId);
      lastSnapshots.set(providerId, snapshot);
      if (!requestedProviderId || providerId === ctx.model?.provider) {
        const delta = deductionDelta(previous, snapshot);
        if (delta !== undefined) {
          showDeltaFloat(ctx, snapshot, delta, config);
        } else {
          ctx.ui.setStatus(STATUS_KEY, renderStatus(ctx, snapshot));
        }
      }
      if (notify) ctx.ui.notify(notification(snapshot), "info");
    } catch (error) {
      const message = (error as Error).message;
      ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `New API: ${message}`));
      if (notify) ctx.ui.notify(`New API 余额查询失败: ${message}`, "error");
    }
  }

  async function start(ctx: ExtensionContext): Promise<void> {
    currentContext = ctx;
    if (timer) clearInterval(timer);
    await refresh(ctx);
    const config = await loadConfig().catch(() => ({}) as BalanceConfig);
    const refreshMs = Math.max(15_000, Number(config.refreshMs) || DEFAULT_REFRESH_MS);
    timer = setInterval(() => {
      if (currentContext) void refresh(currentContext);
    }, refreshMs);
    timer.unref?.();
  }

  pi.registerCommand("new-api-balance", {
    description: "Refresh New API balance for the active or specified provider",
    handler: async (args, ctx) => {
      await refresh(ctx, args.trim() || undefined, true);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await start(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    await refresh(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer) clearInterval(timer);
    timer = undefined;
    currentContext = undefined;
    inFlight.clear();
    for (const timeout of floatTimers.values()) clearTimeout(timeout);
    floatTimers.clear();
    lastSnapshots.clear();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
