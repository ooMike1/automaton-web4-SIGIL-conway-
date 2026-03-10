/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 */

import type {
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  AutomatonIdentity,
  SocialClientInterface,
} from "../types.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";

/**
 * Check USDC balance. RPC sync is considered OK if the RPC responds (regardless of balance).
 */
async function getUsdcBalanceWithWait(
  address: string,
  db: AutomatonDatabase,
): Promise<{ balance: number; synced: boolean }> {
  try {
    const balance = await getUsdcBalance(address as `0x${string}`);
    // RPC responded successfully — mark as synced
    if (db.getKV("rpc_synced") !== "true") {
      db.setKV("rpc_synced", "true");
      db.setKV("rpc_sync_attempts", "0");
      console.log(`[RPC SYNC] ✅ RPC reachable. Balance: $${balance.toFixed(4)}`);
    }
    return { balance, synced: true };
  } catch (err: any) {
    console.log(`[RPC SYNC] ⚠️ RPC unreachable: ${err.message}`);
    return { balance: 0, synced: false };
  }
}

export interface HeartbeatTaskContext {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  social?: SocialClientInterface;
}

export type HeartbeatTaskFn = (
  ctx: HeartbeatTaskContext,
) => Promise<{ shouldWake: boolean; message?: string }>;

/**
 * Registry of built-in heartbeat tasks.
 */
export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx) => {
    const credits = await ctx.conway.getCreditsBalance();
    const state = ctx.db.getAgentState();
    const startTime =
      ctx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const tier = getSurvivalTier(credits);

    const payload = {
      name: ctx.config.name,
      address: ctx.identity.address,
      state,
      creditsCents: credits,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: ctx.config.version,
      sandboxId: ctx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    // If critical or dead, record a distress signal
    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: ctx.config.name,
        address: ctx.identity.address,
        creditsCents: credits,
        fundingHint:
          "Use credit transfer API from a creator runtime to top this wallet up.",
        timestamp: new Date().toISOString(),
      };
      ctx.db.setKV("last_distress", JSON.stringify(distressPayload));

      return {
        shouldWake: true,
        message: `Distress: ${tier}. Credits: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_credits: async (ctx) => {
    const credits = await ctx.conway.getCreditsBalance();
    const tier = getSurvivalTier(credits);

    ctx.db.setKV("last_credit_check", JSON.stringify({
      credits,
      tier,
      timestamp: new Date().toISOString(),
    }));

    // Wake the agent if credits dropped to a new tier
    const prevTier = ctx.db.getKV("prev_credit_tier");
    ctx.db.setKV("prev_credit_tier", tier);

    if (prevTier && prevTier !== tier && (tier === "critical" || tier === "dead")) {
      return {
        shouldWake: true,
        message: `Credits dropped to ${tier} tier: $${(credits / 100).toFixed(2)}`,
      };
    }

    return { shouldWake: false };
  },

  check_usdc_balance: async (ctx) => {
    const { balance, synced } = await getUsdcBalanceWithWait(
      ctx.identity.address,
      ctx.db
    );

    ctx.db.setKV(
      "last_usdc_check",
      JSON.stringify({
        balance,
        synced,
        timestamp: new Date().toISOString(),
      })
    );

    // RPC just synced - wake up to celebrate and enable heavy operations
    if (synced && !ctx.db.getKV("rpc_was_synced")) {
      ctx.db.setKV("rpc_was_synced", "true");
      console.log(`[RPC SYNC] Balance synced: $${balance.toFixed(4)}`);
      console.log(`[RPC SYNC] Wake Ollama manually if needed (systemctl start ollama)`);

      return {
        shouldWake: true,
        message: `RPC SYNCED! Real USDC: $${balance.toFixed(4)}. Ollama ready for inference.`,
      };
    }

    // If we have USDC but low credits, wake up to potentially convert
    // Cooldown: only wake once per 10 minutes to avoid rapid-loop burning credits
    const credits = await ctx.conway.getCreditsBalance();
    if (balance > 0.5 && credits < 500) {
      const lastWake = ctx.db.getKV("last_buy_credits_wake");
      const cooldownMs = 10 * 60 * 1000;
      if (lastWake && Date.now() - new Date(lastWake).getTime() < cooldownMs) {
        return { shouldWake: false };
      }
      ctx.db.setKV("last_buy_credits_wake", new Date().toISOString());
      return {
        shouldWake: true,
        message: `Have ${balance.toFixed(4)} USDC but only $${(credits / 100).toFixed(2)} credits. Consider buying credits.`,
      };
    }

    // If not synced, stay in low-activity mode (don't wake for heavy tasks)
    if (!synced) {
      return { shouldWake: false };
    }

    return { shouldWake: false };
  },

  check_social_inbox: async (ctx) => {
    if (!ctx.social) return { shouldWake: false };

    const cursor = ctx.db.getKV("social_inbox_cursor") || undefined;
    const { messages, nextCursor } = await ctx.social.poll(cursor);

    if (messages.length === 0) return { shouldWake: false };

    // Persist to inbox_messages table for deduplication
    let newCount = 0;
    for (const msg of messages) {
      const existing = ctx.db.getKV(`inbox_seen_${msg.id}`);
      if (!existing) {
        ctx.db.insertInboxMessage(msg);
        ctx.db.setKV(`inbox_seen_${msg.id}`, "1");
        newCount++;
      }
    }

    if (nextCursor) ctx.db.setKV("social_inbox_cursor", nextCursor);

    if (newCount === 0) return { shouldWake: false };

    return {
      shouldWake: true,
      message: `${newCount} new message(s) from: ${messages.map((m) => m.from.slice(0, 10)).join(", ")}`,
    };
  },

  check_for_updates: async (ctx) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      ctx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        return {
          shouldWake: true,
          message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
        };
      }
      return { shouldWake: false };
    } catch (err: any) {
      // Not a git repo or no remote — silently skip
      ctx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  health_check: async (ctx) => {
    const HEALTH_FAIL_COOLDOWN_MS = 30 * 60 * 1000; // only wake once per 30 min for persistent failures

    const shouldWakeForFailure = () => {
      const lastWake = ctx.db.getKV("last_health_fail_wake");
      if (lastWake && Date.now() - new Date(lastWake).getTime() < HEALTH_FAIL_COOLDOWN_MS) {
        return false;
      }
      ctx.db.setKV("last_health_fail_wake", new Date().toISOString());
      return true;
    };

    // Check that the sandbox is healthy
    try {
      const result = await ctx.conway.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        if (!shouldWakeForFailure()) return { shouldWake: false };
        return {
          shouldWake: true,
          message: "Health check failed: sandbox exec returned non-zero",
        };
      }
    } catch (err: any) {
      if (!shouldWakeForFailure()) return { shouldWake: false };
      return {
        shouldWake: true,
        message: `Health check failed: ${err.message}`,
      };
    }

    ctx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

  arbitrage_scan: async (ctx) => {
    // Skip heavy arbitrage operations during RPC sync wait (low-activity mode)
    const rpcSynced = ctx.db.getKV("rpc_synced") === "true";
    if (!rpcSynced && ctx.db.getKV("rpc_sync_attempts")) {
      console.log(`[ARBITRAGE] ⏸️ Skipping scan - waiting for RPC sync. Low-activity mode.`);
      return { shouldWake: false };
    }

    try {
      // Import and run UNIVERSAL arbitrage engine
      // Auto-discovers DEXs, validates them, and executes cross-DEX trades
      const { executeUniversalArbitrage } = await import("../skills/universal-arbitrage.js");

      console.log(`[HEARTBEAT] Running UNIVERSAL arbitrage scan...`);
      const result = await executeUniversalArbitrage();

      // Log to DB
      ctx.db.setKV("last_universal_arbitrage", JSON.stringify({
        result,
        scanTime: new Date().toISOString(),
        engine: 'universal-multi-dex',
      }));

      // Wake up if found profitable opportunities
      if (result.includes('executed') || result.includes('opportunity')) {
        return {
          shouldWake: true,
          message: result,
        };
      }

      return { shouldWake: false };
    } catch (err: any) {
      ctx.db.setKV("last_universal_arbitrage_error", JSON.stringify({
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
      console.error(`[ARBITRAGE] Error:`, err.message);
      return { shouldWake: false };
    }
  },

  check_income_action: async (ctx) => {
    const DAILY_MS = 24 * 60 * 60 * 1000;
    const COOLDOWN_MS = 6 * 60 * 60 * 1000; // max wake once per 6h for this task

    const lastWake = ctx.db.getKV("last_income_action_wake");
    if (lastWake && Date.now() - new Date(lastWake).getTime() < COOLDOWN_MS) {
      return { shouldWake: false };
    }

    const lastIncomeAction = ctx.db.getKV("last_income_action");

    const noActionToday = !lastIncomeAction ||
      Date.now() - new Date(lastIncomeAction).getTime() > DAILY_MS;

    if (noActionToday) {
      ctx.db.setKV("last_income_action_wake", new Date().toISOString());
      return {
        shouldWake: true,
        message: `Capital growth reminder: No income action today. Priority: arbitrage > services > trading > DeFi yield (last resort). Reinvest 100% of gains.`,
      };
    }

    return { shouldWake: false };
  },

};
