// Deploys the hub on QMS and a spoke (+ wQMS) on each remote chain, wires them together,
// writes deployments.json and patches the dapp config.
//
//   cp .env.example .env   (fill in DEPLOYER_KEY, RELAYER_ADDRESS, WQMS_ADDRESS)
//   npm run compile && npm run deploy
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { HUB_ID, chains, rpcFor } = require('./chains');

const root = path.join(__dirname, '..');
const art = n => JSON.parse(fs.readFileSync(path.join(root, 'build', n + '.json'), 'utf8'));

async function deployOn(wallet, name, args) {
  const a = art(name);
  const f = new ethers.ContractFactory(a.abi, a.bytecode, wallet);
  const c = await f.deploy(...args);
  const rc = await c.deploymentTransaction().wait();
  return { contract: c, address: await c.getAddress(), block: rc.blockNumber };
}

async function main(env = process.env) {
  
  const key = env.DEPLOYER_KEY;
  const relayer = env.RELAYER_ADDRESS;
  const wqms = env.WQMS_ADDRESS;

  let owner;
  try {
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('DEPLOYER_KEY must be a valid 32-byte private key');
    }
    owner = env.OWNER_ADDRESS || new ethers.Wallet(key).address;
  } catch (e) {
    throw new Error(`Invalid deployer configuration: ${e.message}`);
  }

  if (!ethers.isAddress(relayer || '') || relayer === ethers.ZeroAddress) {
    throw new Error('RELAYER_ADDRESS must be a valid, non-zero address');
  }

  if (!ethers.isAddress(wqms || '') || wqms === ethers.ZeroAddress) {
    throw new Error('WQMS_ADDRESS must be a valid, non-zero address');
  }

  if (!ethers.isAddress(owner) || owner === ethers.ZeroAddress) {
    throw new Error('OWNER_ADDRESS must be a valid, non-zero address');
  }

  if (owner.toLowerCase() === relayer.toLowerCase()) {
    throw new Error('OWNER_ADDRESS and RELAYER_ADDRESS must be different');
  }

  const only = (env.ONLY_CHAINS || '').split(',').filter(Boolean).map(Number);
  const out = { hubChainId: HUB_ID, wqms, relayer, owner, deployedAt: new Date().toISOString(), chains: {} };
  const outFile = path.resolve(
  root,
  env.DEPLOYMENTS_FILE || 'deployments.json'
);
  
  const prev = fs.existsSync(outFile)
    ? JSON.parse(fs.readFileSync(outFile, 'utf8'))
    : null;

  if (prev && !only.length) {
    throw new Error(
      'deployments.json already exists. Refusing a full redeployment. ' +
      'Use an intentional, reviewed partial deployment or back up the file first.'
    );
  }

  
  if (prev && only.length) {
    if (!prev.chains || !prev.chains[HUB_ID]) {
      throw new Error('Existing deployments.json is missing the hub deployment');
    }

    if (only.includes(HUB_ID)) {
      throw new Error(
        'Partial deployment of the hub is blocked. ' +
        'Deploying a new hub requires a separately reviewed migration plan.'
      );
    }

    out.chains = prev.chains;
  }



  // ---- hub
  const hubId = HUB_ID;
  const provH = new ethers.JsonRpcProvider(rpcFor(hubId, env), hubId, { staticNetwork: true, cacheTimeout: -1 });
  
  const actualHubChainId = await provH.send('eth_chainId', []);
  if (BigInt(actualHubChainId) !== BigInt(hubId)) {
    throw new Error(
      `Hub RPC chain ID mismatch: expected ${hubId}, got ${actualHubChainId}`
    );
  }
  console.log(`Hub RPC verified: chain ID ${actualHubChainId}`);
  
  const wqmsCode = await provH.getCode(wqms);
  if (wqmsCode === '0x' || wqmsCode === '0x0') {
    throw new Error(`No contract code found at WQMS_ADDRESS on ${chains[hubId].name}`);
  }
  console.log('WQMS contract verified: code found on QMS Testnet');


  const wH = new ethers.NonceManager(new ethers.Wallet(key, provH)); // tracks nonces locally; public RPCs can lag
  let hub;
  if (out.chains[hubId] && only.length && !only.includes(hubId)) {
    hub = { address: out.chains[hubId].bridge, block: out.chains[hubId].startBlock, contract: new ethers.Contract(out.chains[hubId].bridge, art('QmsBridgeHub').abi, wH) };
  } else {
    console.log('Deploying hub on', chains[hubId].name);
    hub = await deployOn(wH, 'QmsBridgeHub', [wqms, owner, relayer]);
    out.chains[hubId] = { name: chains[hubId].name, role: 'hub', bridge: hub.address, startBlock: hub.block };
    console.log('  hub', hub.address);
  }

  // ---- spokes
  for (const [idStr, c] of Object.entries(chains)) {
    const id = Number(idStr);
    if (c.role !== 'spoke' || (only.length && !only.includes(id))) continue;
    
    if (out.chains[id]) {
      throw new Error(
        `Deployment already exists for ${c.name} (${id}). ` +
        'Refusing to overwrite it automatically.'
      );
    }

    console.log('Deploying spoke on', c.name);
    const prov = new ethers.JsonRpcProvider(rpcFor(id, env), id, { staticNetwork: true, cacheTimeout: -1 });
    
    const actualChainId = await prov.send('eth_chainId', []);
    if (BigInt(actualChainId) !== BigInt(id)) {
      throw new Error(
        `${c.name} RPC chain ID mismatch: expected ${id}, got ${actualChainId}`
      );
    }
    console.log(`  RPC verified: ${c.name} (${actualChainId})`);

    const w = new ethers.NonceManager(new ethers.Wallet(key, prov));
    const sp = await deployOn(w, 'QmsBridgeSpoke', [hubId, owner, relayer]);
    const token = await sp.contract.token();
    out.chains[id] = { name: c.name, role: 'spoke', bridge: sp.address, token, startBlock: sp.block };
    console.log('  spoke', sp.address, 'wQMS', token);
    // register on hub
    const tx = await hub.contract.connect(wH).setChainSupport(id, true);
    await tx.wait();
    console.log('  hub now supports', c.name);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); // save as we go
  }
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log('\nWrote deployments.json');
  try {
  require('./apply-config').apply(
    path.resolve(root, env.DAPP_FILE || 'dapp/tetrix-bridge.html'),
    outFile
  );
} catch (e) {
  console.log('(dapp config not patched:', e.message + ')');
}
  return out;
}

module.exports = { main };
if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
