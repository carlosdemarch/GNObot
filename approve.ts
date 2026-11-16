import 'dotenv/config';
import { createPublicClient, createWalletClient, getAddress, http, isAddress, parseAbi, parseUnits, formatUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { loadArtifact, matchesRuntime } from './artifact.js';

async function main() {
  const amountText = process.argv[2];
  if (!amountText || !/^\d+(\.\d{1,18})?$/.test(amountText) || !process.argv.includes('--confirm-gnosis-approval')) {
    throw new Error('Usage: npm run approve-contract -- <wxDAI amount, or 0 to revoke> --confirm-gnosis-approval');
  }
  const amount = parseUnits(amountText, 18);
  const cap = parseUnits(process.env.MAX_TOTAL_WXDAI_PER_RUN || '200', 18);
  if (amount > cap) throw new Error('Approval exceeds MAX_TOTAL_WXDAI_PER_RUN');
  const pk = process.env.PRIVATE_KEY?.trim();
  const address = process.env.ATOMIC_EXECUTOR_ADDRESS?.trim();
  if (!pk || !address || !isAddress(address)) throw new Error('PRIVATE_KEY and ATOMIC_EXECUTOR_ADDRESS are required');
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex);
  const url = process.env.RPC_URL || 'https://rpc.gnosischain.com';
  const client = createPublicClient({ chain: gnosis, transport: http(url) });
  const wallet = createWalletClient({ chain: gnosis, account, transport: http(url) });
  if (await client.getChainId() !== gnosis.id) throw new Error('RPC is not Gnosis Chain');
  const executorAbi = parseAbi([
    'function owner() view returns (address)', 'function wxdai() view returns (address)',
    'function gno() view returns (address)', 'function honeyswap() view returns (address)',
    'function sushiswap() view returns (address)',
  ]);
  const [code, owner, token, gno, honey, sushi] = await Promise.all([
    client.getCode({ address }),
    ...(['owner', 'wxdai', 'gno', 'honeyswap', 'sushiswap'] as const).map(functionName =>
      client.readContract({ address, abi: executorAbi, functionName })),
  ]);
  if (!matchesRuntime(code, loadArtifact()) || getAddress(owner) !== account.address ||
      getAddress(token) !== getAddress('0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d') ||
      getAddress(gno) !== getAddress('0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb') ||
      getAddress(honey) !== getAddress('0x1C232F01118CB8B424793ae03F870aa7D0ac7f77') ||
      getAddress(sushi) !== getAddress('0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506')) {
    throw new Error('Contract code, owner or addresses do not match');
  }
  const abi = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);
  const gasPrice = await client.getGasPrice();
  if (gasPrice <= 0n || gasPrice > parseUnits(process.env.MAX_GAS_PRICE_GWEI || '2', 9)) {
    throw new Error('Gas price outside configured bounds');
  }
  const request = { address: token, abi, functionName: 'approve', args: [address, amount], account, gasPrice } as const;
  const simulation = await client.simulateContract(request);
  if (!simulation.result) throw new Error('Approval simulation returned false');
  const estimate = await client.estimateContractGas(request);
  const gas = (estimate * 120n + 99n) / 100n;
  console.log(`Approval ${amountText} wxDAI; maximum gas cost ${formatUnits(gas * gasPrice, 18)} xDAI`);
  const hash = await wallet.writeContract({ ...simulation.request, gas });
  console.log(`Approval submitted: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Approval reverted: ${hash}`);
  console.log('Approval confirmed');
}

main().catch(error => {
  console.error('Approval failed:', error);
  process.exitCode = 1;
});
