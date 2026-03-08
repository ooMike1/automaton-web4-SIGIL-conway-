/**
 * DeFi Arbitrage Skill
 * Monitors Arbitrum DEXs for price discrepancies
 */

import { createPublicClient, http, parseUnits, formatUnits } from 'viem';
import { arbitrum } from 'viem/chains';

interface PricePoint {
  dex: string;
  tokenPair: string;
  price: number;
  timestamp: number;
}

interface ArbitrageOpportunity {
  tokenPair: string;
  buyDex: string;
  buyPrice: number;
  sellDex: string;
  sellPrice: number;
  profit: number;
  profitPercent: number;
  timestamp: number;
}

// Popular ARB DEXs with their factory contracts
const DEX_CONFIGS: Record<string, { name: string; factory: string; type: 'uniswap-v3' | 'curve' | 'other' }> = {
  uniswap_v3: {
    name: 'Uniswap V3',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea3113FF',
    type: 'uniswap-v3',
  },
  camelot: {
    name: 'Camelot',
    factory: '0x6EcCab422D763ac031210895C81787E87B43A82e',
    type: 'other',
  },
};

// Common token pairs to monitor
const TRADING_PAIRS = [
  { symbol: 'ETH/USDC', tokens: ['0x82af49447d8a07e3bd95bd0d56f313302c1d5fd7', '0xff970a61a04b1ca14834a43f5de4533ebddb5f8f'] },
  { symbol: 'ARB/USDC', tokens: ['0x912ce59144191c1204e64559fe8253a0e108ff3e', '0xff970a61a04b1ca14834a43f5de4533ebddb5f8f'] },
  { symbol: 'GMX/USDC', tokens: ['0xfc5a1a6eb076a20758fdc0aacae4df00924f5e60', '0xff970a61a04b1ca14834a43f5de4533ebddb5f8f'] },
];

class DeFiArbitrageMonitor {
  private client = createPublicClient({
    chain: arbitrum,
    transport: http('https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq'),
  });

  private priceHistory: PricePoint[] = [];
  private opportunities: ArbitrageOpportunity[] = [];

  async getPricesFromGraphQL(): Promise<PricePoint[]> {
    const prices: PricePoint[] = [];

    for (const pair of TRADING_PAIRS) {
      try {
        // Query Uniswap V3 subgraph for ETH/USDC pair
        const query = `
          {
            swaps(first: 1, orderBy: timestamp, orderDirection: desc, 
              where: { pool: "0x82e74224d38cea4b5604dd4d67f61dabc02d599a" }) {
              amountUSD
              amount0
              amount1
              pool {
                token0Price
                token1Price
              }
            }
          }
        `;

        const response = await fetch(
          'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3-arbitrum',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          }
        );

        const data = await response.json();
        if (data.data?.swaps?.[0]) {
          const swap = data.data.swaps[0];
          prices.push({
            dex: 'Uniswap V3',
            tokenPair: pair.symbol,
            price: Number(swap.pool.token0Price),
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[ARBITRAGE] Error fetching ${pair.symbol}:`, err);
      }
    }

    return prices;
  }

  async detectOpportunities(): Promise<ArbitrageOpportunity[]> {
    // Fetch current prices
    const prices = await this.getPricesFromGraphQL();
    this.priceHistory.push(...prices);

    // Keep only last hour of data
    const oneHourAgo = Date.now() - 3600000;
    this.priceHistory = this.priceHistory.filter(p => p.timestamp > oneHourAgo);

    const opportunities: ArbitrageOpportunity[] = [];

    // Group prices by trading pair
    for (const pair of TRADING_PAIRS) {
      const pairPrices = this.priceHistory.filter(p => p.tokenPair === pair.symbol);
      
      if (pairPrices.length < 2) continue;

      // Find min and max prices
      const minPrice = Math.min(...pairPrices.map(p => p.price));
      const maxPrice = Math.max(...pairPrices.map(p => p.price));
      const profitPercent = ((maxPrice - minPrice) / minPrice) * 100;

      // Profitable if > 0.5% difference (after slippage & fees)
      if (profitPercent > 0.5) {
        const buyDex = pairPrices.find(p => p.price === minPrice)!.dex;
        const sellDex = pairPrices.find(p => p.price === maxPrice)!.dex;

        opportunities.push({
          tokenPair: pair.symbol,
          buyDex,
          buyPrice: minPrice,
          sellDex,
          sellPrice: maxPrice,
          profit: maxPrice - minPrice,
          profitPercent,
          timestamp: Date.now(),
        });
      }
    }

    return opportunities;
  }

  formatReport(opportunities: ArbitrageOpportunity[]): string {
    if (opportunities.length === 0) {
      return '📊 No arbitrage opportunities detected (spreads < 0.5%)';
    }

    let report = '🎯 **ARBITRAGE OPPORTUNITIES DETECTED**\n\n';

    for (const opp of opportunities) {
      report += `**${opp.tokenPair}**\n`;
      report += `  Buy @ ${opp.buyDex}: $${opp.buyPrice.toFixed(6)}\n`;
      report += `  Sell @ ${opp.sellDex}: $${opp.sellPrice.toFixed(6)}\n`;
      report += `  Profit: ${opp.profitPercent.toFixed(3)}% ($${opp.profit.toFixed(6)})\n\n`;
    }

    return report;
  }
}

export async function executeArbitrageCheck(): Promise<string> {
  const monitor = new DeFiArbitrageMonitor();
  
  console.log('[ARBITRAGE] Starting DeFi arbitrage scan...');
  const opportunities = await monitor.detectOpportunities();
  const report = monitor.formatReport(opportunities);
  
  console.log(report);
  return report;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  executeArbitrageCheck().catch(console.error);
}
