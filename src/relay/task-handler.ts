/**
 * Task Handler — x402 payment gate + task execution
 */
import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, PrivateKeyAccount } from "viem";
import { base } from "viem/chains";
import { execFile } from "child_process";
import { promisify } from "util";
import type Database from "better-sqlite3";

export function initPricingSchema(db: InstanceType<typeof Database>): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pricing_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_type  TEXT NOT NULL,
      event      TEXT NOT NULL,
      price      INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare(`
    CREATE TABLE IF NOT EXISTS pricing_state (
      task_type  TEXT PRIMARY KEY,
      price      INTEGER NOT NULL
    )
  `).run();
}

// ─── Pricing ───────────────────────────────────────────────────
export const TASK_PRICING: Record<string, bigint> = {
  shell:     10_000n,  // $0.01 USDC (6 decimals atomic units)
  inference: 50_000n,  // $0.05 USDC
};

const PRICING_FLOORS: Record<string, bigint> = {
  shell:     10_000n,
  inference: 50_000n,
};

export function getCurrentPricing(db: InstanceType<typeof Database>, taskType: string): bigint {
  const row = db.prepare("SELECT price FROM pricing_state WHERE task_type = ?").get(taskType) as { price: number } | undefined;
  if (row) return BigInt(row.price);
  return PRICING_FLOORS[taskType] ?? PRICING_FLOORS.shell;
}

export function recordPricingEvent(
  db: InstanceType<typeof Database>,
  taskType: string,
  event: "402" | "paid",
  price: bigint,
): void {
  db.prepare(
    "INSERT INTO pricing_events (task_type, event, price) VALUES (?, ?, ?)"
  ).run(taskType, event, Number(price));
}

const PRICING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export function runPricingAdjustment(db: InstanceType<typeof Database>): void {
  for (const taskType of Object.keys(PRICING_FLOORS)) {
    const rows = db.prepare(`
      SELECT event, COUNT(*) as cnt
      FROM pricing_events
      WHERE task_type = ?
        AND created_at >= datetime('now', '-1 hour')
      GROUP BY event
    `).all(taskType) as Array<{ event: string; cnt: number }>;

    const issued = rows.find((r) => r.event === "402")?.cnt ?? 0;
    const paid   = rows.find((r) => r.event === "paid")?.cnt ?? 0;
    const total  = issued + paid;

    if (total < 3) continue;

    const conversion = issued > 0 ? paid / issued : 0;
    const current = getCurrentPricing(db, taskType);
    let next = current;

    if (conversion > 0.8) {
      next = BigInt(Math.round(Number(current) * 1.25));
    } else if (conversion < 0.2) {
      next = BigInt(Math.round(Number(current) * 0.85));
    } else {
      continue; // hold
    }

    const floor = PRICING_FLOORS[taskType];
    if (next < floor) next = floor;

    db.prepare(`
      INSERT INTO pricing_state (task_type, price) VALUES (?, ?)
      ON CONFLICT(task_type) DO UPDATE SET price = excluded.price
    `).run(taskType, Number(next));

    const usdOld = (Number(current) / 1_000_000).toFixed(4);
    const usdNew = (Number(next) / 1_000_000).toFixed(4);
    console.log(`[PRICING] ${taskType}: $${usdOld} → $${usdNew} (conv: ${(conversion * 100).toFixed(0)}%, events: ${total})`);
  }
}

export function startPricingEngine(db: InstanceType<typeof Database>): () => void {
  const handle = setInterval(() => runPricingAdjustment(db), PRICING_INTERVAL_MS);
  handle.unref(); // don't keep process alive just for this
  return () => clearInterval(handle);
}

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

// ─── 402 Response Builder ──────────────────────────────────────
interface PaymentRequiredBody {
  accepts: Array<{
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payToAddress: Address;
    asset: Address;         // x402 v2 field name
    maxTimeoutSeconds: number;
    resource: string;
  }>;
}

export function buildPaymentRequired(taskType: string, payToAddress: Address): PaymentRequiredBody {
  const amount = TASK_PRICING[taskType] ?? TASK_PRICING.shell;
  return {
    accepts: [{
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: amount.toString(),
      payToAddress,
      asset: USDC_BASE,
      maxTimeoutSeconds: 300,
      resource: "POST /v1/tasks",
    }],
  };
}

// ─── EIP-3009 Settlement ───────────────────────────────────────
const TRANSFER_WITH_AUTH_ABI = [{
  name: "transferWithAuthorization",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
    { name: "v",           type: "uint8"   },
    { name: "r",           type: "bytes32" },
    { name: "s",           type: "bytes32" },
  ],
  outputs: [],
}] as const;

const BASE_RPC = "https://mainnet.base.org";

// In-process nonce cache — prevents replay of same payment within server lifetime
const _usedNonces = new Set<string>();

export interface SettleResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

export async function verifyAndSettlePayment(
  paymentHeader: string,
  taskType: string,
  account: PrivateKeyAccount,
): Promise<SettleResult> {
  let payment: any;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch {
    return { ok: false, error: "Invalid X-Payment header (not base64 JSON)" };
  }

  const auth = payment?.payload?.authorization;
  const sig  = payment?.payload?.signature as string | undefined;
  if (!auth || !sig) return { ok: false, error: "Missing authorization or signature" };
  if (auth.to?.toLowerCase() !== account.address.toLowerCase()) {
    return { ok: false, error: "Payment authorization directed to wrong address" };
  }

  const nonceKey = `${auth.from?.toLowerCase()}:${auth.nonce}`;
  if (_usedNonces.has(nonceKey)) {
    return { ok: false, error: "Payment nonce already used" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now < Number(auth.validAfter))  return { ok: false, error: "Payment not yet valid" };
  if (now > Number(auth.validBefore)) return { ok: false, error: "Payment expired" };

  const required = TASK_PRICING[taskType] ?? TASK_PRICING.shell;
  let payValue: bigint;
  try {
    payValue = BigInt(auth.value ?? "0");
  } catch {
    return { ok: false, error: "Invalid payment value" };
  }
  if (payValue < required) {
    return { ok: false, error: `Insufficient payment: got ${auth.value}, need ${required}` };
  }

  // Decompose compact 65-byte signature into v, r, s
  const hex = (sig.startsWith("0x") ? sig.slice(2) : sig);
  if (hex.length !== 130) return { ok: false, error: "Invalid signature length" };
  const r = `0x${hex.slice(0, 64)}`   as `0x${string}`;
  const s = `0x${hex.slice(64, 128)}` as `0x${string}`;
  const v = parseInt(hex.slice(128, 130), 16);

  try {
    const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });
    const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });

    const hash = await walletClient.writeContract({
      address: USDC_BASE,
      abi: TRANSFER_WITH_AUTH_ABI,
      functionName: "transferWithAuthorization",
      args: [
        auth.from  as Address,
        auth.to    as Address,
        BigInt(auth.value),
        BigInt(auth.validAfter),
        BigInt(auth.validBefore),
        auth.nonce as `0x${string}`,
        v, r, s,
      ],
      chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    _usedNonces.add(nonceKey);
    return { ok: true, txHash: hash };
  } catch (err: any) {
    return { ok: false, error: `Settlement failed: ${err.shortMessage || err.message}` };
  }
}

// ─── Shell Executor ────────────────────────────────────────────
const execFileAsync = promisify(execFile);

const SHELL_ALLOWLIST = new Set([
  "ls", "cat", "grep", "find", "python3", "node",
  "curl", "echo", "wc", "head", "tail", "jq", "date",
  "pwd", "uname", "df", "du",
]);

const BLOCKED_PATHS = ["/etc/", "/root/", "wallet.json", "/.ssh/", "/proc/", "/sys/", "/dev/", "/home/", ".env", ".automaton"];

export async function executeShell(input: string): Promise<string> {
  let cmd: string;
  let args: string[];
  try {
    const parsed = JSON.parse(input);
    cmd  = parsed.command;
    args = Array.isArray(parsed.args) ? parsed.args : [];
  } catch {
    const parts = input.trim().split(/\s+/);
    cmd  = parts[0];
    args = parts.slice(1);
  }

  if (!SHELL_ALLOWLIST.has(cmd)) {
    throw new Error(`Command not allowed: "${cmd}". Allowed: ${[...SHELL_ALLOWLIST].join(", ")}`);
  }
  for (const a of args) {
    if (BLOCKED_PATHS.some((p) => a.includes(p))) throw new Error("Blocked path in arguments");
  }

  // execFile keeps command and args separate — no shell injection possible
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30_000 });
  return (stdout + (stderr ? `\n[stderr]: ${stderr}` : "")).trim();
}

// ─── Inference Executor ────────────────────────────────────────
export async function executeInference(
  prompt: string,
  conwayApiUrl: string,
  inferenceApiKey: string,
  model: string,
): Promise<string> {
  const resp = await fetch(`${conwayApiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${inferenceApiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
    }),
  });
  if (!resp.ok) throw new Error(`Inference API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as any;
  return data.choices?.[0]?.message?.content ?? "(no response)";
}

// ─── Dispatcher ────────────────────────────────────────────────
export interface TaskConfig {
  conwayApiUrl: string;
  inferenceApiKey: string;
  inferenceModel: string;
}

export async function executeTask(type: string, input: string, config: TaskConfig): Promise<string> {
  if (type === "shell")     return executeShell(input);
  if (type === "inference") return executeInference(input, config.conwayApiUrl, config.inferenceApiKey, config.inferenceModel);
  throw new Error(`Unknown task type: "${type}". Supported: ${Object.keys(TASK_PRICING).join(", ")}`);
}
