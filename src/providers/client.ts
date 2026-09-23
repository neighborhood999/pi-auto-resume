export type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type FetchInitLike = {
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
};

export type FetchLike = (url: string, init?: FetchInitLike) => Promise<FetchResponseLike>;

export type FetchDeps = {
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  now?: number | undefined;
};

export function defaultFetch(): FetchLike {
  return fetch as unknown as FetchLike;
}

export function pick(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

export function num(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function errText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(b64, 'base64').toString('utf8');
    const obj: unknown = JSON.parse(json);
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseEpochOrIso(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    const milliseconds = parsed < 1e12 ? parsed * 1000 : parsed;
    return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
