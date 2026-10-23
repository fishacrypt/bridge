# Tetrix Bridge

Bridge **native QMS** and **WQMS** between QMS Testnet (19480) and:

| Network | Chain ID |
|---|---|
| Sepolia | 11155111 |
| Base Sepolia | 84532 |
| Arbitrum Sepolia | 421614 |
| OP Sepolia | 11155420 |

On QMS you hold native QMS or WQMS. On every other network you hold **wQMS**, a token minted 1:1 by the bridge.

## How it works

```
QMS Testnet                                   Remote chain (x4)
┌──────────────────┐   Bridged event          ┌────────────────────┐
│ QmsBridgeHub     │ ───────────────────────► │ QmsBridgeSpoke     │
│ one pool of      │   relayer calls mint()   │  └─ WrappedQMS     │
│ native QMS       │                          │     (wQMS, 18 dec) │
│                  │ ◄─────────────────────── │ burns wQMS         │
└──────────────────┘   relayer calls release()└────────────────────┘
```

- **QMS → remote:** user sends native QMS (or WQMS, which is unwrapped into the same pool) to the hub. The relayer sees the event and mints wQMS on the destination chain.
- **remote → QMS:** user burns wQMS on the spoke and picks **native QMS** or **WQMS** as the payout. The relayer calls `release` on the hub.
- **Solvency invariant:** wQMS supply across all remote chains is always ≤ native QMS locked in the hub, because wQMS only exists after QMS was locked.
- **No backend for the dapp.** The page talks to the contracts directly and tracks delivery with `processed(id)` on the destination chain. Only the relayer needs to run somewhere.

Safety built in: each transfer id is processed exactly once (replay-proof); pause switch on every contract; per-transfer min/max (default 0.0001 – 1000); a recipient that rejects native QMS cannot block the queue (the amount becomes `claimable` and they call `claim()`); contracts compile for the `paris` EVM so they work on chains without PUSH0.

## Setup

```bash
npm install
npm run compile
npm test                      # 24 scenarios on local chains, no keys or network needed
cp .env.example .env          # then fill it in
```

`.env` needs:

- `DEPLOYER_KEY` — funded with test ETH on the 4 remote chains and test QMS on QMS Testnet.
- `RELAYER_ADDRESS` / `RELAYER_KEY` — a **separate** wallet; the address goes to the contracts, the key to the relayer. Fund it with a little gas on all 5 chains.
- `WQMS_ADDRESS` — the WQMS contract on QMS Testnet (WETH9-style: `deposit()`, `withdraw(uint)`). Use the one QWAP uses. I could not find a published address, so check the QMS/QWAP docs or ask the team.

Then:

```bash
npm run deploy      # deploys hub + 4 spokes, wires them, writes deployments.json, patches dapp/tetrix-bridge.html
npm run relayer     # keep this running (VPS, Railway/Render worker, or `pm2 start`)
```

Host `dapp/tetrix-bridge.html` anywhere static (Vercel etc.). If you redeploy contracts later, run `npm run apply-config` and re-upload the page.

To (re)deploy only some chains: `ONLY_CHAINS=84532,421614 npm run deploy`.

## Running the relayer

- It scans every chain for `Bridged` events, waits `CONFIRMATIONS` (default 3), and delivers on the other side. State is saved to `relayer-state.json`, and if that file is lost it simply rescans (already-delivered transfers are skipped by the contract).
- If a delivery fails (e.g. out of gas), it retries on the next poll and keeps going on other chains.
- **Keep the relayer wallet funded** on every chain. Logs show `! delivery failed ...` when something is stuck.
- Public RPCs can rate-limit. Set `RPC_<chainId>` in `.env` to use your own endpoints.

## Operating notes (trust model: testnet)

- A single relayer key authorises all mints and releases. Anyone holding it can mint wQMS or drain the hub, so keep it off shared machines. Rotate with `setRelayer`.
- The owner can pause, change limits, and call `withdrawLiquidity` (it will not touch funds reserved for claimable payouts). Treat the owner key accordingly.
- If the owner drains the pool, remote → QMS deliveries wait (the relayer retries) until it is topped up; the dapp also warns users when the pool is short.
- Not audited. This is for a testnet; do not reuse the design with real value without a review and a multi-party relayer/validator set.

## Layout

```
contracts/   QmsBridgeHub, QmsBridgeSpoke, WrappedQMS, BridgeBase (+ test mocks)
scripts/     compile.js, deploy.js, apply-config.js, chains.js
relayer/     relayer.js (logic), run.js (entry point)
test/        e2e.js (contracts + relayer), dapp-e2e.js (the real page + mock wallet)
dapp/        tetrix-bridge.html
```
