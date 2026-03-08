import fetch from 'node-fetch';

const ALCHEMY_URL = 'https://arb-mainnet.g.alchemy.com/v2/OzJPWxPbbiSE_ug5Vi0vq';
const USDC_CONTRACT = '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5F8f';
const WALLET = '0x0B864EC2fe25Ed628071Aa78934F7d8ca9b3557f';

// balanceOf(address) function selector + padded address
const functionSelector = '0x70a08231';
const paddedAddress = '000000000000000000000000' + WALLET.substring(2);
const data = functionSelector + paddedAddress;

console.log('Calling balanceOf on USDC contract...');
console.log('Contract:', USDC_CONTRACT);
console.log('Wallet:', WALLET);
console.log('Data:', data);

fetch(ALCHEMY_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [
      { to: USDC_CONTRACT.toLowerCase(), data },
      'latest'
    ]
  })
})
  .then(r => r.json())
  .then(result => {
    console.log('Response:', JSON.stringify(result, null, 2));
    if (result.result && result.result !== '0x') {
      const balance = BigInt(result.result);
      const usdc = Number(balance) / 1e6;
      console.log('\n✅ USDC Balance:', usdc);
    } else {
      console.log('\n❌ No balance found (0x)');
    }
  })
  .catch(err => console.error('Error:', err.message));
