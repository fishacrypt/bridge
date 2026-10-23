// End-to-end test on 5 local chains (ganache). Uses the real deploy script and the real relayer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const ganache = require('ganache');
const { ethers } = require('ethers');
const { Relayer, fileStore } = require('../relayer/relayer');
const deploy = require('../scripts/deploy');
const { HUB_ID, chains } = require('../scripts/chains');

const root = path.join(__dirname, '..');
const art = n => JSON.parse(fs.readFileSync(path.join(root, 'build', n + '.json'), 'utf8'));
const E = ethers.parseEther;
const results = [];
const step = async (name, fn) => { await fn(); results.push(name); console.log('  ok  ' + name); };
const expectRevert = async (p, frag) => {
  try { await p; } catch (e) {
    const msg = (e.shortMessage || '') + ' ' + (e.message || '') + ' ' + JSON.stringify(e.info || {});
    if (frag && !msg.includes(frag)) throw new Error(`reverted, but expected "${frag}" in: ${msg.slice(0, 300)}`);
    return;
  }
  throw new Error('expected revert' + (frag ? ' (' + frag + ')' : ''));
};

(async () => {
  const ids = Object.keys(chains).map(Number);
  const servers = {}, urls = {}, keys = {};
  let port = 18600;
  for (const id of ids) {
    const s = ganache.server({ logging: { quiet: true }, chain: { chainId: id, networkId: id }, wallet: { deterministic: true, defaultBalance: 100000 }, miner: { blockTime: 0 } });
    await s.listen(++port);
    servers[id] = s; urls[id] = 'http://127.0.0.1:' + port;
  }
  const accts = await servers[HUB_ID].provider.getInitialAccounts();
  const list = Object.entries(accts).map(([a, v]) => ({ address: ethers.getAddress(a), key: v.secretKey }));
  const [deployer, relayerAcct, u1, u2] = list;
  const prov = {};
  for (const id of ids) prov[id] = new ethers.JsonRpcProvider(urls[id], id, { staticNetwork: true, cacheTimeout: -1 });
  const w = (id, acct) => new ethers.Wallet(acct.key, prov[id]);

  // WQMS (WETH9-style) on the "QMS" chain
  const mockA = art('MockWQMS');
  const wq = await (await new ethers.ContractFactory(mockA.abi, mockA.bytecode, w(HUB_ID, deployer)).deploy()).waitForDeployment();
  const WQMS = await wq.getAddress();

  // --- run the real deploy script against the local chains
  const tmpDapp = path.join(os.tmpdir(), 'dapp-test.html');
  fs.writeFileSync(tmpDapp, '<script>/* BRIDGE_CONFIG_START */const BRIDGE={};/* BRIDGE_CONFIG_END */</script>');
  const origCwd = process.cwd();
  const depFile = path.join(root, 'deployments.json');
  const hadDep = fs.existsSync(depFile) && fs.readFileSync(depFile);
  process.env.DAPP_FILE = path.relative(root, tmpDapp);
  const env = {
  ...process.env,
  DEPLOYER_KEY: deployer.key,
  RELAYER_ADDRESS: relayerAcct.address,
  WQMS_ADDRESS: WQMS,
  DEPLOYMENTS_FILE: path.join(os.tmpdir(), `deployments-test-${process.pid}.json`)
};
  for (const id of ids) env['RPC_' + id] = urls[id];
  console.log('deploying…');
  const dep = await deploy.main(env);
  const patched = fs.readFileSync(tmpDapp, 'utf8');
  assert(patched.includes(dep.chains[HUB_ID].bridge), 'dapp config patched with hub address');
  console.log('deployed to', ids.length, 'chains');

  const hubA = art('QmsBridgeHub'), spA = art('QmsBridgeSpoke'), tokA = art('WrappedQMS');
  const hub = (acct) => new ethers.Contract(dep.chains[HUB_ID].bridge, hubA.abi, w(HUB_ID, acct));
  const spoke = (id, acct) => new ethers.Contract(dep.chains[id].bridge, spA.abi, w(id, acct));
  const tok = (id) => new ethers.Contract(dep.chains[id].token, tokA.abi, prov[id]);
  const SPOKES = ids.filter(i => i !== HUB_ID);

  const stateFile = path.join(os.tmpdir(), 'relayer-state-test.json');
  try { fs.unlinkSync(stateFile); } catch {}
  const mkRelayer = (store) => new Relayer({
    chains: Object.fromEntries(Object.entries(dep.chains).map(([id, c]) => [id, { name: chains[id].name, role: c.role, bridge: c.bridge, startBlock: c.startBlock, provider: prov[id] }])),
    hubChainId: HUB_ID, key: relayerAcct.key, confirmations: 0, maxRange: 50, store, log: process.env.DEBUG ? (m => console.log('   [relayer]', m)) : (() => {})
  });
  const relayer = mkRelayer(fileStore(stateFile));
  
  await step('relayer rejects an invalid transfer ID', async () => {
    const src = relayer.chains[HUB_ID];
    const nonce = 1n;
    const id = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [HUB_ID, nonce]
      )
    );

    await assert.rejects(
      relayer.deliver(src, {
        id: ethers.ZeroHash,
        dstChainId: ids.find(id => id !== HUB_ID),
        sender: u1.address,
        recipient: u2.address,
        amount: E('1'),
        nonce,
        asNative: false
      }),
      /ID does not match/
    );
  });

  await step('relayer rejects a spoke event routed away from the hub', async () => {
    const spokeId = ids.find(id => id !== HUB_ID);
    const src = relayer.chains[spokeId];
    const nonce = 1n;
    const id = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [spokeId, nonce]
      )
    );

    await assert.rejects(
      relayer.deliver(src, {
        id,
        dstChainId: spokeId,
        sender: u1.address,
        recipient: u2.address,
        amount: E('1'),
        nonce,
        asNative: false
      }),
      /does not target the hub/
    );
  });

  await step('relayer rejects a zero-address recipient', async () => {
    const src = relayer.chains[HUB_ID];
    const nonce = 1n;
    const id = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [HUB_ID, nonce]
      )
    );

    await assert.rejects(
      relayer.deliver(src, {
        id,
        dstChainId: ids.find(id => id !== HUB_ID),
        sender: u1.address,
        recipient: ethers.ZeroAddress,
        amount: E('1'),
        nonce,
        asNative: false
      }),
      /recipient/
    );
  });

  const supply = async () => { let t = 0n; for (const id of SPOKES) t += await tok(id).totalSupply(); return t; };
  const pool = () => prov[HUB_ID].getBalance(dep.chains[HUB_ID].bridge);
  const fresh = () => ethers.Wallet.createRandom().address;

  console.log('running scenarios…');

  await step('hub supports all four remote chains', async () => {
    for (const id of SPOKES) assert.equal(await hub(deployer).supportedChain(id), true);
    assert.equal(await hub(deployer).supportedChain(1), false);
  });

  await step('native QMS -> Sepolia mints wQMS 1:1', async () => {
    const r = fresh();
    await (await hub(u1).depositNative(11155111, r, { value: E('5') })).wait();
    assert.equal(await tok(11155111).balanceOf(r), 0n, 'not minted before relayer runs');
    assert.equal(await relayer.tick(), 1);
    assert.equal(await tok(11155111).balanceOf(r), E('5'));
    assert.equal(await pool(), E('5'));
  });

  await step('WQMS -> Base Sepolia (unwraps into the native pool)', async () => {
    const r = fresh();
    await (await wq.connect(w(HUB_ID, u1)).deposit({ value: E('3') })).wait();
    await (await wq.connect(w(HUB_ID, u1)).approve(dep.chains[HUB_ID].bridge, E('2'))).wait();
    const before = await pool();
    await (await hub(u1).depositWQMS(E('2'), 84532, r)).wait();
    assert.equal(await pool(), before + E('2'));
    await relayer.tick();
    assert.equal(await tok(84532).balanceOf(r), E('2'));
  });

  await step('native QMS -> Arbitrum Sepolia and OP Sepolia', async () => {
    const a = fresh(), o = fresh();
    await (await hub(u1).depositNative(421614, a, { value: E('1') })).wait();
    await (await hub(u1).depositNative(11155420, o, { value: E('1.5') })).wait();
    assert.equal(await relayer.tick(), 2);
    assert.equal(await tok(421614).balanceOf(a), E('1'));
    assert.equal(await tok(11155420).balanceOf(o), E('1.5'));
  });

  // user u2 gets wQMS on every spoke for the return trips
  for (const id of SPOKES) {
    await (await hub(u1).depositNative(id, u2.address, { value: E('10') })).wait();
  }
  await relayer.tick();

  await step('wQMS -> QMS delivered as NATIVE (every remote chain)', async () => {
    for (const id of SPOKES) {
      const r = fresh();
      await (await spoke(id, u2).bridgeBack(E('1'), r, true)).wait();
      await relayer.tick();
      assert.equal(await prov[HUB_ID].getBalance(r), E('1'), chains[id].name);
    }
  });

  await step('wQMS -> QMS delivered as WQMS', async () => {
    const r = fresh();
    await (await spoke(84532, u2).bridgeBack(E('2'), r, false)).wait();
    await relayer.tick();
    assert.equal(await wq.balanceOf(r), E('2'));
  });

  await step('solvency: wQMS supply <= native QMS locked', async () => {
    assert((await supply()) <= (await pool()), `${await supply()} vs ${await pool()}`);
  });

  await step('relayer is idempotent (re-run and fresh state deliver nothing twice)', async () => {
    assert.equal(await relayer.tick(), 0);
    const r2 = mkRelayer({ load: () => ({}), save: () => {} }); // lost state file: rescans from deploy block
    const sBefore = await supply(), pBefore = await pool();
    await r2.tick();
    assert.equal(await supply(), sBefore);
    assert.equal(await pool(), pBefore);
  });

  await step('relayer state persists to disk and resumes', async () => {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert(saved.lastBlock[HUB_ID] > 0);
    const r3 = mkRelayer(fileStore(stateFile));
    assert.equal(await r3.tick(), 0);
  });

  await step('replay and access control', async () => {
    const r = fresh();
    const tx = await hub(u1).depositNative(84532, r, { value: E('1') });
    const rc = await tx.wait();
    await relayer.tick();
    const nonce = (await spoke(84532, deployer).queryFilter('Bridged')).length; // not used; replay uses real nonce below
    const hubC = hub(u1);
    const ev = rc.logs.map(l => { try { return hubC.interface.parseLog(l); } catch { return null; } }).find(Boolean);
    const sp = new ethers.Contract(dep.chains[84532].bridge, spA.abi, w(84532, relayerAcct));
    await expectRevert(sp.mint.staticCall(HUB_ID, ev.args.nonce, r, E('1')), 'AlreadyProcessed'); // replay rejected
    await expectRevert(spoke(84532, u1).mint(HUB_ID, 9999, u1.address, E('1')));      // not relayer
    await expectRevert(hub(u1).release(84532, 1, u1.address, E('1'), true));           // not relayer
    await expectRevert(hub(u1).setChainSupport(1, true));                              // not owner
    await expectRevert(tok(84532).connect(w(84532, u1)).bridgeMint(u1.address, 1n));   // only bridge can mint
    const sp2 = new ethers.Contract(dep.chains[84532].bridge, spA.abi, w(84532, relayerAcct));
    await expectRevert(sp2.mint(84532, 1, u1.address, E('1')));                        // wrong source chain
  });

  await step('limits and unsupported destination', async () => {
    await expectRevert(hub(u1).depositNative(84532, u1.address, { value: 1n }));
    await expectRevert(hub(u1).depositNative(84532, u1.address, { value: E('1001') }));
    await expectRevert(hub(u1).depositNative(1, u1.address, { value: E('1') }));
    await expectRevert(hub(u1).depositNative(84532, ethers.ZeroAddress, { value: E('1') }));
    await expectRevert(spoke(84532, u2).bridgeBack(1n, u2.address, true));
  });

  await step('a recipient that rejects native QMS cannot block the queue (claimable fallback)', async () => {
    const f = art('RejectingReceiver');
    const rr = await (await new ethers.ContractFactory(f.abi, f.bytecode, w(HUB_ID, u1)).deploy()).waitForDeployment();
    const rrAddr = await rr.getAddress();
    await (await spoke(11155111, u2).bridgeBack(E('1'), rrAddr, true)).wait();
    const next = fresh();
    await (await spoke(11155111, u2).bridgeBack(E('1'), next, true)).wait(); // queued behind it
    await relayer.tick();
    assert.equal(await hub(u1).claimable(rrAddr), E('1'));
    assert.equal(await prov[HUB_ID].getBalance(next), E('1'), 'next transfer not blocked');
    await (await rr.setOpen(true)).wait();
    await (await rr.pull(dep.chains[HUB_ID].bridge)).wait();
    assert.equal(await prov[HUB_ID].getBalance(rrAddr), E('1'));
    assert.equal(await hub(u1).totalClaimable(), 0n);
  });

  await step('insufficient hub liquidity: relayer retries, nothing lost, delivers once funded', async () => {
    const p = await pool();
    await (await hub(deployer).withdrawLiquidity(deployer.address, p)).wait(); // owner drains the pool
    const r = fresh();
    await (await spoke(421614, u2).bridgeBack(E('1'), r, true)).wait();
    assert.equal(await relayer.tick(), 0);
    assert.equal(await prov[HUB_ID].getBalance(r), 0n);
    await (await w(HUB_ID, deployer).sendTransaction({ to: dep.chains[HUB_ID].bridge, value: p })).wait(); // top the pool back up
    assert.equal(await relayer.tick(), 1);
    assert.equal(await prov[HUB_ID].getBalance(r), E('1'));
  });

  await step('pause stops deposits and deliveries; unpause resumes', async () => {
    await (await hub(deployer).pause()).wait();
    await expectRevert(hub(u1).depositNative(84532, u1.address, { value: E('1') }));
    await (await hub(deployer).unpause()).wait();
    const r = fresh();
    await (await hub(u1).depositNative(84532, r, { value: E('1') })).wait();
    await (await spoke(84532, deployer).pause()).wait();
    assert.equal(await relayer.tick(), 0, 'delivery blocked while spoke paused');
    await (await spoke(84532, deployer).unpause()).wait();
    assert.equal(await relayer.tick(), 1);
    assert.equal(await tok(84532).balanceOf(r), E('1'));
  });

  await step('owner can rotate the relayer; old relayer is rejected', async () => {
    await (await hub(deployer).setRelayer(u1.address)).wait();
    const oldRel = new ethers.Contract(dep.chains[HUB_ID].bridge, hubA.abi, w(HUB_ID, relayerAcct));
    await expectRevert(oldRel.release(84532, 424242, u1.address, E('1'), true));
    await (await hub(deployer).setRelayer(relayerAcct.address)).wait();
  });

  await step('final solvency check', async () => {
    assert((await supply()) <= (await pool()));
  });

  for (const id of ids) await servers[id].close();
  if (hadDep) fs.writeFileSync(depFile, hadDep); else { try { fs.unlinkSync(depFile); } catch {} }
  console.log(`\n${results.length} scenarios passed`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
