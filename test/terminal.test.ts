import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalBell } from '../src/terminal.ts';

test('terminal bell writes through an injected adapter', () => {
  const output: string[] = [];
  const bell = createTerminalBell((text) => output.push(text));
  bell();
  assert.deepEqual(output, ['\u0007']);
});
