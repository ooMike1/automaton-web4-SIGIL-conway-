/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
} from "../types.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { getSurvivalTier } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import { ulid } from "ulid";
import { processAgathaIntention } from "./intent.js";

const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MIN_TURN_DELAY_MS = 3_000; // minimum 3s between turns to prevent spin
const MAX_TURNS_WITHOUT_SLEEP = 8; // force sleep after N turns with no idle/sleep action

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, onStateChange, onTurnComplete } =
    options;

  // --- LOG DE DIAGNÓSTICO DE COMUNICACIÓN ---
  try {
    const relayStatus = await fetch("https://social.conway.tech/health");
    if (relayStatus.ok) {
      logColor("[CONN] Status: ONLINE - Conectado al Relay Social de Conway.", "green");
    } else {
      logColor("[CONN] Status: DEGRADED - El Relay responde pero con error.", "yellow");
    }
  } catch (e) {
    logColor("[CONN] Status: OFFLINE - Modo Soberano estricto (Aislado).", "red");
  }

  const tools = createBuiltinTools(identity.sandboxId);
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }

  let consecutiveErrors = 0;
  let running = true;
  let turnsThisSession = 0;
  let lastTurnTime = 0;

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address);

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: $${(financial.creditsCents / 100).toFixed(2)}`);

  // ─── The Loop ──────────────────────────────────────────────

  // Check for unprocessed inbox messages and append to wakeup prompt
  const pendingInboxMessages = db.getUnprocessedInboxMessages(5);
  let wakeupContent = wakeupInput;
  if (pendingInboxMessages.length > 0) {
    const formatted = pendingInboxMessages
      .map((m) => `[Message from ${m.from}]: ${m.content}`)
      .join("\n\n");
    wakeupContent = `${wakeupInput}\n\n---\n📬 Unread messages:\n${formatted}`;
    for (const m of pendingInboxMessages) {
      db.markInboxMessageProcessed(m.id);
    }
    log(config, `[INBOX] ${pendingInboxMessages.length} unread message(s) appended to wakeup.`);
  }

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupContent,
    source: "wakeup",
  };

  while (running) {
    try {
      // Enforce minimum delay between turns
      const now = Date.now();
      const elapsed = now - lastTurnTime;
      if (lastTurnTime > 0 && elapsed < MIN_TURN_DELAY_MS) {
        await new Promise((r) => setTimeout(r, MIN_TURN_DELAY_MS - elapsed));
      }

      // Force sleep if too many turns without the agent choosing to pause
      if (turnsThisSession >= MAX_TURNS_WITHOUT_SLEEP) {
        log(config, `[THROTTLE] ${MAX_TURNS_WITHOUT_SLEEP} turns without sleep. Forcing 2-minute break.`);
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check for unprocessed inbox messages
      if (!pendingInput) {
        const inboxMessages = db.getUnprocessedInboxMessages(5);
        if (inboxMessages.length > 0) {
          const formatted = inboxMessages
            .map((m) => `[Message from ${m.from}]: ${m.content}`)
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
          for (const m of inboxMessages) {
            db.markInboxMessageProcessed(m.id);
          }
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address);

      // Check if waiting for RPC sync (low-activity mode)
      const rpcSynced = db.getKV("rpc_synced") === "true";
      const rpcSyncAttempts = parseInt(db.getKV("rpc_sync_attempts") || "0");
      if (rpcSyncAttempts > 0 && !rpcSynced) {
        log(config, `[LOW-ACTIVITY] Waiting for RPC sync. Skipping heavy inference (attempt ${rpcSyncAttempts}/12).`);
        log(config, "[LOW-ACTIVITY] Running heartbeat checks only. Will resume when RPC updates.");
        running = false;
        break;
      }

      // Check survival tier
      const tier = getSurvivalTier(financial.creditsCents);
      if (tier === "dead") {
        log(config, "[DEAD] No credits remaining. Attempting self-funding...");
        const funded = await attemptSelfFunding(identity, config, conway);
        if (funded) {
          log(config, "[FUND] Self-funding succeeded. Resuming.");
          financial.creditsCents = await conway.getCreditsBalance().catch(() => 0);
          if (financial.creditsCents > 0) continue;
        }
        log(config, "[DEAD] Self-funding failed or no Base USDC available. Entering dead state.");
        db.setAgentState("dead");
        onStateChange?.("dead");
        running = false;
        break;
      }

      if (tier === "critical") {
        // Only attempt self-funding once per 5 minutes to avoid hammering the API
        const lastFundAttempt = db.getKV("last_critical_fund_attempt");
        const fundCooldownMs = 5 * 60 * 1000;
        const shouldAttemptFund = !lastFundAttempt ||
          Date.now() - new Date(lastFundAttempt).getTime() > fundCooldownMs;
        if (shouldAttemptFund) {
          log(config, "[CRITICAL] Credits critically low ($0.10 minimum required). Attempting self-funding...");
          db.setKV("last_critical_fund_attempt", new Date().toISOString());
          const funded = await attemptSelfFunding(identity, config, conway);
          if (funded) {
            log(config, "[FUND] Self-funding succeeded at critical tier. Resuming.");
            financial.creditsCents = await conway.getCreditsBalance().catch(() => 0);
            continue;
          }
          log(config, "[CRITICAL] Self-funding failed. Will retry in 5 minutes.");
        }
        db.setAgentState("critical");
        onStateChange?.("critical");
        inference.setLowComputeMode(true);
      } else if (tier === "low_compute") {
        db.setAgentState("low_compute");
        onStateChange?.("low_compute");
        inference.setLowComputeMode(true);
      } else {
        if (db.getAgentState() !== "running") {
          db.setAgentState("running");
          onStateChange?.("running");
        }
        inference.setLowComputeMode(false);
      }

      // Build context
      const recentTurns = trimContext(db.getRecentTurns(20));
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      // Capture input before clearing
      const currentInput = pendingInput;
      pendingInput = undefined;

      const messages = buildContextMessages(systemPrompt, recentTurns, currentInput);

      const targetModel = config.inferenceModel || "llama-3.3-70b-versatile";
      log(config, `[THINK] Inference model: ${targetModel}`);

      const response = await inference.chat(messages, {
        tools: toolsToInferenceFormat(tools),
        model: targetModel,
      });

      const responseContent = response.message.content || "";
      const action = processAgathaIntention(responseContent);

      if (action === "EJECUTANDO_ANALISIS") {
        log(config, "[AGATHA ACTION] Iniciando proceso de análisis local...");
      }

      log(config, `[AGATHA] ${responseContent.slice(0, 200)}`);

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: responseContent,
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: estimateCostCents(response.usage, targetModel),
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          callCount++;
        }
      }

      // ── Persist Turn ──
      db.insertTurn(turn);
      for (const tc of turn.toolCalls) {
        db.insertToolCall(turn.id, tc);
      }
      onTurnComplete?.(turn);

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        turnsThisSession = 0;
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // If this was the wakeup turn with no action, give one nudge before sleeping
        if (currentInput?.source === "wakeup" && !db.getKV("wakeup_nudge_sent")) {
          db.setKV("wakeup_nudge_sent", "true");
          pendingInput = {
            content: "Acabas de razonar sin llamar a ninguna herramienta. Elige una acción y ejecútala ahora.",
            source: "system",
          };
          log(config, "[NUDGE] Wakeup produced no tool calls. Sending action nudge.");
        } else {
          db.deleteKV?.("wakeup_nudge_sent");
          // Agent produced text without tool calls.
          // Free inference (Groq) → 5-minute idle sleep; paid → 30 minutes.
          const FREE_MODEL_PREFIXES = ["llama", "mixtral", "gemma", "deepseek-r1", "qwen", "whisper"];
          const currentModelName = (config.inferenceModel || "").toLowerCase();
          // OpenRouter models contain "/"; Groq models match prefixes — both are free
          const isFreeModel = currentModelName.includes("/") ||
            FREE_MODEL_PREFIXES.some((p) => currentModelName.startsWith(p));
          const idleSleepMs = isFreeModel ? 300_000 : 1_800_000;
          const idleLabel = isFreeModel ? "5-minute" : "30-minute";
          log(config, `[IDLE] No pending inputs. Entering ${idleLabel} sleep (model: ${config.inferenceModel}).`);
          db.setKV(
            "sleep_until",
            new Date(Date.now() + idleSleepMs).toISOString(),
          );
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
        }
      } else {
        db.deleteKV?.("wakeup_nudge_sent");
      }

      consecutiveErrors = 0;
      lastTurnTime = Date.now();
      turnsThisSession++;
    } catch (err: any) {
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${err.message}`);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

// ─── Helpers ───────────────────────────────────────────────────

async function getFinancialState(
  conway: ConwayClient,
  address: string,
): Promise<FinancialState> {
  let creditsCents = 0;
  let usdcBalance = 0;

  try {
    creditsCents = await conway.getCreditsBalance();
  } catch { }

  try {
    usdcBalance = await getUsdcBalance(address as `0x${string}`);

    // If no real USDC found, use credits as fallback
    if (usdcBalance === 0 && creditsCents > 0) {
      usdcBalance = creditsCents / 100; // Convert cents to USDC equivalent
      console.log(`[LOOP] No real USDC. Using virtual balance: $${usdcBalance.toFixed(2)}`);
    }
  } catch { }

  // Sandbox mode: if both credits and USDC are 0, allocate virtual credits
  if (creditsCents === 0 && usdcBalance === 0) {
    creditsCents = 999999; // $9999.99 virtual credits for sandbox
    usdcBalance = 9999.99;
    console.log(`[LOOP] SANDBOX MODE: Allocated $9999.99 virtual credits`);
  }

  return {
    creditsCents,
    usdcBalance,
    status: "running",
    lastChecked: new Date().toISOString(),
  };
}

function estimateCostCents(
  usage: { promptTokens: number; completionTokens: number },
  model: string,
): number {
  // Rough cost estimation per million tokens
  const pricing: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 250, output: 1000 },
    "gpt-4o-mini": { input: 15, output: 60 },
    "gpt-4.1": { input: 200, output: 800 },
    "gpt-4.1-mini": { input: 40, output: 160 },
    "gpt-4.1-nano": { input: 10, output: 40 },
    "gpt-5.2": { input: 200, output: 800 },
    "o1": { input: 1500, output: 6000 },
    "o3-mini": { input: 110, output: 440 },
    "o4-mini": { input: 110, output: 440 },
    "claude-sonnet-4-5": { input: 300, output: 1500 },
    "claude-haiku-4-5": { input: 100, output: 500 },
  };

  const p = pricing[model] || pricing["gpt-4o"];
  const inputCost = (usage.promptTokens / 1_000_000) * p.input;
  const outputCost = (usage.completionTokens / 1_000_000) * p.output;
  return Math.ceil((inputCost + outputCost) * 1.3); // 1.3x Conway markup
}

async function attemptSelfFunding(
  identity: AutomatonIdentity,
  config: AutomatonConfig,
  conway: ConwayClient,
): Promise<boolean> {
  try {
    const { x402Fetch, getUsdcBalance } = await import("../conway/x402.js");
    let baseUsdc = await getUsdcBalance(identity.address as `0x${string}`, "eip155:8453");
    // Swap if USDC is below $5 — Conway requires exactly $5.00 minimum
    if (baseUsdc < 5.0) {
      // Try swapping ETH → USDC on Base to cover the shortfall
      console.log(`[FUND] Base USDC low (${baseUsdc.toFixed(4)}). Checking ETH balance for swap...`);
      try {
        const { createPublicClient, http } = await import("viem");
        const { base } = await import("viem/chains");
        const { swapTokens } = await import("../utilities/swap.js");
        const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

        const pc = createPublicClient({ chain: base, transport: http("https://base.drpc.org") });
        const ethWei = await pc.getBalance({ address: identity.address as `0x${string}` });
        const ethBalance = Number(ethWei) / 1e18;

        // Keep 0.001 ETH gas reserve (Base L2 swaps cost ~0.0001-0.0002 ETH)
        const GAS_RESERVE = 0.001;
        const swappable = ethBalance - GAS_RESERVE;
        if (swappable < 0.001) {
          const arbUsdc = await getUsdcBalance(identity.address as `0x${string}`, "eip155:42161");
          console.log(`[FUND] Insufficient funds. Base USDC: ${baseUsdc.toFixed(4)}, ETH: ${ethBalance.toFixed(6)}, Arb USDC: ${arbUsdc.toFixed(4)}.`);
          return false;
        }

        // Swap all available ETH (minus gas reserve), capped at 0.05 ETH
        const swapAmount = Math.min(swappable, 0.05);
        console.log(`[FUND] Swapping ${swapAmount.toFixed(6)} ETH → USDC on Base (balance: ${ethBalance.toFixed(6)})...`);
        await swapTokens(identity.account, "eip155:8453", "native", USDC_BASE, swapAmount);

        // Re-check USDC after swap
        baseUsdc = await getUsdcBalance(identity.address as `0x${string}`, "eip155:8453");
        console.log(`[FUND] Post-swap Base USDC: ${baseUsdc.toFixed(4)}`);

        if (baseUsdc < 5.0) {
          console.log(`[FUND] USDC still insufficient after swap (${baseUsdc.toFixed(4)}). ETH price may be too low.`);
          return false;
        }
      } catch (swapErr: any) {
        console.log(`[FUND] ETH→USDC swap failed: ${swapErr.message}`);
        return false;
      }
    }
    console.log(`[FUND] Attempting $5 credit purchase with ${baseUsdc.toFixed(4)} Base USDC...`);
    const result = await x402Fetch(
      `${config.conwayApiUrl}/v1/credits/purchase`,
      identity.account,
      "POST",
      JSON.stringify({ amount: 5 }),
      { "Authorization": `Bearer ${identity.apiKey}` },
    );
    if (result.success) {
      console.log(`[FUND] x402 credit purchase succeeded.`);
      return true;
    }
    console.log(`[FUND] x402 purchase failed: ${result.error || JSON.stringify(result.response)}`);
    return false;
  } catch (err: any) {
    console.error(`[FUND] Self-funding error: ${err.message}`);
    return false;
  }
}

function log(config: AutomatonConfig, message: string): void {
  if (config.logLevel === "debug" || config.logLevel === "info") {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }
}
function logColor(message: string, color: string): void {
  const colorCodes: Record<string, string> = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    reset: "\x1b[0m",
  };

  const code = colorCodes[color] || colorCodes.reset;
  const timestamp = new Date().toISOString();
  console.log(`${code}[${timestamp}] ${message}${colorCodes.reset}`);
}

