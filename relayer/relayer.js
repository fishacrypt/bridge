// Relayer: watches Bridged events on every chain and delivers them on the destination chain.
//  - hub (QMS) Bridged   -> spoke.mint(...)
//  - spoke Bridged       -> hub.release(...)
// Idempotent: the destination contract rejects an id that was already processed, and we check first.
const fs = require('fs');
const { ethers } = require('ethers');

const BRIDGED = ethers.id('Bridged(bytes32,uint256,address,address,uint256,uint256,bool)');
const IFACE = new ethers.Interface([
  'event Bridged(bytes32 indexed id, uint256 indexed dstChainId, address indexed sender, address recipient, uint256 amount, uint256 nonce, bool asNative)',
  'function processed(bytes32) view returns (bool)',
  'function release(uint256 srcChainId, uint256 nonce, address recipient, uint256 amount, bool asNative)',
  'function mint(uint256 srcChainId, uint256 nonce, address recipient, uint256 amount)'
]);

class Relayer {
  /**
   * @param {object} o
   * @param {Record<number,{provider, bridge:string, role:'hub'|'spoke', startBlock:number, name?:string}>} o.chains
   * @param {number} o.hubChainId
   * @param {string} o.key           relayer private key (same key on every chain)
   * @param {number} [o.confirmations]
   * @param {number} [o.maxRange]    max blocks per getLogs call
   * @param {{load():object, save(s:object):void}} [o.store]
   * @param {(m:string)=>void} [o.log]
   */
  constructor(o) {
    this.hubChainId = o.hubChainId;
    this.confirmations = o.confirmations ?? 3;
    this.maxRange = o.maxRange ?? 1000;
    this.log = o.log || (m => console.log(new Date().toISOString(), m));
    this.store = o.store || { load: () => ({}), save: () => {} };
    this.state = this.store.load() || {};
    this.state.lastBlock = this.state.lastBlock || {};
    this.chains = {};
    for (const [id, c] of Object.entries(o.chains)) {
      const wallet = new ethers.Wallet(o.key, c.provider);
      this.chains[id] = { ...c, id: Number(id), wallet, contract: new ethers.Contract(c.bridge, IFACE, wallet), name: c.name || String(id) };
      if (this.state.lastBlock[id] == null) this.state.lastBlock[id] = Math.max(0, (c.startBlock || 1) - 1);
    }
    this.stopped = false;
  }

  
  async deliver(src, ev) {
    const { id, dstChainId, sender, recipient, amount, nonce, asNative } = ev;

    // Validate the source chain and its configured role.
    const isHub = src.id === this.hubChainId;

    if (isHub && src.role !== 'hub') {
      throw new Error('Invalid configuration: hub chain has wrong role');
    }

    if (!isHub && src.role !== 'spoke') {
      throw new Error('Invalid configuration: source chain has wrong role');
    }

    // Validate the event fields.
    if (!ethers.isAddress(sender) || sender === ethers.ZeroAddress) {
      throw new Error('Invalid Bridged event sender');
    }

    if (!ethers.isAddress(recipient) || recipient === ethers.ZeroAddress) {
      throw new Error('Invalid Bridged event recipient');
    }

    if (amount <= 0n || nonce <= 0n) {
      throw new Error('Invalid Bridged event amount or nonce');
    }

    // The event ID must match the source chain and nonce.
    const expectedId = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [src.id, nonce]
      )
    );

    if (id.toLowerCase() !== expectedId.toLowerCase()) {
      throw new Error('Bridged event ID does not match source chain and nonce');
    }

    // A hub deposit must target a configured spoke.
    // A spoke withdrawal must target the hub.
    const dstId = isHub ? Number(dstChainId) : this.hubChainId;

    if (!Number.isSafeInteger(Number(dstChainId))) {
      throw new Error('Invalid destination chain ID');
    }

    if (!isHub && Number(dstChainId) !== this.hubChainId) {
      throw new Error('Spoke event does not target the hub');
    }

    if (isHub && dstId === this.hubChainId) {
      throw new Error('Hub event cannot target the hub itself');
    }

    const dst = this.chains[dstId];

    if (!dst) {
      throw new Error(`Destination chain ${dstId} is not configured`);
    }

    if (isHub && dst.role !== 'spoke') {
      throw new Error('Invalid destination: expected a spoke');
    }

    if (!isHub && dst.role !== 'hub') {
      throw new Error('Invalid destination: expected the hub');
    }

    // Check replay protection on the destination before sending.
    if (await dst.contract.processed(id)) return true;

    const send = () => dst.id === this.hubChainId
      ? dst.contract.release(src.id, nonce, recipient, amount, asNative)
      : dst.contract.mint(src.id, nonce, recipient, amount);

    let tx;

    try {
      tx = await send();
    } catch (e) {
      if (!/nonce/i.test(e.message || '')) throw e;

      // Give a lagging RPC node one chance to catch up.
      await new Promise(resolve => setTimeout(resolve, 1500));
      tx = await send();
    }

    this.log(
      `${src.name} -> ${dst.name}: ${ethers.formatEther(amount)} to ${recipient} (id ${id.slice(0, 10)}…) tx ${tx.hash}`
    );

    const rc = await tx.wait();

    if (rc.status !== 1) {
      throw new Error('Delivery transaction failed');
    }

    return true;
  }


  async scanChain(src) {
    const head = await src.wallet.provider.getBlockNumber();
    const safe = head - this.confirmations;
    let from = this.state.lastBlock[src.id] + 1;
    let delivered = 0;
    while (from <= safe) {
      const to = Math.min(from + this.maxRange - 1, safe);
      const logs = await src.wallet.provider.getLogs({ address: src.bridge, topics: [BRIDGED], fromBlock: from, toBlock: to });
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      for (const l of logs) {
        const p = IFACE.parseLog(l);
        const ev = {
  id: p.args.id,
  dstChainId: p.args.dstChainId,
  sender: p.args.sender,
  recipient: p.args.recipient,
  amount: p.args.amount,
  nonce: p.args.nonce,
  asNative: p.args.asNative
};
        try { await this.deliver(src, ev); delivered++; }
        catch (e) {
          // stop here, retry from this block next tick; other chains keep going
          this.state.lastBlock[src.id] = l.blockNumber - 1;
          this.store.save(this.state);
          this.log(`! delivery failed on ${src.name} (block ${l.blockNumber}): ${(e.shortMessage || e.message || e).toString().slice(0, 160)}`);
          return { delivered, failed: true };
        }
      }
      this.state.lastBlock[src.id] = to;
      this.store.save(this.state);
      from = to + 1;
    }
    return { delivered, failed: false };
  }

  /** One pass over every chain. Returns total deliveries. */
  async tick() {
    let n = 0;
    for (const c of Object.values(this.chains)) {
      try { n += (await this.scanChain(c)).delivered; }
      catch (e) { this.log(`! ${c.name}: ${(e.shortMessage || e.message || e).toString().slice(0, 160)}`); }
    }
    return n;
  }

  async run(pollMs = 8000) {
    this.log('relayer started: ' + Object.values(this.chains).map(c => c.name).join(', ') + ' as ' + Object.values(this.chains)[0].wallet.address);
    while (!this.stopped) {
      await this.tick();
      await new Promise(r => setTimeout(r, pollMs));
    }
  }
  stop() { this.stopped = true; }
}

function fileStore(path) {
  return {
    load() { try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return {}; } },
    save(s) { fs.writeFileSync(path, JSON.stringify(s, null, 2)); }
  };
}

module.exports = { Relayer, fileStore, BRIDGED, IFACE };
