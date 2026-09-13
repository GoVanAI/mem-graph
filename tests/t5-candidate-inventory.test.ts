import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyInventory } from '../scripts/verify-t5-candidate-inventory.mjs';

const roots: string[] = [];
const makeRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 't5-inventory-'));
  roots.push(root);
  return root;
};
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const write = (root: string, path: string, text: string) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
};
const inventory = (root: string, artifacts: unknown[]) => {
  write(root, 'inventory.json', JSON.stringify({ schema_version: '1.0.0', status: 'candidate_inventory_not_frozen', artifacts }));
  return { root, inventory: 'inventory.json' };
};

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('verify-t5-candidate-inventory', () => {
  it('reports matching bytes as integrity only, never a freeze or trust result', () => {
    const root = makeRoot();
    write(root, 'fixture.txt', 'fixture');
    const result = verifyInventory(inventory(root, [{ path: 'fixture.txt', sha256: sha256('fixture') }]));
    expect(result).toMatchObject({ status: 'integrity_match', integrity_only: true, trust_or_freeze_claim: false, checked_count: 1, errors: [] });
  });

  it('reports stale, missing, unsafe, duplicate, and symlink-escape entries', () => {
    const root = makeRoot();
    write(root, 'changed.txt', 'actual');
    write(root, 'linked-target/target.txt', 'target');
    symlinkSync(join(root, 'linked-target'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = verifyInventory(inventory(root, [
      { path: 'changed.txt', sha256: sha256('expected') },
      { path: 'missing.txt', sha256: sha256('missing') },
      { path: '../outside.txt', sha256: sha256('outside') },
      { path: 'changed.txt', sha256: sha256('actual') },
      { path: 'linked/target.txt', sha256: sha256('target') },
      { path: 'C:drive-relative.txt', sha256: sha256('drive') },
      { path: 'nul\0path.txt', sha256: sha256('nul') },
    ]));
    expect(result.status).toBe('stale_or_invalid');
    expect(result.errors.map((error: { code: string }) => error.code)).toEqual(expect.arrayContaining(['sha256_mismatch', 'missing_or_unreadable', 'unsafe_path', 'duplicate_path', 'path_escape']));
  });

  it('returns diagnostics for a missing inventory and an inventory symlink', () => {
    const root = makeRoot();
    expect(verifyInventory({ root, inventory: 'missing.json' }).errors).toEqual([{ code: 'inventory_unreadable_or_invalid_json' }]);
    write(root, 'null.json', 'null');
    expect(verifyInventory({ root, inventory: 'null.json' }).errors).toEqual([{ code: 'inventory_shape_invalid' }]);
    write(root, 'real/inventory.json', JSON.stringify({ schema_version: '1.0.0', status: 'candidate_inventory_not_frozen', artifacts: [] }));
    symlinkSync(join(root, 'real'), join(root, 'inventory-link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(verifyInventory({ root, inventory: 'inventory-link/inventory.json' }).errors).toEqual([{ code: 'inventory_path_escape' }]);
  });
});
