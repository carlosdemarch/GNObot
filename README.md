# Gnosis GNO arbitrage

The scanner compares GNO/wxDAI quotes across Honeyswap V2, SushiSwap V2 and
Uniswap V3. It defaults to read-only mode. Executable routes currently support
only Honeyswap and SushiSwap V2, in either direction.

## Setup

Use Node.js 22 on the Raspberry Pi:

```sh
npm ci
cp .env.example .env
chmod 600 .env
npm run typecheck
npm run compile-contract
npm test
npm run scan
```

`npm run test:fork` additionally exercises a historical profitable Gnosis
state on a local fork; it requires access to the public Gnosis archive RPC and
sends no real transactions.

Keep the private key in `.env`, never in the example file or the log.
The scanner computes the net quote using `GAS_COST_XDAI`, an estimate, and
does not pin all reads to the triggering block. Failed V3 quotes are omitted.
Dry-run findings are not evidence that a trade could have been executed.

## Atomic execution

The contract pulls wxDAI from its owner, makes both V2 swaps in one transaction
and reverts unless the wxDAI returned covers principal and the required
profit. Reverts still cost gas. The bot sets the on-chain profit floor to
`MIN_NET_PROFIT_WXDAI` plus `ATOMIC_GAS_LIMIT` times the transaction gas
price. This assumes wxDAI and native xDAI have equal value; deployment,
approval and failed transaction gas are not included. Gas price is capped
on-chain and in the transaction, but the limit cannot prevent losses from
reverted transactions. It is not a flash loan.

**This is unaudited trading code.** Local mock tests do not guarantee safety or
profitability on Gnosis. Price changes, competition, RPC failures, chain
reorganizations, and gas can cause failed or unprofitable operations. If a
transaction's submission or confirmation is uncertain, inspect the wallet and
transaction before restarting. Run limits are in-memory and reset on restart.

To prepare, review the contract, compile it and independently verify token
and router addresses. Only deploy when prepared to spend real gas:

```sh
npm run deploy-contract -- --confirm-gnosis-deployment
```

The script checks chain ID, caps the transaction gas price and checks the
deployed bytecode. Add the reported address as `ATOMIC_EXECUTOR_ADDRESS` in
`.env`. The bot verifies its bytecode and immutable addresses against the local
artifact and the wallet address before trading. Recompile the same source with
the locked compiler if the artifact is missing.

Authorize a **finite** wxDAI allowance no greater than
`MAX_TOTAL_WXDAI_PER_RUN`. This is a separate, real transaction:

```sh
npm run approve-contract -- 25 --confirm-gnosis-approval
```

The example approves 25 wxDAI; a trade larger than the remaining allowance
will halt execution. Revoke the allowance with amount `0`. Approval persists
until spent or revoked, including after the process stops. Budget its gas
separately.

`EXECUTE_TRADES=true` and `ENABLE_MAINNET_TRADING=false` simulates the whole
atomic transaction when the scanner finds a qualifying V2 quote. It requires a
deployed contract, sufficient wxDAI and native xDAI, and an existing allowance.
Setting **both flags true** enables real trades. Do not enable
`ALLOW_UNPROFITABLE_SMOKE_TEST`; execution rejects it.

The bot sends at most `MAX_TRADES_PER_RUN` transactions per process and
commits at most `MAX_TOTAL_WXDAI_PER_RUN` to submitted attempts. The gas limit
is a per-transaction limit; a revert can consume gas. At runtime expiry it
stops accepting new scans and waits for an active scan/transaction to finish.
A crash or external termination can still interrupt monitoring.
