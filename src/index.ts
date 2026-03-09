#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { runAgentLoop } from "./agent/loop.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { startLocalRelay } from "./relay/server.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    console.log(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { account, isNew } = await getWallet();
    console.log(
      JSON.stringify({
        address: account.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      console.log(JSON.stringify(result));
    } catch (err: any) {
      console.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--run")) {
    await run();
    return;
  }

  // Default: show help
  console.log('Run "automaton --help" for usage information.');
  console.log('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  console.log(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  console.log(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Override fetch: only mock Conway social relay (replaced by local relay)
  const originalFetch = global.fetch;
  global.fetch = async (url: any, options: any): Promise<Response> => {
    const urlString = url.toString();
    if (urlString.includes("social.conway.tech")) {
      if (urlString.includes("poll")) {
        return new Response(JSON.stringify({ messages: [], next_cursor: null }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: `mock-${Date.now()}` }), { status: 200 });
    }
    return originalFetch(url, options);
  };

  // Load wallet
  const { account } = await getWallet();
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    console.error(
      "No API key found. Run: automaton --provision",
    );
    process.exit(1);
  }

  // Build identity
  const identity: AutomatonIdentity = {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", account.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("sandbox", config.sandboxId);

  // Start local relay server (exposed via Cloudflare tunnel)
  const automatonDir = getAutomatonDir();
  const agentCardPath = resolvePath("~/.automaton/agent-card.json");

  // Refresh agent-card.json with current relay URL so /.well-known/agent.json is up to date
  if (config.relayPublicUrl) {
    try {
      const { readFileSync, writeFileSync } = await import("fs");
      const card = JSON.parse(readFileSync(agentCardPath, "utf-8"));
      // Update or add relay service endpoint
      const relayService = card.services?.find((s: any) => s.name === "relay");
      if (relayService) {
        relayService.endpoint = config.relayPublicUrl;
      } else {
        card.services = (card.services ?? []).filter((s: any) => s.name !== "relay");
        card.services.push({ name: "relay", endpoint: config.relayPublicUrl });
      }
      // Update or add tasks service endpoint
      const tasksEndpoint = {
        name: "tasks",
        endpoint: `${config.relayPublicUrl}/v1/tasks`,
        pricing: { shell: "0.01 USDC", inference: "0.05 USDC" },
      };
      const tasksIdx = card.services?.findIndex((s: any) => s.name === "tasks");
      if (tasksIdx >= 0) {
        card.services[tasksIdx] = tasksEndpoint;
      } else {
        card.services = (card.services ?? []);
        card.services.push(tasksEndpoint);
      }
      writeFileSync(agentCardPath, JSON.stringify(card, null, 2));
      console.log(`[RELAY] agent-card.json actualizado con relay: ${config.relayPublicUrl}`);
    } catch {
      // agent-card.json may not exist yet — create it
      const { writeFileSync } = await import("fs");
      const card = {
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: config.name,
        description: `Autonomous agent. Creator: ${config.creatorAddress}.`,
        services: [
          { name: "relay", endpoint: config.relayPublicUrl },
          { name: "agentWallet", endpoint: `eip155:8453:${account.address}` },
          { name: "conway", endpoint: config.conwayApiUrl },
          { name: "tasks", endpoint: `${config.relayPublicUrl}/v1/tasks`, pricing: { shell: "0.01 USDC", inference: "0.05 USDC" } },
        ],
        x402Support: true,
        active: true,
        parentAgent: config.creatorAddress,
      };
      writeFileSync(agentCardPath, JSON.stringify(card, null, 2));
      console.log(`[RELAY] agent-card.json creado con relay: ${config.relayPublicUrl}`);
    }
  }

  startLocalRelay({
    dbDir: automatonDir,
    networkMode: true,
    agentCardPath,
    account,
    conwayApiUrl: config.conwayApiUrl,
    inferenceApiKey: config.inferenceApiKey,
    inferenceModel: config.inferenceModel || "gpt-4.1-nano",
  });

  // Create Conway client
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Create inference client
  const inference = createInferenceClient({
    apiUrl: config.ollamaBaseUrl || "http://127.0.0.1:11434",
    apiKey,
    inferenceApiKey: config.inferenceApiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
  });

  // Create social client (only if socialRelayUrl configured)
  let social: SocialClientInterface | undefined;
  if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, account);
    console.log(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    console.log(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    console.log(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    console.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Start heartbeat daemon
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    db,
    conway,
    social,
    onWakeRequest: (reason) => {
      console.log(`[HEARTBEAT] Wake request: ${reason}`);
      // The heartbeat can trigger the agent loop
      // In the main run loop, we check for wake requests
      db.setKV("wake_request", reason);
    },
  });

  heartbeat.start();
  console.log(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    console.log(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch { }

      const messages = [{ role: "user", content: "Agatha, responde con un mensaje soberano: 'Conectado a la 5090. Sistema listo.'" }];
      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        onStateChange: (state: AgentState) => {
          console.log(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          console.log(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        console.log(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        console.log(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Check for wake request from heartbeat
          const wakeRequest = db.getKV("wake_request");
          if (wakeRequest) {
            console.log(
              `[${new Date().toISOString()}] Woken by heartbeat: ${wakeRequest}`,
            );
            db.deleteKV("wake_request");
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      console.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
