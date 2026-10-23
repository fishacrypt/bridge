// Chain definitions shared by deploy + relayer. RPCs can be overridden with RPC_<chainId> env vars.
module.exports = {
  HUB_ID: 19480,
  chains: {
    19480:    { name: 'QMS Testnet',      rpc: 'https://rpc.testnet.qms.finance',                  role: 'hub',   explorer: 'https://testnet.qmsscan.io' },
    11155111: { name: 'Sepolia',          rpc: 'https://ethereum-sepolia-rpc.publicnode.com',      role: 'spoke', explorer: 'https://sepolia.etherscan.io' },
    84532:    { name: 'Base Sepolia',     rpc: 'https://sepolia.base.org',                         role: 'spoke', explorer: 'https://sepolia-explorer.base.org' },
    421614:   { name: 'Arbitrum Sepolia', rpc: 'https://arbitrum-sepolia-rpc.publicnode.com',      role: 'spoke', explorer: 'https://sepolia.arbiscan.io' },
    11155420: { name: 'OP Sepolia',       rpc: 'https://sepolia.optimism.io',                      role: 'spoke', explorer: 'https://sepolia-optimism.etherscan.io' }
  },
  rpcFor(id, env = process.env) {
  const chain = module.exports.chains[id];

  if (!chain) {
    throw new Error(`Unknown chain ID: ${id}`);
  }

  return env['RPC_' + id] || chain.rpc;
}
};
