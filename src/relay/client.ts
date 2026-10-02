import { Platform, requestUrl, type RequestUrlResponse } from "obsidian";
import { explainRelayNetworkError, relayUrlProblem } from "../relay-url";
import type {
  ApproveDeviceRequest,
  GuestFinishRequest,
  MerkleResponse,
  OpsPullResponse,
  OpsPushRequest,
  PairClaimRequest,
  PairFinishRequest,
  PairFinishResponse,
  PairInboxResponse,
  PairPostRequest,
  PairStartRequest,
  PairStartResponse,
  VaultEnrollRequest,
  VaultListItem,
  DeviceRecord,
} from "../protocol";

/** GET /v1/flock — devices + vault list (sealed meta only). */
export interface FlockInfo {
  devices: DeviceRecord[];
  vaults: VaultListItem[];
}

/** Error thrown for 4xx/5xx relay responses; carries the server error + code. */
export class RelayError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
  }
}

function stripTrailingSlash(url: string): string {
  return (url ?? "").trim().replace(/\/+$/, "");
}

/**
 * Relay HTTP client. Uses Obsidian's requestUrl ONLY (works on mobile WebView,
 * no fetch/CORS issues). All endpoints from protocol/HTTP.md v1.
 */
export class RelayHttp {
  private base: string;
  private deviceId: string | null = null;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.base = stripTrailingSlash(baseUrl);
  }

  setBase(url: string): void {
    this.base = stripTrailingSlash(url);
  }

  setAuth(deviceId: string, token: string): void {
    this.deviceId = deviceId;
    this.token = token;
  }

  // ---------------------------------------------------------------- internals

  private authHeaders(): Record<string, string> {
    if (this.deviceId && this.token) {
      return { Authorization: `Device ${this.deviceId} ${this.token}` };
    }
    return {};
  }

  private async send(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<RequestUrlResponse> {
    const headers: Record<string, string> = { ...this.authHeaders(), ...(extraHeaders ?? {}) };
    let wireBody: string | ArrayBuffer | undefined;
    if (body !== undefined) {
      if (body instanceof ArrayBuffer) {
        wireBody = body;
      } else {
        wireBody = JSON.stringify(body);
        if (headers["Content-Type"] === undefined) headers["Content-Type"] = "application/json";
      }
    }
    const blocked = relayUrlProblem(this.base, Platform.isMobile);
    if (blocked) throw new RelayError(0, blocked);
    let res: RequestUrlResponse;
    try {
      res = await requestUrl({
        url: this.base + path,
        method,
        headers,
        body: wireBody,
        throw: false,
      });
    } catch (e) {
      throw new RelayError(0, explainRelayNetworkError(e, this.base, Platform.isMobile));
    }
    if (res.status >= 400) throw this.toError(res);
    return res;
  }

  private toError(res: RequestUrlResponse): RelayError {
    let message = `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = this.parseJson<{ error?: unknown; code?: unknown }>(res);
      if (body && typeof body.error === "string" && body.error) message = body.error;
      if (body && typeof body.code === "string") code = body.code;
    } catch {
      // keep default message
    }
    return new RelayError(res.status, message, code);
  }

  /**
   * Mobile quirk: res.json can come back empty even when the body parses,
   * so fall back to JSON.parse(res.text).
   */
  private parseJson<T>(res: RequestUrlResponse): T | null {
    const j = res.json as T | null | undefined;
    if (j !== null && j !== undefined && j !== "") return j;
    const text = res.text;
    if (typeof text === "string" && text.trim()) {
      try {
        return JSON.parse(text) as T;
      } catch {
        // not JSON
      }
    }
    return null;
  }

  private expectJson<T>(res: RequestUrlResponse): T {
    const j = this.parseJson<T>(res);
    if (j === null || typeof j !== "object") {
      throw new RelayError(res.status, `Malformed relay response (HTTP ${res.status})`);
    }
    return j;
  }

  // ------------------------------------------------------------ pairing room

  async pairStart(req: PairStartRequest): Promise<PairStartResponse> {
    const res = await this.send("POST", "/v1/pair/start", req);
    return this.expectJson<PairStartResponse>(res);
  }

  /** 409 `taken` if the nameplate is already claimed by another guest. */
  async pairClaim(req: PairClaimRequest): Promise<void> {
    await this.send("POST", "/v1/pair/claim", req);
  }

  /** Returns the frame id the relay assigned. */
  async pairMsg(req: PairPostRequest): Promise<number> {
    const res = await this.send("POST", "/v1/pair/msg", req);
    const j = this.expectJson<{ id?: unknown }>(res);
    return typeof j.id === "number" ? j.id : -1;
  }

  async pairInbox(nameplate: string): Promise<PairInboxResponse> {
    const res = await this.send("GET", `/v1/pair/inbox?nameplate=${encodeURIComponent(nameplate)}`);
    return this.expectJson<PairInboxResponse>(res);
  }

  async pairFinish(req: PairFinishRequest): Promise<PairFinishResponse> {
    const res = await this.send("POST", "/v1/pair/finish", req);
    return this.expectJson<PairFinishResponse>(res);
  }

  async guestFinish(req: GuestFinishRequest): Promise<PairFinishResponse> {
    const res = await this.send("POST", "/v1/pair/guest-finish", req);
    return this.expectJson<PairFinishResponse>(res);
  }

  // ------------------------------------------------------------------- flock

  async flock(): Promise<FlockInfo> {
    const res = await this.send("GET", "/v1/flock");
    const j = this.expectJson<Partial<FlockInfo> & { vaultList?: VaultListItem[] }>(res);
    const devices = Array.isArray(j.devices) ? j.devices : [];
    const vaults = Array.isArray(j.vaults) ? j.vaults : Array.isArray(j.vaultList) ? j.vaultList : [];
    return { devices, vaults };
  }

  async approveDevice(req: ApproveDeviceRequest): Promise<void> {
    await this.send("POST", "/v1/devices/approve", req);
  }

  /** POST /v1/devices/revoke — body { deviceId }; caller cannot revoke itself. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.send("POST", "/v1/devices/revoke", { deviceId });
  }

  // ------------------------------------------------------------------ vaults

  async vaultEnroll(req: VaultEnrollRequest): Promise<void> {
    await this.send("POST", "/v1/vaults", req);
  }

  async vaultList(): Promise<VaultListItem[]> {
    const res = await this.send("GET", "/v1/vaults");
    const j = this.parseJson<VaultListItem[]>(res);
    return Array.isArray(j) ? j : [];
  }

  // -------------------------------------------------------------- vault log

  async opsPush(vaultId: string, req: OpsPushRequest): Promise<{ head?: number }> {
    const res = await this.send("POST", `/v1/vaults/${encodeURIComponent(vaultId)}/ops`, req);
    return this.parseJson<{ head?: number }>(res) ?? {};
  }

  async opsPull(vaultId: string, after: number): Promise<OpsPullResponse> {
    const res = await this.send(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/ops?after=${encodeURIComponent(String(after))}`
    );
    return this.expectJson<OpsPullResponse>(res);
  }

  async merkle(vaultId: string): Promise<MerkleResponse> {
    const res = await this.send("GET", `/v1/vaults/${encodeURIComponent(vaultId)}/merkle`);
    return this.expectJson<MerkleResponse>(res);
  }

  // ----------------------------------------------------------------- blobs

  /** PUT raw ciphertext with Content-Type application/octet-stream. */
  async putBlob(vaultId: string, blobHash: string, data: ArrayBuffer): Promise<void> {
    await this.send(
      "PUT",
      `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobHash)}`,
      data,
      { "Content-Type": "application/octet-stream" }
    );
  }

  async getBlob(vaultId: string, blobHash: string): Promise<ArrayBuffer> {
    const res = await this.send(
      "GET",
      `/v1/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobHash)}`
    );
    return res.arrayBuffer;
  }
}