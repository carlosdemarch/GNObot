import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import solc from 'solc';

const source = 'contracts/AtomicArbitrage.sol';
const input = {
  language: 'Solidity',
  sources: { [source]: { content: readFileSync(source, 'utf8') } },
  settings: {
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).some(error => error.severity === 'error')) process.exit(1);
const contract = output.contracts[source].AtomicArbitrage;
mkdirSync('dist', { recursive: true });
writeFileSync('dist/AtomicArbitrage.json', JSON.stringify({
  compiler: solc.version(),
  abi: contract.abi,
  bytecode: `0x${contract.evm.bytecode.object}`,
  deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
  immutableReferences: Object.values(contract.evm.deployedBytecode.immutableReferences).flat(),
}, null, 2) + '\n');
console.log(`Compiled AtomicArbitrage with ${solc.version()}`);
