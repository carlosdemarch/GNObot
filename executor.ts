import {
  createWalletClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { loadArtifact, matchesRuntime } from './artifact.js';

export type Venue = 'honeyswap' | 'sushiswap' | 'uniswapv3';
export interface Opportunity {
  buyVenue: Venue;
  sellVenue: Venue;
  amountInWei: bigint;
  expectedGnoWei: bigint;
  expectedOutWei: bigint;
  netProfitWei: bigint;
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
  minNetProfitWei: bigint;
}

const ROUTERS = {
  honeyswap: '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77',
  sushiswap: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
} as const;
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
]);
const EXECUTOR_ABI = parseAbi([
  'function owner() view returns (address)',
  'function wxdai() view returns (address)',
  'function gno() view returns (address)',
  'function honeyswap() view returns (address)',
  'function sushiswap() view returns (address)',
  'function execute(address buyRouter,address sellRouter,uint256 amountIn,uint256 minimumProfit,uint256 deadline,uint256 maximumGasPrice)',
]);

export function createExecutor(publicClient: PublicClient, cfg: ExecutorConfig) {
  const live = cfg.executeTrades && cfg.enableMainnetTrading;
  const mode = !cfg.executeTrades ? 'DRY-RUN' : live ? 'LIVE' : 'SIMULATE-ONLY';
  const pk = process.env.PRIVATE_KEY?.trim();
  const account = pk ? privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex) : undefined;
  const wallet = account ? createWalletClient({ account, chain: gnosis, transport: http(cfg.rpcUrl) }) : undefined;
  const rawContract = process.env.ATOMIC_EXECUTOR_ADDRESS?.trim();
  if (cfg.executeTrades && !account) throw new Error('PRIVATE_KEY is required for execution');
  if (cfg.executeTrades && (!rawContract || !isAddress(rawContract))) {
    throw new Error('A deployed ATOMIC_EXECUTOR_ADDRESS is required for execution');
  }
  if (cfg.allowUnprofitableSmokeTest && cfg.executeTrades) {
    throw new Error('Unprofitable smoke tests are not supported by the atomic executor');
  }
  if (!Number.isSafeInteger(cfg.maxTradesPerRun) || cfg.maxTradesPerRun < 1 ||
      cfg.maxTotalWxdaiPerRun <= 0n || cfg.maxGasPriceWei <= 0n || cfg.minNetProfitWei <= 0n) {
    throw new Error('Invalid execution limits');
  }
  const address = rawContract && isAddress(rawContract) ? getAddress(rawContract) : undefined;
  const gasLimit = BigInt(process.env.ATOMIC_GAS_LIMIT || '600000');
  if (gasLimit <= 0n) throw new Error('ATOMIC_GAS_LIMIT must be positive');
  let attempts = 0;
  let totalCommitted = 0n;
  let busy = false;
  let halted = false;

  async function execute(op: Opportunity): Promise<void> {
    if (halted || busy || op.netProfitWei < cfg.minNetProfitWei) return;
    if (op.buyVenue === 'uniswapv3' || op.sellVenue === 'uniswapv3') {
      console.warn('[exec] Atomic execution only supports Honeyswap and SushiSwap V2');
      return;
    }
    if (mode === 'DRY-RUN') {
      console.log(`[exec][DRY-RUN] Candidate ${op.buyVenue} -> ${op.sellVenue}, estimated net ${formatUnits(op.netProfitWei, 18)} wxDAI`);
      return;
    }
    if (attempts >= cfg.maxTradesPerRun || totalCommitted + op.amountInWei > cfg.maxTotalWxdaiPerRun) {
      console.log('[exec] Per-run execution limit reached');
      return;
    }
    busy = true;
    try {
      if (!account || !wallet || !address) throw new Error('Executor configuration incomplete');
      if (await publicClient.getChainId() !== gnosis.id) throw new Error('RPC is not Gnosis Chain');
      const contract = { address, abi: EXECUTOR_ABI } as const;
      const [code, owner, wxdai, gno, honey, sushi, balance, allowance, native, gasPrice] = await Promise.all([
        publicClient.getCode({ address }),
        publicClient.readContract({ ...contract, functionName: 'owner' }),
        publicClient.readContract({ ...contract, functionName: 'wxdai' }),
        publicClient.readContract({ ...contract, functionName: 'gno' }),
        publicClient.readContract({ ...contract, functionName: 'honeyswap' }),
        publicClient.readContract({ ...contract, functionName: 'sushiswap' }),
        publicClient.readContract({ address: cfg.wxdai, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }),
        publicClient.readContract({ address: cfg.wxdai, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, address] }),
        publicClient.getBalance({ address: account.address }),
        publicClient.getGasPrice(),
      ]);
      if (!matchesRuntime(code, loadArtifact())) throw new Error('Atomic contract bytecode does not match local compiled artifact');
      if (getAddress(owner) !== account.address || getAddress(wxdai) !== getAddress(cfg.wxdai) ||
          getAddress(gno) !== getAddress(cfg.gno) || getAddress(honey) !== getAddress(ROUTERS.honeyswap) ||
          getAddress(sushi) !== getAddress(ROUTERS.sushiswap)) throw new Error('Atomic contract configuration does not match');
      if (gasPrice <= 0n || gasPrice > cfg.maxGasPriceWei) throw new Error('Gas price outside configured bounds');
      if (balance < op.amountInWei || allowance < op.amountInWei) throw new Error('Insufficient wxDAI balance or contract allowance');
      if (native < gasLimit * gasPrice) throw new Error('Insufficient native xDAI for transaction gas limit');

      const minimumProfit = cfg.minNetProfitWei + gasLimit * gasPrice;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
      const args = [ROUTERS[op.buyVenue], ROUTERS[op.sellVenue], op.amountInWei, minimumProfit, deadline, cfg.maxGasPriceWei] as const;
      const { request } = await publicClient.simulateContract({
        ...contract, functionName: 'execute', args, account, gas: gasLimit, gasPrice,
      });
      if (mode === 'SIMULATE-ONLY') {
        console.log(`[exec][SIMULATE-ONLY] Atomic round trip simulated for ${formatUnits(op.amountInWei, 18)} wxDAI`);
        return;
      }
      attempts++;
      totalCommitted += op.amountInWei;
      const hash = await wallet.writeContract({ ...request, chain: gnosis, account });
      console.log(`[exec][LIVE] Submitted atomic transaction ${hash}`);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
      console.log(`[exec][LIVE] Confirmed ${hash}; gas cost ${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} xDAI`);
    } catch (err) {
      halted = true;
      console.error('[exec] Execution halted; inspect wallet and any submitted transaction before restarting:', err);
    } finally {
      busy = false;
    }
  }
  return { execute, mode, address: account?.address };
}
