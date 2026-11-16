import { readFileSync } from 'node:fs';
import { isHex, type Hex } from 'viem';

type ImmutableReference = { start: number; length: number };
type Artifact = { bytecode: Hex; deployedBytecode: Hex; immutableReferences: ImmutableReference[] };

export function loadArtifact(): Artifact {
  const parsed: unknown = JSON.parse(readFileSync('dist/AtomicArbitrage.json', 'utf8'));
  if (typeof parsed !== 'object' || parsed === null ||
      !('bytecode' in parsed) || typeof parsed.bytecode !== 'string' || !isHex(parsed.bytecode) ||
      !('deployedBytecode' in parsed) || typeof parsed.deployedBytecode !== 'string' || !isHex(parsed.deployedBytecode) ||
      !('immutableReferences' in parsed) || !Array.isArray(parsed.immutableReferences)) {
    throw new Error('Invalid contract artifact; run npm run compile-contract');
  }
  const references: ImmutableReference[] = [];
  for (const ref of parsed.immutableReferences) {
    if (typeof ref !== 'object' || ref === null || !('start' in ref) || !('length' in ref) ||
        typeof ref.start !== 'number' || typeof ref.length !== 'number' ||
        !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.length) ||
        ref.start < 0 || ref.length <= 0 || (ref.start + ref.length) * 2 > parsed.deployedBytecode.length - 2) {
      throw new Error('Invalid immutable reference in contract artifact');
    }
    references.push({ start: ref.start, length: ref.length });
  }
  return { bytecode: parsed.bytecode, deployedBytecode: parsed.deployedBytecode, immutableReferences: references };
}

export function matchesRuntime(code: Hex | undefined, artifact: Artifact): boolean {
  if (!code || code.length !== artifact.deployedBytecode.length) return false;
  let actual = code.slice(2).toLowerCase();
  let expected = artifact.deployedBytecode.slice(2).toLowerCase();
  for (const { start, length } of artifact.immutableReferences) {
    const from = start * 2;
    const to = from + length * 2;
    actual = actual.slice(0, from) + '0'.repeat(length * 2) + actual.slice(to);
    expected = expected.slice(0, from) + '0'.repeat(length * 2) + expected.slice(to);
  }
  return actual === expected;
}
