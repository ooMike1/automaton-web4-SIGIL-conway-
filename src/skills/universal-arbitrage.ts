/**
 * Universal DeFi Arbitrage Engine v2
 *
 * Scanner:   GeckoTerminal API (free, no key needed)
 * Execution: viem on-chain swaps via Uniswap V3 on Base
 * Networks:  Base (executable) + Arbitrum (scan-only, no ETH for gas)
 *
 * Safety: DRY_RUN=true by default. Set to false only after verifying
 *         scanner produces correct spreads.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  Address,
} from 'viem';
import { base, arbitrum } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Safety gate ─────────────────────────────────────────────────────────────
// Change to false only after scanner has been validated with real price data
const DRY_RUN = true;

// ─── Config ──────────────────────────────────────────────────────────────────

const NETWORKS: Record<string, {
  geckoId: string;
  chain: typeof base | typeof arbitrum;
  rpcUrl: string;
  uniV3Router: Address;
  canExecute: boolean;
}> = {
  base: {
    geckoId: 'base',
    chain: base,
    rpcUrl: 'https://mainnet.base.org',
    uniV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    canExecute: true,  // ~0.001 ETH on Base for gas
  },
  arbitrum: {
    geckoId: 'arbitrum',
    chain: arbitrum,
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    uniV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
    canExecute: false, // ~0.000004 ETH on Arbitrum — not enough
  },
};

// Tokens to monitor per network (by address)
const WATCH_TOKENS: Record<string, Array<{ symbol: string; address: Address; decimals: number }>> = {
  base: [
    { symbol: 'WETH',  address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
    { symbol: 'AERO',  address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 },
  ],
  arbitrum: [
    { symbol: 'WETH', address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', decimals: 18 },
    { symbol: 'ARB',  address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
  ],
};

const MIN_TVL_USD        = 100_000; // ignore illiquid pools
const MIN_NET_PROFIT_USD = 0.50;    // min net profit to attempt execution
const EST_GAS_USD        = 0.15;    // estimated gas cost for 2-swap arb on Base
const MAX_REALISTIC_SPREAD_PCT = 2.0; // filter out price-direction errors

// ─── Types ───────────────────────────────────────────────────────────────────

interface Pool {
  address: Address;
  dexId: string;
  network: string;
  /** Normalized: always the target token we searched for */
  baseSymbol: string;
  quoteSymbol: string;
  /** USD price of baseSymbol in this pool */
  priceUsd: number;
  tvlUsd: number;
  /** Fee tier as percentage, e.g. 0.05 or 0.3 */
  feeTier: number;
  rawName: string;
}

interface Opportunity {
  network: string;
  tokenSymbol: string;
  pair: string;
  buyPool: Pool;
  sellPool: Pool;
  spreadPct: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  capitalUsd: number;
  canExecute: boolean;
  reason?: string;
}

// ─── GeckoTerminal Scanner ────────────────────────────────────────────────────

interface GeckoPool {
  address: Address;
  dexId: string;
  rawName: string;
  basePriceUsd: number;
  quotePriceUsd: number;
  tvlUsd: number;
  feeTier: number;
  baseSymbolRaw: string; // first symbol in pool name
}

async function fetchPoolsForToken(geckoNetworkId: string, tokenAddress: string): Promise<GeckoPool[]> {
  const url = `https://api.geckoterminal.com/api/v2/networks/${geckoNetworkId}/tokens/${tokenAddress}/pools?page=1`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`GeckoTerminal ${resp.status}: ${geckoNetworkId}/${tokenAddress}`);

  const data = await resp.json() as any;
  const results: GeckoPool[] = [];

  for (const item of (data.data ?? [])) {
    const attr = item.attributes ?? {};
    const tvlUsd = parseFloat(attr.reserve_in_usd ?? '0');
    if (tvlUsd < MIN_TVL_USD) continue;

    const basePriceUsd = parseFloat(attr.base_token_price_usd ?? '0');
    const quotePriceUsd = parseFloat(attr.quote_token_price_usd ?? '0');
    if (!basePriceUsd) continue;

    const feeMatch = (attr.name ?? '').match(/([\d.]+)%/);
    const feeTier = feeMatch ? parseFloat(feeMatch[1]) : 0.3;

    const dexId = item.relationships?.dex?.data?.id ?? 'unknown';
    const nameparts = (attr.name ?? '').split('/');
    const baseSymbolRaw = nameparts[0]?.trim().split(' ')[0] ?? '';
    const poolAddr = (attr.address ?? item.id?.split('_')?.[1] ?? '0x') as Address;

    results.push({ address: poolAddr, dexId, rawName: attr.name ?? '', basePriceUsd, quotePriceUsd, tvlUsd, feeTier, baseSymbolRaw });
  }
  return results;
}

/**
 * Get a consistent USD price for `targetSymbol` across pools.
 * - If target is the BASE token in the pool: use basePriceUsd directly.
 * - If target is the QUOTE token: use quotePriceUsd.
 * Pools where target appears in neither position (wrong naming) are skipped.
 */
function resolveTargetPrice(pool: GeckoPool, targetSymbol: string): number | null {
  const nameLower = pool.rawName.toLowerCase();
  const targetLower = targetSymbol.toLowerCase();

  // Check which side of the "/" the target is on
  const parts = pool.rawName.split('/');
  const basePartSymbol = parts[0]?.trim().split(' ')[0]?.toLowerCase() ?? '';
  const quotePartSymbol = parts[1]?.trim().split(' ')[0]?.toLowerCase() ?? '';

  if (basePartSymbol === targetLower) {
    return pool.basePriceUsd;  // target is base → basePriceUsd is the target's USD price
  } else if (quotePartSymbol === targetLower) {
    return pool.quotePriceUsd; // target is quote → quotePriceUsd is the target's USD price
  }

  // Can't determine — skip
  return null;
}

async function scanNetworkForOpportunities(
  networkId: string,
  capitalUsd: number,
): Promise<Opportunity[]> {
  const config = NETWORKS[networkId];
  const tokens = WATCH_TOKENS[networkId] ?? [];
  const opportunities: Opportunity[] = [];

  for (const token of tokens) {
    try {
      await new Promise(r => setTimeout(r, 500)); // rate limit: 30 req/min free
      const rawPools = await fetchPoolsForToken(config.geckoId, token.address);

      // Build normalized pool list: each entry has a consistent USD price for `token`
      const normalizedPools: Pool[] = [];
      for (const rp of rawPools) {
        const priceUsd = resolveTargetPrice(rp, token.symbol);
        if (priceUsd === null || priceUsd <= 0) continue;

        // Determine quote symbol (the other token in the pair)
        const parts = rp.rawName.split('/');
        const basePartSymbol = parts[0]?.trim().split(' ')[0] ?? '';
        const quotePartSymbol = parts[1]?.trim().split(' ')[0] ?? '';
        const quoteSymbol = basePartSymbol.toLowerCase() === token.symbol.toLowerCase()
          ? quotePartSymbol
          : basePartSymbol;

        normalizedPools.push({
          address: rp.address,
          dexId: rp.dexId,
          network: networkId,
          baseSymbol: token.symbol,
          quoteSymbol,
          priceUsd,
          tvlUsd: rp.tvlUsd,
          feeTier: rp.feeTier,
          rawName: rp.rawName,
        });
      }

      console.log(`[ARBITRAGE] ${networkId}/${token.symbol}: ${normalizedPools.length} pools (min TVL $${MIN_TVL_USD/1000}k)`);

      // Group by quote token so we compare like-for-like
      const byQuote = new Map<string, Pool[]>();
      for (const p of normalizedPools) {
        const k = p.quoteSymbol.toLowerCase();
        if (!byQuote.has(k)) byQuote.set(k, []);
        byQuote.get(k)!.push(p);
      }

      for (const [, poolGroup] of byQuote) {
        if (poolGroup.length < 2) continue;

        const sorted = [...poolGroup].sort((a, b) => a.priceUsd - b.priceUsd);
        const cheapest = sorted[0];
        const priciest = sorted[sorted.length - 1];

        const spreadPct = (priciest.priceUsd - cheapest.priceUsd) / cheapest.priceUsd * 100;

        // Sanity check: reject implausibly large spreads (price-direction artifact)
        if (spreadPct > MAX_REALISTIC_SPREAD_PCT) continue;
        if (spreadPct < 0.05) continue; // below noise floor

        const totalFeePct = cheapest.feeTier + priciest.feeTier;
        const grossProfitUsd = (spreadPct / 100) * capitalUsd;
        const feeCostUsd = (totalFeePct / 100) * capitalUsd;
        const netProfitUsd = grossProfitUsd - feeCostUsd - EST_GAS_USD;

        const executableOnNetwork = config.canExecute;
        let canExecute = !DRY_RUN && executableOnNetwork && netProfitUsd > MIN_NET_PROFIT_USD;
        let reason: string | undefined;

        if (DRY_RUN) reason = 'dry_run mode';
        else if (!executableOnNetwork) reason = 'no gas on this network';
        else if (netProfitUsd <= MIN_NET_PROFIT_USD) reason = `net $${netProfitUsd.toFixed(4)} < min $${MIN_NET_PROFIT_USD}`;

        opportunities.push({
          network: networkId,
          tokenSymbol: token.symbol,
          pair: `${token.symbol}/${priciest.quoteSymbol}`,
          buyPool: cheapest,
          sellPool: priciest,
          spreadPct,
          grossProfitUsd,
          netProfitUsd,
          capitalUsd,
          canExecute,
          reason,
        });
      }
    } catch (err: any) {
      console.error(`[ARBITRAGE] Error scanning ${networkId}/${token.symbol}: ${err.message}`);
    }
  }

  return opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}

// ─── Execution (Uniswap V3 only, Base) ───────────────────────────────────────

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
  stateMutability: 'nonpayable',
}] as const;

const SWAP_ROUTER_ABI = [{
  name: 'exactInputSingle', type: 'function',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn',            type: 'address' },
    { name: 'tokenOut',           type: 'address' },
    { name: 'fee',                type: 'uint24'  },
    { name: 'recipient',          type: 'address' },
    { name: 'amountIn',           type: 'uint256' },
    { name: 'amountOutMinimum',   type: 'uint256' },
    { name: 'sqrtPriceLimitX96',  type: 'uint256' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
  stateMutability: 'payable',
}] as const;

function feePctToUint24(pct: number): number {
  const map: Record<number, number> = { 0.01: 100, 0.05: 500, 0.3: 3000, 1: 10000 };
  return map[pct] ?? 3000;
}

async function executeSwapPair(opp: Opportunity): Promise<string> {
  const netConfig = NETWORKS[opp.network];

  const walletPath = join(homedir(), '.automaton', 'wallet.json');
  const walletData = JSON.parse(readFileSync(walletPath, 'utf-8'));
  const account = privateKeyToAccount(walletData.privateKey as `0x${string}`);

  const publicClient  = createPublicClient({ chain: netConfig.chain, transport: http(netConfig.rpcUrl) });
  const walletClient  = createWalletClient({ account, chain: netConfig.chain, transport: http(netConfig.rpcUrl) });

  const tokens = WATCH_TOKENS[opp.network] ?? [];
  const tokenIn  = tokens.find(t => t.symbol === opp.tokenSymbol);
  const tokenOut = tokens.find(t => t.symbol === opp.buyPool.quoteSymbol);
  if (!tokenIn || !tokenOut) return `❌ token config missing for ${opp.pair}`;

  // Use 90% of capital, leave 10% buffer
  const amountInUnits = parseUnits(
    (opp.capitalUsd * 0.9 / opp.buyPool.priceUsd).toFixed(tokenIn.decimals),
    tokenIn.decimals,
  );
  const minOut = amountInUnits * BigInt(9800) / BigInt(10000); // 2% slippage

  console.log(`[ARBITRAGE] 🚀 Executing ${opp.pair}: buy on ${opp.buyPool.dexId} @ $${opp.buyPool.priceUsd.toFixed(4)}, sell on ${opp.sellPool.dexId} @ $${opp.sellPool.priceUsd.toFixed(4)}`);

  // 1. Approve tokenIn
  const approveTx = await walletClient.writeContract({
    address: tokenIn.address,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [netConfig.uniV3Router, amountInUnits],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveTx });

  // 2. Swap tokenIn → tokenOut on cheaper pool
  const swap1 = await walletClient.writeContract({
    address: netConfig.uniV3Router,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      fee: feePctToUint24(opp.buyPool.feeTier),
      recipient: account.address,
      amountIn: amountInUnits,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: BigInt(0),
    }],
  });
  const r1 = await publicClient.waitForTransactionReceipt({ hash: swap1 });

  // 3. Approve tokenOut
  const approve2 = await walletClient.writeContract({
    address: tokenOut.address,
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [netConfig.uniV3Router, minOut],
  });
  await publicClient.waitForTransactionReceipt({ hash: approve2 });

  // 4. Swap tokenOut → tokenIn on more expensive pool
  const swap2 = await walletClient.writeContract({
    address: netConfig.uniV3Router,
    abi: SWAP_ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [{
      tokenIn: tokenOut.address,
      tokenOut: tokenIn.address,
      fee: feePctToUint24(opp.sellPool.feeTier),
      recipient: account.address,
      amountIn: minOut,
      amountOutMinimum: amountInUnits * BigInt(9950) / BigInt(10000),
      sqrtPriceLimitX96: BigInt(0),
    }],
  });
  await publicClient.waitForTransactionReceipt({ hash: swap2 });

  return `✅ Arbitrage done: ${opp.pair} | gas used: ${r1.gasUsed} | tx: ${swap2}`;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function executeUniversalArbitrage(capitalUsd = 4.0): Promise<string> {
  console.log('[ARBITRAGE] Starting universal arbitrage scan...');

  const lines: string[] = [];
  const allOpps: Opportunity[] = [];

  for (const networkId of Object.keys(NETWORKS)) {
    const opps = await scanNetworkForOpportunities(networkId, capitalUsd);
    allOpps.push(...opps);

    if (opps.length > 0) {
      lines.push(`📊 ${networkId}: ${opps.length} spread(s)`);
      for (const opp of opps.slice(0, 4)) {
        lines.push(
          `  ${opp.pair} | buy ${opp.buyPool.dexId} $${opp.buyPool.priceUsd.toFixed(4)} → sell ${opp.sellPool.dexId} $${opp.sellPool.priceUsd.toFixed(4)} | spread ${opp.spreadPct.toFixed(3)}% | net $${opp.netProfitUsd.toFixed(4)} | ${opp.canExecute ? '🚀 executing' : '⏸ ' + opp.reason}`
        );
      }
    } else {
      lines.push(`📊 ${networkId}: no spreads detected above noise floor`);
    }
  }

  // Execute best if eligible
  const executable = allOpps.filter(o => o.canExecute);
  if (executable.length > 0) {
    const best = executable[0];
    lines.push(`\n🎯 Best opportunity: ${best.pair} | net profit $${best.netProfitUsd.toFixed(4)}`);
    try {
      const result = await executeSwapPair(best);
      lines.push(result);
    } catch (err: any) {
      lines.push(`❌ Execution error: ${err.message?.substring(0, 150)}`);
    }
  } else if (DRY_RUN) {
    lines.push(`\n⚠️  DRY_RUN=true — no execution. Verify spreads are accurate before enabling.`);
  }

  return lines.join('\n');
}

export default executeUniversalArbitrage;
