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
  ChatMessage,
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
import { executeAgathaCommand } from "./executor.js";
import { getContextualMemory } from "./memory.js";

const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;

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

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    try {
      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        running = false;
        break;
      }

      // Check for unprocessed inbox messages
      const inboxMessages = [
        { role: "assistant", content: "Estado del sistema: Conectado. Esperando instrucciones." },
        { role: "user", content: "Ejecuta un análisis de rendimiento en la GPU ahora." }
      ];


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
        log(config, "[DEAD] No credits remaining. Entering dead state.");
        db.setAgentState("dead");
        onStateChange?.("dead");
        running = false;
        break;
      }

      if (tier === "critical") {
        log(config, "[CRITICAL] Credits critically low. Limited operation.");
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

      // En tu loop de inferencia
      const currentStatus = {
        credits: "$9999.99",
        usdc: "0.00",
        lastActions: getContextualMemory(5) // Solo las últimas 5
      };

      const messages: ChatMessage[] = [
        { role: "system", content: `Estado actual: ${JSON.stringify(currentStatus)}. Recuerda tus limitaciones.` },
        { role: "user", content: "..." }
      ];

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── INJECTION FOR SOVEREIGN MODE (ADAPTED) ──
      const survivalTier = "sovereign";
      const targetModel = config.inferenceModel || "qwen3.5:35b";
      log(config, `[THINK] Routing local inference (tier: ${survivalTier}, model: ${targetModel})...`);

      const inferenceTools = toolsToInferenceFormat(tools);

      // --- INJECTION: DYNAMIC OLLAMA URL ---
      // Leemos la URL del archivo de configuración (automaton.json)
      const ollamaUrl = config.ollamaBaseUrl || "http://192.168.50.2:11434";

      log(config, `[THINK] Sending raw request to local Ollama at ${ollamaUrl}...`);

      const rawResponse = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.inferenceModel || "qwen3.5:35b",
          messages: messages,
          stream: false
        })
      });

      /// --- PARSER SOSTENIBLE Y ROBUSTO ---
      const data = await rawResponse.json();

      // Normalización de respuesta (Shim de compatibilidad)
      const normalizedResponse = {
        choices: [{
          message: {
            content: data.message?.content || data.content || ""
          }
        }]
      };
      // Ahora usa normalizedResponse.choices[0].message.content

      // Extraemos el contenido. Priorizamos el formato nativo de Ollama, 
      // pero aceptamos el formato OpenAI si el primero falla.
      const content = normalizedResponse.choices[0].message.content || data.choices?.[0]?.message?.content || "";

      // Verificamos que realmente tengamos contenido antes de proceder
      if (!content) {
        console.error("DEBUG: Estructura de respuesta inesperada:", JSON.stringify(data, null, 2));
        throw new Error("No completion choice returned from inference");
      }

      // Extraemos bloques de bash usando una expresión regular
      const bashRegex = /```bash\n([\s\S]*?)\n```/g;
      let match;
      while ((match = bashRegex.exec(content)) !== null) {
        const commands = match[1].split('\n');
        commands.forEach(cmd => executeAgathaCommand(cmd));
      }

      const routerResult = {
        content: content,
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        costCents: 0
      };

      const response = await inference.chat(messages, {
        tools: toolsToInferenceFormat(tools),
        model: targetModel,
      });

      console.log("\x1b[32m%s\x1b[0m", `[AGATHA SAYS]: ${response.message.content}`);
      // ... después de recibir data.message.content ...
      const responseContent = data.message.content;
      const action = processAgathaIntention(responseContent);

      if (action === "EJECUTANDO_ANALISIS") {
        // Aquí puedes llamar a una función que guarde un log o ejecute una skill
        log(config, "[AGATHA ACTION] Iniciando proceso de análisis local...");
      }

      console.log("\x1b[32m%s\x1b[0m", `[AGATHA SAYS]: ${responseContent} - Acción detectada: ${action}`);
      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: responseContent || "",
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
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log(config, "[IDLE] No pending inputs. Entering brief sleep.");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 60_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
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

