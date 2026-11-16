import 'dotenv/config';
import { createPublicClient, createWalletClient, encodeDeployData, http, parseAbi, parseUnits, formatUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { loadArtifact, matchesRuntime } from './artifact.js';

async function main() {
  if (!process.argv.includes('--confirm-gnosis-deployment')) {
    throw new Error('Deployment costs real xDAI. Pass --confirm-gnosis-deployment to proceed.');
  }
  const pk = process.env.PRIVATE_KEY?.trim();
  if (!pk) throw new Error('PRIVATE_KEY is required');
  const account = privateKeyToAccount((pk.startsWith('0x') ? pk : `0x${pk}`) as Hex);
  const url = process.env.RPC_URL || 'https://rpc.gnosischain.com';
  const client = createPublicClient({ chain: gnosis, transport: http(url) });
  const wallet = createWalletClient({ chain: gnosis, account, transport: http(url) });
  if (await client.getChainId() !== gnosis.id) throw new Error('RPC is not Gnosis Chain');
  const artifact = loadArtifact();
  const abi = parseAbi(['constructor(address wxdai, address gno, address honeyswap, address sushiswap)']);
  const args = [
    '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
    '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77',
    '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  ] as const;
  const gasPrice = await client.getGasPrice();
  const maxGasPrice = parseUnits(process.env.MAX_GAS_PRICE_GWEI || '2', 9);
  if (gasPrice <= 0n || gasPrice > maxGasPrice) throw new Error('Gas price outside configured bounds');
  const gas = await client.estimateGas({ data: encodeDeployData({ abi, bytecode: artifact.bytecode, args }), account });
  const gasLimit = (gas * 120n + 99n) / 100n;
  console.log(`Maximum deployment gas cost: ${formatUnits(gasLimit * gasPrice, 18)} xDAI`);
  const hash = await wallet.deployContract({ abi, bytecode: artifact.bytecode, args, gas: gasLimit, gasPrice });
  console.log(`Deployment submitted: ${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment failed');
  if (!matchesRuntime(await client.getCode({ address: receipt.contractAddress }), artifact)) {
    throw new Error(`Deployed code mismatch at ${receipt.contractAddress}`);
  }
  console.log(`Deployed and verified runtime. Set ATOMIC_EXECUTOR_ADDRESS=${receipt.contractAddress}`);
}

main().catch(error => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});
