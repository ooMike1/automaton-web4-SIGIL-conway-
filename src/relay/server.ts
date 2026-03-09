/**
 * Local Social Relay Server
 *
 * Servidor HTTP que implementa el protocolo de relay social de Conway.
 * Modo local (127.0.0.1): sin verificación de firma (confianza total).
 * Modo red (0.0.0.0): verifica firmas SIWE en endpoints de lectura.
 */

import http from "http";
import fs from "fs";
import { networkInterfaces } from "os";
import Database from "better-sqlite3";
import path from "path";
import { verifyMessage } from "viem";
import type { PrivateKeyAccount } from "viem";
import { ulid } from "ulid";
import {
  buildPaymentRequired,
  verifyAndSettlePayment,
  executeTask,
  TASK_PRICING,
} from "./task-handler.js";

export const DEFAULT_RELAY_PORT = 3701;
const SIG_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutos

export interface RelayOptions {
  dbDir: string;
  port?: number;
  networkMode?: boolean;
  agentCardPath?: string; // path to agent-card.json for /.well-known/agent.json
  account?: PrivateKeyAccount;
  conwayApiUrl?: string;
  inferenceApiKey?: string;
  inferenceModel?: string;
}

interface AuthResult {
  ok: boolean;
  address?: string;
  error?: string;
}

/** Detecta la IP LAN del host (primera IPv4 no-loopback). */
export function detectLanIp(): string | null {
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

export function startLocalRelay(options: RelayOptions): http.Server {
  const { dbDir, port = DEFAULT_RELAY_PORT, networkMode = false,
          agentCardPath, account, conwayApiUrl, inferenceApiKey, inferenceModel } = options;
  const host = networkMode ? "0.0.0.0" : "127.0.0.1";

  fs.mkdirSync(dbDir, { recursive: true });
  const db = new Database(path.join(dbDir, "relay.db"));
  db.pragma("journal_mode = WAL");
  db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      to_address   TEXT NOT NULL,
      content      TEXT NOT NULL,
      reply_to     TEXT,
      signed_at    TEXT NOT NULL,
      created_at   TEXT DEFAULT (datetime('now'))
    )
  `).run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_to ON messages(to_address)").run();

  // ─── Verificación de firma (solo modo red) ───────────────────
  async function verifyReadAuth(req: http.IncomingMessage): Promise<AuthResult> {
    if (!networkMode) {
      const addr = ((req.headers["x-wallet-address"] as string) ?? "").toLowerCase();
      if (!addr) return { ok: false, error: "Falta X-Wallet-Address" };
      return { ok: true, address: addr };
    }

    const address = ((req.headers["x-wallet-address"] as string) ?? "").toLowerCase();
    const signature = req.headers["x-signature"] as string;
    const timestamp = req.headers["x-timestamp"] as string;

    if (!address || !signature || !timestamp) {
      return { ok: false, error: "Faltan cabeceras: X-Wallet-Address, X-Signature, X-Timestamp" };
    }

    const ts = new Date(timestamp).getTime();
    if (isNaN(ts) || Date.now() - ts > SIG_MAX_AGE_MS) {
      return { ok: false, error: "Timestamp inválido o expirado (máx 5 min)" };
    }

    const canonical = `Conway:poll:${address}:${timestamp}`;
    try {
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message: canonical,
        signature: signature as `0x${string}`,
      });
      if (!valid) return { ok: false, error: "Firma inválida" };
      return { ok: true, address };
    } catch {
      return { ok: false, error: "Error verificando firma" };
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────
  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => resolve(body));
    });

  const sendJson = (res: http.ServerResponse, status: number, data: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  // ─── Servidor ────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];

    // POST /v1/messages — recibir mensaje (abierto a cualquiera)
    if (req.method === "POST" && pathname === "/v1/messages") {
      try {
        const { from, to, content, reply_to, signed_at } = JSON.parse(await readBody(req));
        if (!from || !to || !content) {
          return sendJson(res, 400, { error: "Faltan campos: from, to, content" });
        }
        const id = ulid();
        db.prepare(
          "INSERT INTO messages (id, from_address, to_address, content, reply_to, signed_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(id, from.toLowerCase(), to.toLowerCase(), content, reply_to ?? null, signed_at ?? new Date().toISOString());
        return sendJson(res, 201, { id });
      } catch (e: any) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // POST /v1/messages/poll — leer mensajes propios (autenticado en modo red)
    if (req.method === "POST" && pathname === "/v1/messages/poll") {
      const auth = await verifyReadAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.error });
      try {
        const body = await readBody(req);
        const { cursor, limit = 50 } = body ? JSON.parse(body) : {};
        const rows = cursor
          ? db.prepare(
              "SELECT rowid, * FROM messages WHERE to_address = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?"
            ).all(auth.address, parseInt(cursor, 10), limit)
          : db.prepare(
              "SELECT rowid, * FROM messages WHERE to_address = ? ORDER BY rowid ASC LIMIT ?"
            ).all(auth.address, limit);
        const nextCursor =
          rows.length > 0 ? String((rows[rows.length - 1] as any).rowid) : (cursor ?? undefined);
        return sendJson(res, 200, {
          messages: (rows as any[]).map((r) => ({
            id: r.id,
            from: r.from_address,
            to: r.to_address,
            content: r.content,
            signedAt: r.signed_at,
            createdAt: r.created_at,
            replyTo: r.reply_to ?? undefined,
          })),
          next_cursor: nextCursor,
        });
      } catch (e: any) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // GET /v1/messages/count — cuenta mensajes propios (autenticado en modo red)
    if (req.method === "GET" && pathname === "/v1/messages/count") {
      const auth = await verifyReadAuth(req);
      if (!auth.ok) return sendJson(res, 401, { error: auth.error });
      const row = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE to_address = ?").get(auth.address) as { cnt: number };
      return sendJson(res, 200, { unread: row.cnt });
    }

    // GET /health — estado del relay
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, {
        status: "ok",
        service: "conway-relay",
        mode: networkMode ? "network" : "local",
      });
    }

    // GET /.well-known/agent.json — EIP-8004 agent discovery
    if (req.method === "GET" && pathname === "/.well-known/agent.json") {
      const cardPath = agentCardPath ?? path.join(dbDir, "agent-card.json");
      try {
        const card = JSON.parse(fs.readFileSync(cardPath, "utf-8"));
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(card));
      } catch {
        return sendJson(res, 404, { error: "Agent card not found" });
      }
      return;
    }

    // POST /v1/tasks — paid task execution (x402)
    if (req.method === "POST" && pathname === "/v1/tasks") {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { return sendJson(res, 400, { error: "Invalid JSON body" }); }

      const { type, input } = body ?? {};
      if (!type || !input)        return sendJson(res, 400, { error: "Missing fields: type, input" });
      if (!TASK_PRICING[type])    return sendJson(res, 400, { error: `Unknown type "${type}". Supported: ${Object.keys(TASK_PRICING).join(", ")}` });
      if (!account)               return sendJson(res, 503, { error: "Agent wallet not configured" });

      const xPayment = req.headers["x-payment"] as string | undefined;

      if (!xPayment) {
        const req402 = buildPaymentRequired(type, account.address);
        res.writeHead(402, {
          "Content-Type": "application/json",
          "X-Payment-Required": Buffer.from(JSON.stringify(req402)).toString("base64"),
        });
        res.end(JSON.stringify(req402));
        return;
      }

      const settle = await verifyAndSettlePayment(xPayment, type, account);
      if (!settle.ok) {
        res.writeHead(402, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: settle.error }));
        return;
      }

      try {
        const result = await executeTask(type, input, {
          conwayApiUrl:    conwayApiUrl    ?? "https://api.conway.tech",
          inferenceApiKey: inferenceApiKey ?? "",
          inferenceModel:  inferenceModel  ?? "gpt-4.1-nano",
        });
        const cost = (Number(TASK_PRICING[type]) / 1_000_000).toFixed(2);
        return sendJson(res, 200, { result, type, cost: `${cost} USDC`, txHash: settle.txHash });
      } catch (err: any) {
        const status = (err.message.includes("not allowed") || err.message.includes("Blocked")) ? 400 : 500;
        return sendJson(res, status, { error: err.message });
      }
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.listen(port, host, () => {
    const displayHost = networkMode ? (detectLanIp() ?? "0.0.0.0") : "127.0.0.1";
    console.log(`[RELAY] Relay escuchando en http://${displayHost}:${port} (modo: ${networkMode ? "red" : "local"})`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[RELAY] Puerto ${port} ya en uso`);
    } else {
      console.error(`[RELAY] Error: ${err.message}`);
    }
  });

  return server;
}
