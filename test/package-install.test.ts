import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packagePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8'));

test('npm install --omit=dev succeeds without the Husky dev dependency', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-auto-resume-install-'));
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({
        name: packageManifest.name,
        version: packageManifest.version,
        scripts: packageManifest.scripts,
      }),
    );
    const result = spawnSync('npm install --omit=dev --offline --no-package-lock', {
      cwd: directory,
      encoding: 'utf8',
      shell: true,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
