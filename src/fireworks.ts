const FIREWORKS_CHAT_COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const FIREWORKS_REFRESH_URL = "https://app.fireworks.ai/api/v2/auth/refresh";
const FIREWORKS_PLAYGROUND_BASE_URL = "https://app.fireworks.ai/playground";
const FIREWORKS_DEFAULT_MODEL = "accounts/fireworks/models/glm-5p1";
const FIREWORKS_INTERNAL_KEY_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

export const FIREWORKS_MODEL_PREFIX = "accounts/fireworks/models/";

export interface FireworksEnv {
  FIREWORKS_INTERNAL_API_KEY?: string;
  FIREWORKS_SESSION_JSON?: string;
}

interface FireworksUserContext {
  email: string | null;
  sub: string | null;
  accountID: string | null;
  hasAccount: boolean;
  accountState: number;
  impersonating: string | null;
  realEmail: string | null;
}

interface FireworksSession {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  refreshAt?: number;
  email?: string | null;
  sub?: string | null;
  accountID?: string | null;
  hasAccount?: boolean;
  accountState?: number;
  impersonating?: string | null;
  realEmail?: string | null;
  timezone?: string;
  userContext?: FireworksUserContext | string;
}

function getWorkerCache(): Cache {
  return (caches as any).default;
}

function buildPlaygroundURL(model: string): string {
  const url = new URL(FIREWORKS_PLAYGROUND_BASE_URL);
  url.searchParams.set("category", "llm");
  url.searchParams.set("model", model || FIREWORKS_DEFAULT_MODEL);
  return url.toString();
}

function buildCacheKey(session: FireworksSession): Request {
  const identity = encodeURIComponent(session.accountID || session.sub || session.email || "default");
  return new Request(`https://internal-cache/fireworks/${identity}`);
}

async function getCachedInternalKey(session: FireworksSession): Promise<string | null> {
  const response = await getWorkerCache().match(buildCacheKey(session));
  if (!response) return null;
  try {
    const data = await response.json() as { apiKey?: string; expiresAt?: number };
    if (data.apiKey && typeof data.expiresAt === "number" && data.expiresAt > Date.now()) {
      return data.apiKey;
    }
  } catch {}
  return null;
}

async function setCachedInternalKey(session: FireworksSession, apiKey: string): Promise<void> {
  const expiresAt = Date.now() + FIREWORKS_INTERNAL_KEY_CACHE_TTL_MS;
  await getWorkerCache().put(
    buildCacheKey(session),
    new Response(JSON.stringify({ apiKey, expiresAt }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function extractString(value: any, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const current = value?.[key];
    if (typeof current === "string" && current) return current;
  }
  return undefined;
}

function extractBoolean(value: any, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const current = value?.[key];
    if (typeof current === "boolean") return current;
  }
  return undefined;
}

function extractNumber(value: any, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const current = value?.[key];
    if (typeof current === "number" && Number.isFinite(current)) return current;
  }
  return undefined;
}

function normalizeUserContext(session: FireworksSession): FireworksUserContext {
  let providedContext: any = session.userContext;
  if (typeof providedContext === "string") {
    try {
      providedContext = JSON.parse(providedContext);
    } catch {
      providedContext = {};
    }
  }
  if (!providedContext || typeof providedContext !== "object") providedContext = {};

  const email = extractString(providedContext, "email") ?? session.email ?? null;
  const sub = extractString(providedContext, "sub") ?? session.sub ?? null;
  const accountID = extractString(providedContext, "accountID") ?? session.accountID ?? null;

  return {
    email,
    sub,
    accountID,
    hasAccount: extractBoolean(providedContext, "hasAccount") ?? session.hasAccount ?? true,
    accountState: extractNumber(providedContext, "accountState") ?? session.accountState ?? 2,
    impersonating: extractString(providedContext, "impersonating") ?? session.impersonating ?? null,
    realEmail: extractString(providedContext, "realEmail") ?? session.realEmail ?? null,
  };
}

function normalizeSession(input: any): FireworksSession {
  const sessionSource = input?.session && typeof input.session === "object" ? input.session : input;
  const userContext = input?.userContext ?? input?.auth_v2_user_context ?? sessionSource?.userContext;

  const session: FireworksSession = {
    accessToken: extractString(sessionSource, "accessToken", "auth_v2_access_token") || "",
    refreshToken: extractString(sessionSource, "refreshToken", "auth_v2_refresh_token") || "",
    idToken: extractString(sessionSource, "idToken", "auth_v2_id_token") || "",
    refreshAt: extractNumber(sessionSource, "refreshAt"),
    email: extractString(sessionSource, "email"),
    sub: extractString(sessionSource, "sub"),
    accountID: extractString(sessionSource, "accountID"),
    hasAccount: extractBoolean(sessionSource, "hasAccount"),
    accountState: extractNumber(sessionSource, "accountState"),
    impersonating: extractString(sessionSource, "impersonating") ?? null,
    realEmail: extractString(sessionSource, "realEmail") ?? null,
    timezone: extractString(input, "timezone") || DEFAULT_TIMEZONE,
    userContext,
  };

  if (!session.accessToken || !session.refreshToken || !session.idToken) {
    throw new Error("FIREWORKS_SESSION_JSON 缺少 accessToken / refreshToken / idToken");
  }
  return session;
}

function buildCookieHeader(session: FireworksSession): string {
  const userContext = normalizeUserContext(session);
  if (!userContext.email || !userContext.sub || !userContext.accountID) {
    throw new Error("Fireworks session 缺少 email / sub / accountID，无法构造 auth_v2_user_context");
  }
  const timezone = session.timezone || DEFAULT_TIMEZONE;
  return [
    `auth_v2_access_token=${session.accessToken}`,
    `auth_v2_refresh_token=${session.refreshToken}`,
    `auth_v2_id_token=${session.idToken}`,
    `auth_v2_user_context=${encodeURIComponent(JSON.stringify(userContext))}`,
    `timezone=${encodeURIComponent(timezone)}`,
  ].join("; ");
}

async function refreshSession(session: FireworksSession): Promise<FireworksSession> {
  const response = await fetch(FIREWORKS_REFRESH_URL, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Cookie": buildCookieHeader(session),
      "Origin": "https://app.fireworks.ai",
      "Referer": buildPlaygroundURL(FIREWORKS_DEFAULT_MODEL),
      "User-Agent": DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Fireworks session refresh failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const data = await response.json().catch(() => null) as { session?: any } | null;
  if (!data?.session) {
    throw new Error("Fireworks session refresh failed: response.session is null");
  }

  return {
    ...normalizeSession(data),
    timezone: session.timezone || DEFAULT_TIMEZONE,
    userContext: normalizeUserContext(session),
  };
}

function extractInternalApiKey(html: string): string | null {
  const escaped = html.match(/apiKey\\":\\"([^\\"]+)/);
  if (escaped?.[1]) return escaped[1];

  const plain = html.match(/apiKey":"([^"]+)/);
  if (plain?.[1]) return plain[1];

  return null;
}

async function fetchInternalApiKey(session: FireworksSession, model: string): Promise<string> {
  const response = await fetch(buildPlaygroundURL(model), {
    method: "GET",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": buildCookieHeader(session),
      "Origin": "https://app.fireworks.ai",
      "Referer": buildPlaygroundURL(model),
      "User-Agent": DEFAULT_USER_AGENT,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Fetch Fireworks playground failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }

  const html = await response.text();
  const apiKey = extractInternalApiKey(html);
  if (!apiKey) {
    throw new Error("未能从 Fireworks playground HTML 中提取 internal api key");
  }
  return apiKey;
}

async function resolveInternalApiKey(env: FireworksEnv, model: string): Promise<string> {
  if (env.FIREWORKS_INTERNAL_API_KEY) return env.FIREWORKS_INTERNAL_API_KEY;
  if (!env.FIREWORKS_SESSION_JSON) {
    throw new Error("缺少 FIREWORKS_INTERNAL_API_KEY 或 FIREWORKS_SESSION_JSON");
  }

  const configuredSession = normalizeSession(JSON.parse(env.FIREWORKS_SESSION_JSON));
  const cachedApiKey = await getCachedInternalKey(configuredSession);
  if (cachedApiKey) return cachedApiKey;

  const freshSession = await refreshSession(configuredSession);
  const apiKey = await fetchInternalApiKey(freshSession, model);
  await setCachedInternalKey(freshSession, apiKey);
  return apiKey;
}

export function hasFireworksConfig(env: FireworksEnv): boolean {
  return !!(env.FIREWORKS_INTERNAL_API_KEY || env.FIREWORKS_SESSION_JSON);
}

export function isFireworksModel(model: string | undefined): boolean {
  return typeof model === "string" && model.startsWith(FIREWORKS_MODEL_PREFIX);
}

export async function createFireworksCompletionResponse(body: any, env: FireworksEnv): Promise<Response> {
  const model = typeof body?.model === "string" && body.model ? body.model : FIREWORKS_DEFAULT_MODEL;
  const internalApiKey = await resolveInternalApiKey(env, model);

  const response = await fetch(FIREWORKS_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Accept": body?.stream ? "text/event-stream" : "application/json",
      "Authorization": `Bearer ${internalApiKey}`,
      "Content-Type": "application/json",
      "Fireworks-Playground": "true",
      "Origin": "https://fireworks.ai",
      "Referer": buildPlaygroundURL(model),
      "User-Agent": DEFAULT_USER_AGENT,
    },
    body: JSON.stringify({
      ...body,
      model,
    }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`Fireworks upstream error: HTTP ${response.status} ${text.slice(0, 500)}`);
  }
  return response;
}
