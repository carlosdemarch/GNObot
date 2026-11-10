import {
  createWalletClient,
  http,
  formatUnits,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';

export type Venue = 'honeyswap' | 'sushiswap' | 'uniswapv3';

export interface Opportunity {
  buyVenue: Venue; // wxDAI -> GNO
  sellVenue: Venue; // GNO -> wxDAI
  amountInWei: bigint; // wxDAI in
  expectedGnoWei: bigint; // GNO quoted on the buy leg
  expectedOutWei: bigint; // wxDAI quoted on the sell leg
  netProfitWei: bigint; // after the configured gas estimate
}

export interface ExecutorConfig {
  rpcUrl: string;
  wxdai: Address;
  gno: Address;
  executeTrades: boolean;
  enableMainnetTrading: boolean;
  allowUnprofitableSmokeTest: boolean;
  maxTradesPerRun: number;
  maxTotalWxdaiPerRun: bigint;
  maxGasPriceWei: bigint;
  maxSlippageBps: bigint;
  minNetProfitWei: bigint;
}

const ROUTERS: Record<Venue, Address> = {
  honeyswap: '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77',
  sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  uniswapv3: '0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be', // Uniswap V3 SwapRouter02
};
const UNISWAP_V3_FEE = 3000;
const SELL_RETRIES = 3;

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const V2_ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const V3_ROUTER_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

export function createExecutor(publicClient: PublicClient, cfg: ExecutorConfig) {
  const pk = process.env.PRIVATE_KEY?.trim();
  const canSign = Boolean(pk);
  const account = canSign
    ? privateKeyToAccount((pk!.startsWith('0x') ? pk! : `0x${pk}`) as Hex)
    : undefined;

  if (account && process.env.WALLET_ADDRESS) {
    if (process.env.WALLET_ADDRESS.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error('WALLET_ADDRESS does not match the address derived from PRIVATE_KEY');
    }
  }

  const wallet = account
    ? createWalletClient({ account, chain: gnosis, transport: http(cfg.rpcUrl) })
    : undefined;

  const live = cfg.executeTrades && cfg.enableMainnetTrading;
  let tradesDone = 0;
  let totalSpent = 0n;
  let busy = false;
  let halted = false;

  const mode = !cfg.executeTrades ? 'DRY-RUN' : live ? 'LIVE' : 'SIMULATE-ONLY';

  if (cfg.executeTrades && !account) {
    throw new Error('EXECUTE_TRADES=true requires PRIVATE_KEY in .env');
  }

  function swapRequest(
    venue: Venue,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    minOut: bigint,
    to: Address
  ) {
    const router = ROUTERS[venue];
    if (venue === 'uniswapv3') {
      return {
        address: router,
        abi: V3_ROUTER_ABI,
        functionName: 'exactInputSingle' as const,
        args: [
          {
            tokenIn,
            tokenOut,
            fee: UNISWAP_V3_FEE,
            recipient: to,
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0n,
          },
        ] as const,
      };
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
    return {
      address: router,
      abi: V2_ROUTER_ABI,
      functionName: 'swapExactTokensForTokens' as const,
      args: [amountIn, minOut, [tokenIn, tokenOut], to, deadline] as const,
    };
  }

  async function ensureAllowance(token: Address, spender: Address, needed: bigint) {
    const owner = account!.address;
    const current = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    if (current >= needed) return;
    console.log(`  [exec] Approving ${formatUnits(needed, 18)} of ${token} to ${spender}`);
    const hash = await wallet!.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, needed],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Approval reverted: ${hash}`);
  }

  async function balanceOf(token: Address): Promise<bigint> {
    return publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account!.address],
    });
  }

  async function sendSwap(
    venue: Venue,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    minOut: bigint
  ): Promise<Hex> {
    await ensureAllowance(tokenIn, ROUTERS[venue], amountIn);
    const req = swapRequest(venue, tokenIn, tokenOut, amountIn, minOut, account!.address);
    // simulateContract reverts here if minOut cannot be met at current state
    const { request } = await publicClient.simulateContract({
      ...(req as any),
      account: account!,
    });
    const hash = await wallet!.writeContract(request as any);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`Swap reverted: ${hash}`);
    return hash;
  }

  async function execute(op: Opportunity): Promise<void> {
    const label = `${op.buyVenue} -> ${op.sellVenue}`;
    const sizeStr = formatUnits(op.amountInWei, 18);

    if (halted) {
      console.warn(`  [exec] HALTED after earlier failure; skipping ${label}`);
      return;
    }
    if (busy) return;

    const profitable = op.netProfitWei >= cfg.minNetProfitWei;
    if (!profitable && !cfg.allowUnprofitableSmokeTest) return;

    if (mode === 'DRY-RUN') {
      console.log(
        `  [exec][DRY-RUN] Would trade ${sizeStr} wxDAI via ${label}, expected net ${formatUnits(op.netProfitWei, 18)} wxDAI`
      );
      return;
    }

    if (tradesDone >= cfg.maxTradesPerRun) {
      console.log(`  [exec] MAX_TRADES_PER_RUN (${cfg.maxTradesPerRun}) reached; skipping`);
      return;
    }
    if (totalSpent + op.amountInWei > cfg.maxTotalWxdaiPerRun) {
      console.log(`  [exec] MAX_TOTAL_WXDAI_PER_RUN would be exceeded; skipping`);
      return;
    }

    busy = true;
    try {
      const gasPrice = await publicClient.getGasPrice();
      if (gasPrice > cfg.maxGasPriceWei) {
        console.warn(
          `  [exec] Gas price ${formatUnits(gasPrice, 9)} gwei > max ${formatUnits(cfg.maxGasPriceWei, 9)}; skipping`
        );
        return;
      }

      const wxdaiBal = await balanceOf(cfg.wxdai);
      if (wxdaiBal < op.amountInWei) {
        console.warn(
          `  [exec] Insufficient wxDAI: have ${formatUnits(wxdaiBal, 18)}, need ${sizeStr}`
        );
        return;
      }

      const minGno = (op.expectedGnoWei * (10000n - cfg.maxSlippageBps)) / 10000n;
      // Sell leg must at least return the principal (or tolerated slippage in smoke-test mode)
      const minWxdaiBack = profitable
        ? op.amountInWei
        : (op.amountInWei * (10000n - cfg.maxSlippageBps)) / 10000n;

      if (mode === 'SIMULATE-ONLY') {
        const allowance = await publicClient.readContract({
          address: cfg.wxdai,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account!.address, ROUTERS[op.buyVenue]],
        });
        if (allowance < op.amountInWei) {
          console.log(
            `  [exec][SIMULATE-ONLY] ${op.buyVenue} router lacks wxDAI allowance; ` +
              `it would be approved on a live run, so the swap cannot be simulated yet`
          );
          return;
        }
        const req = swapRequest(
          op.buyVenue,
          cfg.wxdai,
          cfg.gno,
          op.amountInWei,
          minGno,
          account!.address
        );
        await publicClient.simulateContract({ ...(req as any), account: account! });
        console.log(
          `  [exec][SIMULATE-ONLY] Buy leg (${sizeStr} wxDAI on ${op.buyVenue}) simulates OK; ` +
            `set ENABLE_MAINNET_TRADING=true to send`
        );
        return;
      }

      console.log(
        `  [exec][LIVE] ${label} | in ${sizeStr} wxDAI | expected net ${formatUnits(op.netProfitWei, 18)}`
      );

      const gnoBefore = await balanceOf(cfg.gno);
      const buyHash = await sendSwap(op.buyVenue, cfg.wxdai, cfg.gno, op.amountInWei, minGno);
      const gnoGot = (await balanceOf(cfg.gno)) - gnoBefore;
      tradesDone++;
      totalSpent += op.amountInWei;
      console.log(
        `  [exec] Leg 1 done: ${buyHash} | received ${formatUnits(gnoGot, 18)} GNO`
      );

      let sold = false;
      for (let attempt = 1; attempt <= SELL_RETRIES && !sold; attempt++) {
        try {
          const sellHash = await sendSwap(
            op.sellVenue,
            cfg.gno,
            cfg.wxdai,
            gnoGot,
            minWxdaiBack
          );
          sold = true;
          console.log(`  [exec] Leg 2 done: ${sellHash}`);
        } catch (err) {
          console.error(
            `  [exec] Leg 2 attempt ${attempt}/${SELL_RETRIES} failed:`,
            (err as Error).message.split('\n')[0]
          );
        }
      }

      if (!sold) {
        halted = true;
        console.error(
          `  [exec] !!! STUCK INVENTORY: holding ${formatUnits(gnoGot, 18)} GNO. ` +
            `Bot halted; sell manually. Entry cost was ${sizeStr} wxDAI.`
        );
      } else {
        const wxdaiAfter = await balanceOf(cfg.wxdai);
        console.log(
          `  [exec] Round trip complete. wxDAI balance: ${formatUnits(wxdaiAfter, 18)} ` +
            `(before: ${formatUnits(wxdaiBal, 18)}, delta ${formatUnits(wxdaiAfter - wxdaiBal, 18)})`
        );
      }
    } catch (err) {
      halted = true;
      console.error('  [exec] Execution failed; bot halted:', (err as Error).message.split('\n')[0]);
    } finally {
      busy = false;
    }
  }

  return { execute, mode, address: account?.address };
}

export type Executor = ReturnType<typeof createExecutor>;
