// Loads the REAL dapp in jsdom with a mock wallet against local chains + deployed contracts + a running relayer,
// then clicks through each QMS route type. Verifies the page's hand-encoded calldata matches the contracts.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const ganache = require('ganache');
const { JSDOM } = require('jsdom');
const { ethers } = require('ethers');
const { Relayer } = require('../relayer/relayer');
const deploy = require('../scripts/deploy');
const { apply } = require('../scripts/apply-config');
const { HUB_ID, chains } = require('../scripts/chains');

const root = path.join(__dirname, '..');
const art = n => JSON.parse(fs.readFileSync(path.join(root, 'build', n + '.json'), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const E = ethers.parseEther;
const waitFor = async (fn, ms = 40000, what = 'condition') => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(150); } };

(async () => {
  const ids = Object.keys(chains).map(Number);
  const servers = {}, urls = {}, prov = {};
  let port = 18700;
  for (const id of ids) {
    servers[id] = ganache.server({ logging: { quiet: true }, chain: { chainId: id, networkId: id }, wallet: { deterministic: true, defaultBalance: 100000 } });
    await servers[id].listen(++port); urls[id] = 'http://127.0.0.1:' + port;
    prov[id] = new ethers.JsonRpcProvider(urls[id], id, { staticNetwork: true, cacheTimeout: -1 });
  }
  const accts = Object.entries(await servers[HUB_ID].provider.getInitialAccounts()).map(([a, v]) => ({ address: ethers.getAddress(a), key: v.secretKey }));
  const [deployer, relayerAcct, user] = accts;

  const mockA = art('MockWQMS');
  const wq = await (await new ethers.ContractFactory(mockA.abi, mockA.bytecode, new ethers.Wallet(deployer.key, prov[HUB_ID])).deploy()).waitForDeployment();
  const WQMS = await wq.getAddress();
  const env = {
  ...process.env,
  DEPLOYER_KEY: deployer.key,
  RELAYER_ADDRESS: relayerAcct.address,
  WQMS_ADDRESS: WQMS,
  DEPLOYMENTS_FILE: path.join(os.tmpdir(), `deployments-dapp-test-${process.pid}.json`)
};
  for (const id of ids) env['RPC_' + id] = urls[id];
  const log0 = console.log; console.log = () => {};
  const dep = await deploy.main(env);
  const tmpHtml = path.join(os.tmpdir(), 'tetrix-dapp-test.html');
  fs.copyFileSync(path.join(root, 'dapp/tetrix-bridge.html'), tmpHtml);
  apply(tmpHtml, env.DEPLOYMENTS_FILE);
  console.log = log0;

  const relayer = new Relayer({
    chains: Object.fromEntries(Object.entries(dep.chains).map(([id, c]) => [id, { name: chains[id].name, role: c.role, bridge: c.bridge, startBlock: c.startBlock, provider: prov[id] }])),
    hubChainId: HUB_ID, key: relayerAcct.key, confirmations: 0, maxRange: 100, log: () => {}
  });
  relayer.run(300);

  // ---- mock EIP-1193 wallet bound to `user`, forwarding to whichever local chain is selected
  let walletChain = 11155111;
  const mockWallet = {
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [user.address];
        case 'eth_chainId': return '0x' + walletChain.toString(16);
        case 'wallet_switchEthereumChain': walletChain = parseInt(params[0].chainId, 16); return null;
        case 'eth_sendTransaction': {
          const tx = { ...params[0] };
          const gas = await prov[walletChain].send('eth_estimateGas', [tx]); // like a real wallet: reverts surface here
          tx.gas = '0x' + ((BigInt(gas) * 13n) / 10n).toString(16);
          return prov[walletChain].send('eth_sendTransaction', [tx]);
        }
        default: return prov[walletChain].send(method, params);
      }
    },
    on() {}, removeListener() {}
  };

  const dom = new JSDOM(fs.readFileSync(tmpHtml, 'utf8'), {
    runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
    beforeParse(w) {w.AbortController = AbortController;
      w.fetch = (u, o) => String(u).startsWith('http://127.0.0.1') ? fetch(u, o) : Promise.reject(new Error('offline'));
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      w.ethereum = mockWallet;
    }
  });


  const w = dom.window, d = w.document, ev = c => w.eval(c);
  await sleep(1200); // init + chainlist failure fallback

  for (const id of ids) {
    ev(`S.chains.get(${id}).rpcs=['${urls[id]}']`);
  }

  // Explicitly test the unsupported Sepolia -> QMS route.
  ev(`S.from={chainId:11155111,token:'${ethers.ZeroAddress}'};
       S.to={chainId:${HUB_ID},token:'${ethers.ZeroAddress}'};
       fixTokens();`);

  assert.equal(
    ev('routeKind()'),
    'blocked',
    'default Sepolia -> QMS is blocked'
  );


  await sleep(1200); // init + chainlist failure fallback
  for (const id of ids) ev(`S.chains.get(${id}).rpcs=['${urls[id]}']`);

console.log('DEBUG route state:', {
  from: ev('S.from.chainId'),
  to: ev('S.to.chainId'),
  supported: ev('[...SUPPORTED_CHAIN_IDS]'),
  route: ev('routeKind()')
});

assert.equal(ev('routeKind()'), 'blocked', 'default Sepolia -> QMS is blocked');


  d.getElementById('walletBtn').click();
  await waitFor(() => ev('S.account'), 5000, 'wallet connect');

  const typeAmount = async v => { const a = d.getElementById('amt'); a.value = v; a.dispatchEvent(new w.Event('input')); await waitFor(() => ev('S.q.state') !== 'loading' && ev('S.q.state') !== 'idle', 8000, 'quote'); };
  const route = (fromId, toId) => { ev(`S.from={chainId:${fromId},token:'${ethers.ZeroAddress}'};S.to={chainId:${toId},token:'${ethers.ZeroAddress}'};fixTokens();afterChange()`); };
  const runBridge = async () => {
    const btn = d.getElementById('go');
    await waitFor(() => !btn.disabled, 5000, 'bridge button enabled').catch(e => { throw new Error(e.message + ' | button="' + btn.textContent + '" q=' + JSON.stringify(ev('S.q')).slice(0,200) + ' amount=' + ev('S.amount') + ' msg=' + d.getElementById('msg').textContent); });
    btn.click();
    await waitFor(() => /Funds arrive[\s\S]*Received/.test(d.getElementById('prog').textContent) || /!/.test([...d.querySelectorAll('.st.error')].map(x => x.textContent).join('')) , 60000, 'bridge finish');
    const err = [...d.querySelectorAll('.st.error')].map(x => x.textContent).join(' | ');
    assert(!err, 'bridge step errored: ' + err);
    await waitFor(() => !ev('S.busy'), 5000, 'idle');
  };
  const tok = (id) => new ethers.Contract(dep.chains[id].token, art('WrappedQMS').abi, prov[id]);
  const out = [];
  const ok = n => { out.push(n); log0('  ok  ' + n); };
  const fresh = () => ethers.Wallet.createRandom().address;
  const setRecipient = r => { if (!ev('S.useRecipient'))d.getElementById('recipToggle').click(); const i = d.getElementById('recipIn'); i.value = r; i.dispatchEvent(new w.Event('input')); };

  // 1. QMS native -> Base Sepolia
  route(HUB_ID, 84532);
  assert.equal(ev('toTok().symbol'), 'wQMS');
  await typeAmount('2');
  assert.equal(d.getElementById('out').value, '2');
  const before = await tok(84532).balanceOf(user.address);
  await runBridge();
  assert.equal((await tok(84532).balanceOf(user.address)) - before, E('2'));
  ok('dapp: QMS (native) -> Base Sepolia mints wQMS');


const wqmsTok = ev(`chainOf(${HUB_ID}).tokens.find(t=>t.symbol==='WQMS').address`);
  // 4. Arbitrum Sepolia: get wQMS first, then wQMS -> WQMS (choose WQMS as the destination token)
  if (ev('S.useRecipient')) d.getElementById('recipToggle').click(); // back to my own wallet
  route(HUB_ID, 421614); await typeAmount('2'); await runBridge();
  assert.equal(await tok(421614).balanceOf(user.address), E('2'));
  route(421614, HUB_ID);
  ev(`S.to.token='${wqmsTok}';afterChange()`);
  assert.equal(ev('toTok().symbol'), 'WQMS');
  const r4 = fresh(); setRecipient(r4);
  await typeAmount('1.5');
  await runBridge();
  assert.equal(await wq.balanceOf(r4), E('1.5'));
  ok('dapp: Arbitrum Sepolia wQMS -> QMS delivered as WQMS');

  // 5. OP Sepolia round trip
  if (ev('S.useRecipient')) d.getElementById('recipToggle').click();
  route(HUB_ID, 11155420); await typeAmount('1'); await runBridge();
  assert.equal(await tok(11155420).balanceOf(user.address), E('1'));
  ok('dapp: QMS -> OP Sepolia');

  // 6. validation + blocked routes
  route(HUB_ID, 84532);
  await typeAmount('0.00001');
  assert.equal(ev('S.q.state'), 'error'); assert(/Minimum/.test(d.getElementById('msg').textContent));
  await typeAmount('99999');
  assert.equal(ev('S.q.state'), 'error'); assert(/Maximum/.test(d.getElementById('msg').textContent));
  ok('dapp: min / max validation');
  route(HUB_ID, 80002);
  assert.equal(ev('S.q.state'), 'unavailable');
  assert(d.getElementById('go').disabled);
  const vis = d.body.cloneNode(true); vis.querySelectorAll('script').forEach(x => x.remove());
  assert(!/relay/i.test(vis.textContent), 'no mention of Relay in the visible UI');
  ok('dapp: QMS <-> unsupported network is blocked, UI never mentions Relay');

  // 7. history reflects deliveries
  const hist = JSON.parse(w.localStorage.getItem('tetrixbridge.history.v1') || '[]');
  assert(hist.length >= 3 && hist.every(h => h.status === 'success' && h.own), 'history has completed entries');
  ok('dapp: history records completed transfers');

  relayer.stop();
  for (const id of ids) await servers[id].close();
  try { fs.unlinkSync(path.join(root, 'deployments.json')); } catch {}
  log0(`\n${out.length} dapp scenarios passed`);
  process.exit(0);
})().catch(e => { console.error('\nFAILED:', e); process.exit(1); });
