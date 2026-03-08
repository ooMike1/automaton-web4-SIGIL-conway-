import { createPublicClient, http, getAddress } from 'viem';
import { arbitrum } from 'viem/chains';

const client = createPublicClient({
  chain: arbitrum,
  transport: http('https://arb1.arbitrum.io/rpc'),
});

const USDC = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F8f';
const wallet = '0x0B864EC2fe25Ed628071Aa78934F7d8ca9b3557f';

const abi = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ name: '', type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}];

try {
  const balance = await client.readContract({
    address: getAddress(USDC),
    abi,
    functionName: 'balanceOf',
    args: [getAddress(wallet)],
  });
  console.log('✅ USDC Balance on Arbitrum:', Number(balance) / 1_000_000, 'USDC');
  process.exit(0);
} catch (err) {
  console.error('❌ Error:', err.message);
  process.exit(1);
}
