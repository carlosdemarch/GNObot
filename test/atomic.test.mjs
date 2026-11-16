import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import solc from 'solc';
import { createPublicClient, createWalletClient, custom, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import { loadArtifact, matchesRuntime } from '../artifact.ts';

const sources = Object.fromEntries(['contracts/AtomicArbitrage.sol', 'test/Mocks.sol']
  .map(path => [path, { content: readFileSync(path, 'utf8') }]));
const output = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity', sources,
  settings: { evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errors = (output.errors ?? []).filter(e => e.severity === 'error');
assert.deepEqual(errors, [], errors.map(e => e.formattedMessage).join('\n'));

test('atomic round trips, access control, and revert rollback', async () => {
  const provider = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' } });
  try {
    const accounts = Object.values(provider.getInitialAccounts()).map(x => privateKeyToAccount(x.secretKey));
    const chain = defineChain({ id: 1337, name: 'Test', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://localhost'] } } });
    const client = createPublicClient({ chain, transport: custom(provider) });
    const wallet = createWalletClient({ chain, transport: custom(provider), account: accounts[0] });
    const other = createWalletClient({ chain, transport: custom(provider), account: accounts[1] });
    const deploy = async (file, name, args = []) => {
      const artifact = output.contracts[file][name];
      const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, args });
      return { address: (await client.waitForTransactionReceipt({ hash })).contractAddress, abi: artifact.abi };
    };
    const wx = await deploy('test/Mocks.sol', 'MockToken');
    const gno = await deploy('test/Mocks.sol', 'MockToken');
    const honey = await deploy('test/Mocks.sol', 'MockRouter');
    const sushi = await deploy('test/Mocks.sol', 'MockRouter');
    const executor = await deploy('contracts/AtomicArbitrage.sol', 'AtomicArbitrage', [wx.address, gno.address, honey.address, sushi.address]);
    const code = await client.getCode({ address: executor.address });
    const artifact = loadArtifact();
    assert.equal(matchesRuntime(code, artifact), true);
    assert.equal(matchesRuntime(`${code.slice(0, -2)}${code.endsWith('00') ? '01' : '00'}`, artifact), false);
    const write = async (contract, fn, args, w = wallet, extra = {}) => {
      const hash = await w.writeContract({ ...contract, functionName: fn, args, ...extra });
      return client.waitForTransactionReceipt({ hash });
    };
    const balance = (token, address) => client.readContract({ ...token, functionName: 'balanceOf', args: [address] });
    const unit = parseEther('1');
    await write(wx, 'mint', [accounts[0].address, 100n * unit]);
    for (const router of [honey, sushi]) {
      await write(wx, 'mint', [router.address, 1000n * unit]);
      await write(gno, 'mint', [router.address, 1000n * unit]);
    }
    await write(wx, 'approve', [executor.address, 100n * unit]);
    await write(sushi, 'setRate', [11n, 10n]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const args = [honey.address, sushi.address, 10n * unit, unit / 2n, deadline, parseEther('1')];
    let before = await balance(wx, accounts[0].address);
    const receipt = await write(executor, 'execute', args, wallet, { gas: 900000n });
    assert.equal(receipt.status, 'success');
    assert.equal(await balance(wx, accounts[0].address), before + unit);
    assert.equal(await balance(gno, executor.address), 0n);
    assert.equal(await balance(wx, executor.address), 0n);

    await write(honey, 'setRate', [11n, 10n]);
    await write(sushi, 'setRate', [1n, 1n]);
    before = await balance(wx, accounts[0].address);
    assert.equal((await write(executor, 'execute', [sushi.address, honey.address, ...args.slice(2)], wallet, { gas: 900000n })).status, 'success');
    assert.equal(await balance(wx, accounts[0].address), before + unit);

    await write(honey, 'setRate', [1n, 1n]);
    before = await balance(wx, accounts[0].address);
    const honeyBefore = await balance(wx, honey.address);
    const failed = await write(executor, 'execute', args, wallet, { gas: 900000n });
    assert.equal(failed.status, 'reverted');
    assert.equal(await balance(wx, accounts[0].address), before);
    assert.equal(await balance(wx, honey.address), honeyBefore);
    assert.equal(await balance(gno, executor.address), 0n);
    assert.equal((await write(executor, 'execute', args, other, { gas: 900000n })).status, 'reverted');
    assert.equal((await write(executor, 'execute', [honey.address, honey.address, ...args.slice(2)], wallet, { gas: 900000n })).status, 'reverted');
    assert.equal((await write(executor, 'execute', [...args.slice(0, 4), 1n, args[5]], wallet, { gas: 900000n })).status, 'reverted');
    assert.equal((await write(executor, 'execute', [...args.slice(0, 5), 1n], wallet, { gas: 900000n })).status, 'reverted');
  } finally {
    await provider.disconnect();
  }
});
