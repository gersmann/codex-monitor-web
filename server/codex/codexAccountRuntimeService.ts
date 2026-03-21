import fs from "node:fs/promises";
import path from "node:path";
import { trimString, toNullableString } from "./codexCoreUtils.js";
import type { JsonRecord, RpcErrorShape } from "../types.js";
import type { CodexAppServerClient } from "../vendor/codexSdk.js";

type AccountFallback = {
  email: string | null;
  planType: string | null;
};

type LoginState = {
  canceled: boolean;
  loginId: string | null;
  pending: Promise<JsonRecord> | null;
};

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function readJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(decodeBase64Url(parts[1]!)) as JsonRecord;
  } catch {
    return null;
  }
}

function cloneAccountRecord(response: JsonRecord | null) {
  const account =
    response?.account && typeof response.account === "object" && !Array.isArray(response.account)
      ? (response.account as JsonRecord)
      : response;
  return account ? { ...account } : {};
}

function shouldApplyAccountFallback(account: JsonRecord) {
  const accountType = trimString(account.type).toLowerCase();
  return (
    Object.keys(account).length === 0 ||
    !accountType ||
    accountType === "chatgpt" ||
    accountType === "unknown"
  );
}

function applyAccountFallback(account: JsonRecord, fallback: AccountFallback) {
  if (!toNullableString(account.email) && fallback.email) {
    account.email = fallback.email;
  }
  if (!toNullableString(account.planType) && fallback.planType) {
    account.planType = fallback.planType;
  }
  if (!trimString(account.type) && (fallback.email || fallback.planType)) {
    account.type = "chatgpt";
  }
}

function buildAccountResponse(response: JsonRecord | null, fallback: AccountFallback | null) {
  const account = cloneAccountRecord(response);
  if (fallback && shouldApplyAccountFallback(account)) {
    applyAccountFallback(account, fallback);
  }
  const accountResponse: { account: JsonRecord | null; requiresOpenaiAuth?: boolean } = {
    account: Object.keys(account).length > 0 ? account : null,
  };
  if (typeof response?.requiresOpenaiAuth === "boolean") {
    accountResponse.requiresOpenaiAuth = response.requiresOpenaiAuth;
  }
  return accountResponse;
}

type BuildClient = (settings: JsonRecord, workspaceId?: string | null) => CodexAppServerClient;

export type AccountRuntimeContext = {
  settingsPath: string;
  getWorkspace: (workspaceId: string) => unknown | null;
  readSettings: () => Promise<JsonRecord>;
  buildAppServerClient: BuildClient;
  readAuthAccountFallback: () => Promise<AccountFallback | null>;
  loginStateByWorkspace: Map<string, LoginState>;
  notFound: (message: string) => RpcErrorShape;
};

export class AccountRuntimeService {
  constructor(private readonly context: AccountRuntimeContext) {}

  resolveCodexHomePath() {
    return path.dirname(this.context.settingsPath);
  }

  async readAuthAccountFallbackFromDisk(): Promise<AccountFallback | null> {
    const authPath = path.join(this.resolveCodexHomePath(), "auth.json");
    try {
      const raw = JSON.parse(await fs.readFile(authPath, "utf8")) as JsonRecord;
      const tokens =
        raw.tokens && typeof raw.tokens === "object" ? (raw.tokens as JsonRecord) : null;
      const idToken = trimString(tokens?.idToken) || trimString(tokens?.id_token);
      if (!idToken) {
        return null;
      }
      const payload = readJwtPayload(idToken);
      if (!payload) {
        return null;
      }
      const auth =
        payload[OPENAI_AUTH_CLAIM] &&
        typeof payload[OPENAI_AUTH_CLAIM] === "object"
          ? (payload[OPENAI_AUTH_CLAIM] as JsonRecord)
          : null;
      const profile =
        payload[OPENAI_PROFILE_CLAIM] &&
        typeof payload[OPENAI_PROFILE_CLAIM] === "object"
          ? (payload[OPENAI_PROFILE_CLAIM] as JsonRecord)
          : null;
      const email =
        toNullableString(payload.email) ?? toNullableString(profile?.email) ?? null;
      const planType =
        toNullableString(auth?.chatgpt_plan_type) ??
        toNullableString(payload.chatgpt_plan_type) ??
        null;
      if (!email && !planType) {
        return null;
      }
      return { email, planType };
    } catch {
      return null;
    }
  }

  async readAccountInfo(workspaceId: string) {
    const settings = await this.context.readSettings();
    const client = this.context.buildAppServerClient(settings, workspaceId);
    let response: JsonRecord | null = null;
    try {
      response = await client.accountRead();
    } catch {
      response = null;
    }
    return buildAccountResponse(response, await this.context.readAuthAccountFallback());
  }

  private getOrCreateLoginState(workspaceId: string) {
    const existing = this.context.loginStateByWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }
    const created: LoginState = { canceled: false, loginId: null, pending: null };
    this.context.loginStateByWorkspace.set(workspaceId, created);
    return created;
  }

  async startCodexLogin(workspaceId: string) {
    const state = this.getOrCreateLoginState(workspaceId);
    state.canceled = false;
    const settings = await this.context.readSettings();
    const client = this.context.buildAppServerClient(settings, workspaceId);
    const pending = client.startLogin("chatgpt");
    state.pending = pending;
    try {
      const response = await pending;
      const loginId =
        toNullableString(response.loginId) ?? toNullableString(response.login_id) ?? null;
      state.loginId = loginId;
      return {
        loginId,
        authUrl:
          toNullableString(response.authUrl) ?? toNullableString(response.auth_url) ?? null,
        raw: response,
      };
    } finally {
      state.pending = null;
    }
  }

  async cancelCodexLogin(workspaceId: string) {
    const state = this.getOrCreateLoginState(workspaceId);
    if (state.pending) {
      state.canceled = true;
      state.loginId = null;
      return { canceled: true, status: "canceled" };
    }
    if (!state.loginId) {
      return { canceled: false };
    }
    const settings = await this.context.readSettings();
    const client = this.context.buildAppServerClient(settings, workspaceId);
    const response = await client.cancelLogin(state.loginId);
    const canceled = Boolean(response.canceled ?? response.cancelled ?? response.ok ?? true);
    const status = toNullableString(response.status) ?? (canceled ? "canceled" : "unknown");
    state.loginId = null;
    return { canceled, status, raw: response };
  }

  async handleRpc(method: string, params: JsonRecord): Promise<unknown | RpcErrorShape | undefined> {
    switch (method) {
      case "account_read":
        return await this.readAccountInfo(String(params.workspaceId ?? ""));
      case "codex_login": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.context.getWorkspace(workspaceId)) {
          return this.context.notFound("Workspace not found.");
        }
        return await this.startCodexLogin(workspaceId);
      }
      case "codex_login_cancel": {
        const workspaceId = String(params.workspaceId ?? "");
        if (!this.context.getWorkspace(workspaceId)) {
          return this.context.notFound("Workspace not found.");
        }
        return await this.cancelCodexLogin(workspaceId);
      }
      default:
        return undefined;
    }
  }
}
