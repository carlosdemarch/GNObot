import assert from 'node:assert/strict';
import ganache from 'ganache';
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, keccak256, pad, parseAbi, parseEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { loadArtifact, matchesRuntime } from '../artifact.ts';

const wxdai = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
const gno = '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb';
const honey = '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77';
const sushi = '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506';
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 100, hardfork: 'shanghai' },
  fork: { url: 'https://rpc.gnosischain.com', blockNumber: 49259535 },
});
try {
  const account = privateKeyToAccount(Object.values(provider.getInitialAccounts())[0].secretKey);
  const client = createPublicClient({ chain: gnosis, transport: custom(provider) });
  const wallet = createWalletClient({ chain: gnosis, account, transport: custom(provider) });
  const artifact = loadArtifact();
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, 3n]));
  await provider.request({ method: 'evm_setAccountStorageAt', params: [wxdai, slot, pad(toHex(parseEther('100')))] });
  const erc = parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function approve(address spender,uint256 amount) returns (bool)',
  ]);
  const balance = () => client.readContract({ address: wxdai, abi: erc, functionName: 'balanceOf', args: [account.address] });
  assert.equal(await balance(), parseEther('100'));
  const constructor = parseAbi(['constructor(address,address,address,address)']);
  const deployment = await wallet.deployContract({ abi: constructor, bytecode: artifact.bytecode, args: [wxdai, gno, honey, sushi] });
  const receipt = await client.waitForTransactionReceipt({ hash: deployment });
  assert.equal(receipt.status, 'success');
  const address = receipt.contractAddress;
  assert.ok(matchesRuntime(await client.getCode({ address }), artifact));
  const approval = await wallet.writeContract({ address: wxdai, abi: erc, functionName: 'approve', args: [address, parseEther('50')] });
  assert.equal((await client.waitForTransactionReceipt({ hash: approval })).status, 'success');
  const abi = parseAbi(['function execute(address,address,uint256,uint256,uint256,uint256)']);
  const before = await balance();
  const block = await client.getBlock();
  const gas = 600000n;
  const gasPrice = await client.getGasPrice();
  const request = {
    address, abi, functionName: 'execute',
    args: [honey, sushi, parseEther('50'), parseEther('0.01') + gas * gasPrice, block.timestamp + 3600n, parseEther('1')],
    gas, gasPrice,
  };
  const hash = await wallet.writeContract(request);
  const trade = await client.waitForTransactionReceipt({ hash });
  assert.equal(trade.status, 'success');
  const profit = (await balance()) - before;
  assert.ok(profit - trade.gasUsed * trade.effectiveGasPrice >= parseEther('0.01'));
  const secondApproval = await wallet.writeContract({ address: wxdai, abi: erc, functionName: 'approve', args: [address, parseEther('50')] });
  assert.equal((await client.waitForTransactionReceipt({ hash: secondApproval })).status, 'success');
  const failedHash = await wallet.writeContract(request);
  const failed = await client.waitForTransactionReceipt({ hash: failedHash });
  assert.equal(failed.status, 'reverted');
  assert.equal(await balance(), before + profit);
  console.log(`Fork-only atomic trade succeeded: gas used ${trade.gasUsed}; token profit ${profit} wei. No real transaction was sent.`);
} finally {
  await provider.disconnect();
}
