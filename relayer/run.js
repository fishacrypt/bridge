
 // Production entry point: reads deployments.json + .env and runs forever.
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { Relayer, fileStore } = require('./relayer');
const { HUB_ID, chains, rpcFor } = require('../scripts/chains');

async function main() {
  const root = path.join(__dirname, '..');
  const dep = JSON.parse(
    fs.readFileSync(path.join(root, 'deployments.json'), 'utf8')
  );

  if (!process.env.RELAYER_KEY) {
    console.error('Set RELAYER_KEY in .env');
    process.exit(1);
  }

  const cfg = {};

  for (const [id, c] of Object.entries(dep.chains)) {
    cfg[id] = {
      name: chains[id].name,
      role: c.role,
      bridge: c.bridge,
      startBlock: c.startBlock,
      provider: new ethers.JsonRpcProvider(
        rpcFor(Number(id)),
        Number(id),
        { staticNetwork: true, cacheTimeout: -1 }
      )
    };
  }

  // Diagnostic: check the relayer's balance and network using its configured Base RPC.
  const base = cfg[84532];

  if (base) {
    const relayerWallet = new ethers.Wallet(process.env.RELAYER_KEY);
    const balance = await base.provider.getBalance(relayerWallet.address);
    const network = await base.provider.getNetwork();

    console.log('Base RPC relayer address:', relayerWallet.address);
    console.log('Base RPC chain ID:', network.chainId.toString());
    console.log('Base RPC relayer balance:', ethers.formatEther(balance), 'ETH');
  }

  const r = new Relayer({
    chains: cfg,
    hubChainId: HUB_ID,
    key: process.env.RELAYER_KEY,
    confirmations: Number(process.env.CONFIRMATIONS || 3),
    maxRange: Number(process.env.MAX_LOG_RANGE || 1000),
    store: fileStore(path.join(root, 'relayer-state.json'))
  });

  await r.run();
}

main().catch((error) => {
  console.error('Relayer startup failed:', error);
  process.exitCode = 1;
});
