import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { DEFAULT_CONFIG, type AutoResumeConfig } from './schedule.ts';

/** Result of loading auto-resume preferences. */
export type LoadConfigResult =
  | { readonly ok: true; readonly config: AutoResumeConfig }
  | { readonly ok: false; readonly error: string };

/** Result of persisting auto-resume preferences. */
export type SaveConfigResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

const CONFIG_PATH = join(getAgentDir(), 'auto-resume.json');

/** Load auto-resume preferences from disk, falling back to defaults for missing or partial fields. */
export async function loadAutoResumeConfig(): Promise<LoadConfigResult> {
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (cause: unknown) {
    if (typeof cause === 'object' && cause !== null && Reflect.get(cause, 'code') === 'ENOENT') {
      return { ok: true, config: DEFAULT_CONFIG };
    }
    return { ok: false, error: 'Could not read auto-resume configuration.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Auto-resume configuration is invalid JSON.' };
  }

  return parseConfig(parsed);
}

/** Parse an unknown JSON value into auto-resume preferences, using defaults for invalid fields. */
export function parseConfig(input: unknown): LoadConfigResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'Auto-resume configuration must be an object.' };
  }

  const enabled = Reflect.get(input, 'enabled');
  const bufferMs = Reflect.get(input, 'bufferMs');
  const pollIntervalMs = Reflect.get(input, 'pollIntervalMs');
  const maxAttempts = Reflect.get(input, 'maxAttempts');
  const resumePrompt = Reflect.get(input, 'resumePrompt');

  return {
    ok: true,
    config: {
      enabled: typeof enabled === 'boolean' ? enabled : DEFAULT_CONFIG.enabled,
      bufferMs:
        typeof bufferMs === 'number' && Number.isFinite(bufferMs) && bufferMs > 0
          ? bufferMs
          : DEFAULT_CONFIG.bufferMs,
      pollIntervalMs:
        typeof pollIntervalMs === 'number' && Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
          ? pollIntervalMs
          : DEFAULT_CONFIG.pollIntervalMs,
      maxAttempts:
        typeof maxAttempts === 'number' && Number.isSafeInteger(maxAttempts) && maxAttempts > 0
          ? maxAttempts
          : DEFAULT_CONFIG.maxAttempts,
      resumePrompt: typeof resumePrompt === 'string' ? resumePrompt : undefined,
    },
  };
}

/** Persist auto-resume preferences atomically. Only writes fields that differ from defaults. */
export async function saveAutoResumeConfig(config: AutoResumeConfig): Promise<SaveConfigResult> {
  const temporaryPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  const stored: Record<string, unknown> = {};
  if (!config.enabled) {
    stored['enabled'] = false;
  }
  if (config.bufferMs !== DEFAULT_CONFIG.bufferMs) {
    stored['bufferMs'] = config.bufferMs;
  }
  if (config.pollIntervalMs !== DEFAULT_CONFIG.pollIntervalMs) {
    stored['pollIntervalMs'] = config.pollIntervalMs;
  }
  if (config.maxAttempts !== DEFAULT_CONFIG.maxAttempts) {
    stored['maxAttempts'] = config.maxAttempts;
  }
  if (config.resumePrompt !== undefined) {
    stored['resumePrompt'] = config.resumePrompt;
  }

  try {
    await writeFile(temporaryPath, `${JSON.stringify(stored, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, CONFIG_PATH);
    return { ok: true };
  } catch {
    return { ok: false, error: 'Could not save auto-resume configuration.' };
  }
}
