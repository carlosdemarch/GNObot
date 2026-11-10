import 'dotenv/config';
import {
  createPublicClient,
  http,
  webSocket,
  fallback,
  parseUnits,
  formatUnits,
  parseAbi,
  type Address,
} from 'viem';
import { gnosis } from 'viem/chains';

// ============================================================================
// 1. ENVIRONMENT & CONFIGURATION LOADER
// ============================================================================
function loadConfig() {
  const rpcUrl = process.env.RPC_URL || 'https://rpc.gnosischain.com';
  const wssUrl = process.env.WSS_URL || 'wss://rpc.gnosischain.com/wss';

  const rawSizes = (process.env.TRADE_SIZES_WXDAI || '10,25,50,100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const tradeSizesWxdai = rawSizes.map((s) => ({
    label: s,
    amountWei: parseUnits(s, 18),
  }));

  return {
    rpcUrl,
    wssUrl,
    executeTrades: process.env.EXECUTE_TRADES === 'true',
    enableMainnetTrading: process.env.ENABLE_MAINNET_TRADING === 'true',
    tradeSizesWxdai,
    gasCostWei: parseUnits(process.env.GAS_COST_XDAI || '0.001', 18),
    minNetProfitWei: parseUnits(process.env.MIN_NET_PROFIT_WXDAI || '0.01', 18),
    scanTriggerMode: (process.env.SCAN_TRIGGER_MODE || 'block') as 'block' | 'interval',
    scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS || 5000),
    maxSourceLatencyMs: Number(process.env.MAX_SOURCE_LATENCY_MS || 5000),
    maxRuntimeMinutes: Number(process.env.MAX_RUNTIME_MINUTES || 720),
    wxdai: (process.env.WXDAI_TOKEN_ADDRESS ||
      '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d') as Address,
    gno: (process.env.GNO_TOKEN_ADDRESS ||
      '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb') as Address,
  };
}

const CONFIG = loadConfig();

// Enforce read-only safety guard
if (CONFIG.executeTrades || CONFIG.enableMainnetTrading) {
  console.warn(
    '[WARN] EXECUTE_TRADES / ENABLE_MAINNET_TRADING is true in .env, ' +
      'but this script is strictly a READ-ONLY scanner. No transactions will be signed.'
  );
}

// ============================================================================
// 2. DEX POOL & QUOTER ADDRESSES (GNOSIS MAINNET)
// ============================================================================
const VENUES = {
  HONEYSWAP_V2_PAIR: '0x321704900d52f44180068caa73778d5cd60695a6' as Address,
  SUSHISWAP_V2_PAIR: '0x0f9d54d9ee044220a3925f9b97509811924fd269' as Address,
  UNISWAP_V3_QUOTER_V2: '0x42bE4D6527829FeFA1493e1fb9F3676d2425C3C1' as Address,
  UNISWAP_V3_FEE: 3000, // 0.30% primary GNO/wxDAI tier on Oku/Uniswap V3
} as const;

const V2_PAIR_ABI = parseAbi([
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
]);

const QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

// Determine Uniswap V2 lexicographical token order (0x9c58... GNO < 0xe91d... wxDAI)
const IS_GNO_TOKEN0 = CONFIG.gno.toLowerCase() < CONFIG.wxdai.toLowerCase();

// ============================================================================
// 3. CONSTANT-PRODUCT (UNISWAP V2) EXACT BIGINT MATH (0.30% FEE)
// ============================================================================
function getV2AmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 1000n + amountInWithFee;
  return numerator / denominator;
}

interface PoolReserves {
  gnoReserve: bigint;
  wxdaiReserve: bigint;
}

function parseV2Reserves(raw: readonly [bigint, bigint, number]): PoolReserves {
  return IS_GNO_TOKEN0
    ? { gnoReserve: raw[0], wxdaiReserve: raw[1] }
    : { gnoReserve: raw[1], wxdaiReserve: raw[0] };
}

// ============================================================================
// 4. CORE BLOCK SCANNER
// ============================================================================
const publicClient = createPublicClient({
  chain: gnosis,
  transport: fallback([
    webSocket(CONFIG.wssUrl, { reconnect: true }),
    http(CONFIG.rpcUrl),
  ]),
});

let isScanning = false;

async function scanBlock(blockNumber: bigint, blockTimestampSec?: bigint) {
  if (isScanning) return; // Prevent overlapping scans if RPC lags
  isScanning = true;
  const startMs = Date.now();

  try {
    // Check source latency if block timestamp is available
    if (blockTimestampSec) {
      const blockAgeMs = Date.now() - Number(blockTimestampSec) * 1000;
      if (blockAgeMs > CONFIG.maxSourceLatencyMs) {
        console.warn(
          `[Block ${blockNumber}] Skipped: block age ${blockAgeMs}ms exceeds MAX_SOURCE_LATENCY_MS (${CONFIG.maxSourceLatencyMs}ms)`
        );
        return;
      }
    }

    // --- STEP 1: Multicall V2 Reserves + UniV3 Buy Quotes (wxDAI -> GNO) ---
    const step1Contracts = [
      {
        address: VENUES.HONEYSWAP_V2_PAIR,
        abi: V2_PAIR_ABI,
        functionName: 'getReserves' as const,
      },
      {
        address: VENUES.SUSHISWAP_V2_PAIR,
        abi: V2_PAIR_ABI,
        functionName: 'getReserves' as const,
      },
      ...CONFIG.tradeSizesWxdai.map((size) => ({
        address: VENUES.UNISWAP_V3_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle' as const,
        args: [
          {
            tokenIn: CONFIG.wxdai,
            tokenOut: CONFIG.gno,
            amountIn: size.amountWei,
            fee: VENUES.UNISWAP_V3_FEE,
            sqrtPriceLimitX96: 0n,
          },
        ] as const,
      })),
    ];

    const step1Results = await publicClient.multicall({
      contracts: step1Contracts,
      allowFailure: true,
    });

    if (step1Results[0].status !== 'success' || step1Results[1].status !== 'success') {
      console.error(`[Block ${blockNumber}] Failed to fetch V2 reserves.`);
      return;
    }

    const honeyReserves = parseV2Reserves(step1Results[0].result as readonly [bigint, bigint, number]);
    const sushiReserves = parseV2Reserves(step1Results[1].result as readonly [bigint, bigint, number]);

    // Calculate V2 Buy outputs (wxDAI -> GNO) for each trade size
    const honeyBuyGnoOuts = CONFIG.tradeSizesWxdai.map((s) =>
      getV2AmountOut(s.amountWei, honeyReserves.wxdaiReserve, honeyReserves.gnoReserve)
    );
    const sushiBuyGnoOuts = CONFIG.tradeSizesWxdai.map((s) =>
      getV2AmountOut(s.amountWei, sushiReserves.wxdaiReserve, sushiReserves.gnoReserve)
    );
    const uniV3BuyGnoOuts = CONFIG.tradeSizesWxdai.map((_, idx) => {
      const res = step1Results[2 + idx];
      return res.status === 'success' ? res.result[0] : 0n;
    });

    // --- STEP 2: Multicall UniV3 Sell Quotes (GNO -> wxDAI) for exact V2 GNO outputs ---
    const step2Contracts = [
      ...honeyBuyGnoOuts.map((gnoAmount) => ({
        address: VENUES.UNISWAP_V3_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle' as const,
        args: [
          {
            tokenIn: CONFIG.gno,
            tokenOut: CONFIG.wxdai,
            amountIn: gnoAmount,
            fee: VENUES.UNISWAP_V3_FEE,
            sqrtPriceLimitX96: 0n,
          },
        ] as const,
      })),
      ...sushiBuyGnoOuts.map((gnoAmount) => ({
        address: VENUES.UNISWAP_V3_QUOTER_V2,
        abi: QUOTER_V2_ABI,
        functionName: 'quoteExactInputSingle' as const,
        args: [
          {
            tokenIn: CONFIG.gno,
            tokenOut: CONFIG.wxdai,
            amountIn: gnoAmount,
            fee: VENUES.UNISWAP_V3_FEE,
            sqrtPriceLimitX96: 0n,
          },
        ] as const,
      })),
    ];

    const step2Results = await publicClient.multicall({
      contracts: step2Contracts,
      allowFailure: true,
    });

    const numSizes = CONFIG.tradeSizesWxdai.length;
    const rpcElapsedMs = Date.now() - startMs;

    // Spot mid-prices (wxDAI per 1 GNO) for reference logging
    const honeySpot =
      Number(formatUnits(honeyReserves.wxdaiReserve, 18)) /
      Number(formatUnits(honeyReserves.gnoReserve, 18));
    const sushiSpot =
      Number(formatUnits(sushiReserves.wxdaiReserve, 18)) /
      Number(formatUnits(sushiReserves.gnoReserve, 18));

    console.log(
      `\n=== [Block ${blockNumber}] Scan Time: ${rpcElapsedMs}ms | Spot GNO: Honeyswap $${honeySpot.toFixed(2)} | SushiSwap $${sushiSpot.toFixed(2)} ===`
    );

    // --- STEP 3: Evaluate All 6 Directional Routes Across All 4 Sizes ---
    for (let i = 0; i < numSizes; i++) {
      const size = CONFIG.tradeSizesWxdai[i];
      const inWei = size.amountWei;

      const gnoFromHoney = honeyBuyGnoOuts[i];
      const gnoFromSushi = sushiBuyGnoOuts[i];
      const gnoFromUniV3 = uniV3BuyGnoOuts[i];

      const honeyQuote = step2Results[i];
      const sushiQuote = step2Results[numSizes + i];
      const uniV3OutFromHoneyGno =
        honeyQuote?.status === 'success' ? (honeyQuote.result as readonly bigint[])[0] : 0n;
      const uniV3OutFromSushiGno =
        sushiQuote?.status === 'success' ? (sushiQuote.result as readonly bigint[])[0] : 0n;

      const candidates = [
        {
          route: 'Honeyswap -> SushiSwap',
          outWei: getV2AmountOut(
            gnoFromHoney,
            sushiReserves.gnoReserve,
            sushiReserves.wxdaiReserve
          ),
        },
        {
          route: 'SushiSwap -> Honeyswap',
          outWei: getV2AmountOut(
            gnoFromSushi,
            honeyReserves.gnoReserve,
            honeyReserves.wxdaiReserve
          ),
        },
        {
          route: 'Honeyswap -> UniswapV3',
          outWei: uniV3OutFromHoneyGno,
        },
        {
          route: 'SushiSwap -> UniswapV3',
          outWei: uniV3OutFromSushiGno,
        },
        {
          route: 'UniswapV3 -> Honeyswap',
          outWei: getV2AmountOut(
            gnoFromUniV3,
            honeyReserves.gnoReserve,
            honeyReserves.wxdaiReserve
          ),
        },
        {
          route: 'UniswapV3 -> SushiSwap',
          outWei: getV2AmountOut(
            gnoFromUniV3,
            sushiReserves.gnoReserve,
            sushiReserves.wxdaiReserve
          ),
        },
      ].filter((c) => c.outWei > 0n);

      // Pick the best route for this trade size
      candidates.sort((a, b) => (b.outWei > a.outWei ? 1 : -1));
      const best = candidates[0];
      if (!best) continue;

      const grossProfitWei = best.outWei - inWei;
      const netProfitWei = grossProfitWei - CONFIG.gasCostWei;
      const spreadBps = Number((grossProfitWei * 10000n) / inWei);
      const isProfitable = netProfitWei >= CONFIG.minNetProfitWei;

      const statusTag = isProfitable ? '✅ PROFITABLE' : '❌ NO ARB';
      console.log(
        `  [${size.label.padStart(3, ' ')} wxDAI] Best: ${best.route.padEnd(22, ' ')} | ` +
          `Out: ${Number(formatUnits(best.outWei, 18)).toFixed(4)} wxDAI | ` +
          `Spread: ${(spreadBps / 100).toFixed(2)}% | ` +
          `Net: ${Number(formatUnits(netProfitWei, 18)).toFixed(4)} wxDAI | ${statusTag}`
      );
    }
  } catch (err) {
    console.error(`[Block ${blockNumber}] Scanner error:`, err);
  } finally {
    isScanning = false;
  }
}

// ============================================================================
// 5. ENTRYPOINT & LIFECYCLE MANAGEMENT
// ============================================================================
async function main() {
  console.log('Starting Gnosis Chain GNO/wxDAI Read-Only Arbitrage Scanner...');
  console.log(
    `Trigger Mode: ${CONFIG.scanTriggerMode} | Sizes: ${CONFIG.tradeSizesWxdai.map((s) => s.label).join(', ')} wxDAI | ` +
      `Gas Est: ${formatUnits(CONFIG.gasCostWei, 18)} xDAI | Min Net Profit: ${formatUnits(CONFIG.minNetProfitWei, 18)} wxDAI`
  );

  // Enforce MAX_RUNTIME_MINUTES shutdown timer
  const maxRuntimeMs = CONFIG.maxRuntimeMinutes * 60 * 1000;
  setTimeout(() => {
    console.log(`\nReached MAX_RUNTIME_MINUTES (${CONFIG.maxRuntimeMinutes} min). Exiting cleanly.`);
    process.exit(0);
  }, maxRuntimeMs);

  if (CONFIG.scanTriggerMode === 'block') {
    publicClient.watchBlocks({
      onBlock: (block) => {
        if (block.number !== null) {
          scanBlock(block.number, block.timestamp);
        }
      },
      onError: (err) => console.error('[WSS Block Watcher Error]:', err.message),
    });
  } else {
    setInterval(async () => {
      const block = await publicClient.getBlock();
      await scanBlock(block.number, block.timestamp);
    }, CONFIG.scanIntervalMs);
  }
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
