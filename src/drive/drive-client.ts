import { requestUrl } from "obsidian";
import type { OAuthConfig, OAuthTokens } from "../auth/google-oauth";
import { refreshAccessToken } from "../auth/google-oauth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const ROOT_FOLDER_NAME = "ObsidianVaults";

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
}

type TokenUpdater = (tokens: OAuthTokens) => Promise<void>;

export class DriveClient {
  private config: OAuthConfig;
  private tokens: OAuthTokens;
  private onTokensUpdated: TokenUpdater;

  constructor(config: OAuthConfig, tokens: OAuthTokens, onTokensUpdated: TokenUpdater) {
    this.config = config;
    this.tokens = tokens;
    this.onTokensUpdated = onTokensUpdated;
  }

  updateTokens(tokens: OAuthTokens): void {
    this.tokens = tokens;
  }

  private async accessToken(): Promise<string> {
    if (Date.now() >= this.tokens.expiresAt - 5_000) {
      const refreshed = await refreshAccessToken(this.config, this.tokens.refreshToken);
      this.tokens = refreshed;
      await this.onTokensUpdated(refreshed);
    }
    return this.tokens.accessToken;
  }

  private async api<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string>;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
      rawUrl?: string;
    } = {}
  ): Promise<T> {
    return this.requestWithRetry<T>(path, options, 0);
  }

  private async requestWithRetry<T>(
    path: string,
    options: {
      method?: string;
      query?: Record<string, string>;
      body?: string | ArrayBuffer;
      headers?: Record<string, string>;
      rawUrl?: string;
    },
    attempt: number
  ): Promise<T> {
    const token = await this.accessToken();
    let url = options.rawUrl ?? `${DRIVE_API}${path}`;
    if (options.query) {
      const qs = new URLSearchParams(options.query);
      url += (url.includes("?") ? "&" : "?") + qs.toString();
    }

    const res = await requestUrl({
      url,
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
      body: options.body,
      throw: false,
    });

    if (res.status === 401 && attempt < 1) {
      const refreshed = await refreshAccessToken(this.config, this.tokens.refreshToken);
      this.tokens = refreshed;
      await this.onTokensUpdated(refreshed);
      return this.requestWithRetry(path, options, attempt + 1);
    }

    if ((res.status === 403 || res.status === 429) && attempt < 5) {
      const delay = Math.min(30_000, 500 * Math.pow(2, attempt));
      await sleep(delay);
      return this.requestWithRetry(path, options, attempt + 1);
    }

    if (res.status >= 400) {
      throw new Error(`Drive API ${res.status}: ${res.text}`);
    }

    if (res.status === 204 || !res.text) {
      return undefined as T;
    }

    try {
      return res.json as T;
    } catch {
      return undefined as T;
    }
  }

  async ensureVaultFolder(vaultFolderName: string): Promise<{ rootId: string; folderId: string }> {
    const rootId = await this.findOrCreateFolder(ROOT_FOLDER_NAME, "root");
    const folderId = await this.findOrCreateFolder(vaultFolderName, rootId);
    return { rootId, folderId };
  }

  async findOrCreateFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.findChild(name, parentId, FOLDER_MIME);
    if (existing) return existing.id;

    const created = await this.api<DriveFileMeta>("/files", {
      method: "POST",
      query: { fields: "id,name,mimeType" },
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mimeType: FOLDER_MIME,
        parents: [parentId],
      }),
    });
    return created.id;
  }

  async findChild(
    name: string,
    parentId: string,
    mimeType?: string
  ): Promise<DriveFileMeta | null> {
    const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    let q = `name='${escaped}' and '${parentId}' in parents and trashed=false`;
    if (mimeType) q += ` and mimeType='${mimeType}'`;

    const result = await this.api<{ files: DriveFileMeta[] }>("/files", {
      query: {
        q,
        fields: "files(id,name,mimeType,modifiedTime,size,md5Checksum,appProperties)",
        pageSize: "10",
        spaces: "drive",
      },
    });
    return result.files?.[0] ?? null;
  }

  async listFolderRecursive(folderId: string): Promise<Map<string, DriveFileMeta>> {
    const out = new Map<string, DriveFileMeta>();
    await this.walk(folderId, "", out);
    return out;
  }

  private async walk(
    folderId: string,
    prefix: string,
    out: Map<string, DriveFileMeta>
  ): Promise<void> {
    let pageToken: string | undefined;
    do {
      const query: Record<string, string> = {
        q: `'${folderId}' in parents and trashed=false`,
        fields:
          "nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum,appProperties,parents)",
        pageSize: "1000",
        spaces: "drive",
      };
      if (pageToken) query.pageToken = pageToken;

      const page = await this.api<{ files: DriveFileMeta[]; nextPageToken?: string }>("/files", {
        query,
      });

      for (const file of page.files ?? []) {
        const path = prefix ? `${prefix}/${file.name}` : file.name;
        if (file.mimeType === FOLDER_MIME) {
          await this.walk(file.id, path, out);
        } else {
          out.set(path, file);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  /** Ensure nested folders exist for a vault-relative file path; return parent folder id. */
  async ensureParentPath(rootFolderId: string, relativeFilePath: string): Promise<string> {
    const parts = relativeFilePath.replace(/\\/g, "/").split("/");
    parts.pop(); // filename
    let parent = rootFolderId;
    for (const part of parts) {
      if (!part) continue;
      parent = await this.findOrCreateFolder(part, parent);
    }
    return parent;
  }

  async uploadNew(
    parentId: string,
    name: string,
    content: ArrayBuffer,
    mimeType: string,
    appProperties?: Record<string, string>
  ): Promise<DriveFileMeta> {
    const metadata: Record<string, unknown> = {
      name,
      parents: [parentId],
      appProperties,
    };

    if (content.byteLength < 5 * 1024 * 1024) {
      return this.multipartUpload("POST", `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum,appProperties`, metadata, content, mimeType);
    }
    return this.resumableUpload("POST", parentId, name, content, mimeType, appProperties);
  }

  async updateFile(
    fileId: string,
    content: ArrayBuffer,
    mimeType: string,
    appProperties?: Record<string, string>
  ): Promise<DriveFileMeta> {
    if (appProperties) {
      await this.api<DriveFileMeta>(`/files/${fileId}`, {
        method: "PATCH",
        query: { fields: "id" },
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appProperties }),
      });
    }

    if (content.byteLength < 5 * 1024 * 1024) {
      return this.multipartUpload(
        "PATCH",
        `${UPLOAD_API}/files/${fileId}?uploadType=multipart&fields=id,name,mimeType,modifiedTime,size,md5Checksum,appProperties`,
        {},
        content,
        mimeType
      );
    }

    const token = await this.accessToken();
    const start = await requestUrl({
      url: `${UPLOAD_API}/files/${fileId}?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,appProperties`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(content.byteLength),
      },
      body: JSON.stringify({}),
      throw: false,
    });
    if (start.status >= 400) {
      throw new Error(`Resumable start failed: ${start.status} ${start.text}`);
    }
    const sessionUrl = start.headers["location"] || start.headers["Location"];
    if (!sessionUrl) throw new Error("No resumable session URL");

    const put = await requestUrl({
      url: sessionUrl,
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(content.byteLength),
      },
      body: content,
      throw: false,
    });
    if (put.status >= 400) {
      throw new Error(`Resumable upload failed: ${put.status} ${put.text}`);
    }
    return put.json as DriveFileMeta;
  }

  private async multipartUpload(
    method: string,
    url: string,
    metadata: Record<string, unknown>,
    content: ArrayBuffer,
    mimeType: string
  ): Promise<DriveFileMeta> {
    const boundary = "obsidian_gdrive_sync_" + Date.now();
    const metaPart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n`;
    const fileHeader = `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const end = `\r\n--${boundary}--`;

    const metaBytes = new TextEncoder().encode(metaPart + fileHeader);
    const endBytes = new TextEncoder().encode(end);
    const body = new Uint8Array(metaBytes.length + content.byteLength + endBytes.length);
    body.set(metaBytes, 0);
    body.set(new Uint8Array(content), metaBytes.length);
    body.set(endBytes, metaBytes.length + content.byteLength);
    const bodyBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

    const token = await this.accessToken();
    const res = await requestUrl({
      url,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: bodyBuffer,
      throw: false,
    });

    if ((res.status === 403 || res.status === 429)) {
      await sleep(1000);
      return this.multipartUpload(method, url, metadata, content, mimeType);
    }
    if (res.status >= 400) {
      throw new Error(`Upload failed ${res.status}: ${res.text}`);
    }
    return res.json as DriveFileMeta;
  }

  private async resumableUpload(
    _method: string,
    parentId: string,
    name: string,
    content: ArrayBuffer,
    mimeType: string,
    appProperties?: Record<string, string>
  ): Promise<DriveFileMeta> {
    const token = await this.accessToken();
    const start = await requestUrl({
      url: `${UPLOAD_API}/files?uploadType=resumable&fields=id,name,mimeType,modifiedTime,size,md5Checksum,appProperties`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(content.byteLength),
      },
      body: JSON.stringify({
        name,
        parents: [parentId],
        appProperties,
      }),
      throw: false,
    });
    if (start.status >= 400) {
      throw new Error(`Resumable start failed: ${start.status} ${start.text}`);
    }
    const sessionUrl = start.headers["location"] || start.headers["Location"];
    if (!sessionUrl) throw new Error("No resumable session URL");

    const put = await requestUrl({
      url: sessionUrl,
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(content.byteLength),
      },
      body: content,
      throw: false,
    });
    if (put.status >= 400) {
      throw new Error(`Resumable upload failed: ${put.status} ${put.text}`);
    }
    return put.json as DriveFileMeta;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const token = await this.accessToken();
    const res = await requestUrl({
      url: `${DRIVE_API}/files/${fileId}?alt=media`,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      throw: false,
    });
    if (res.status >= 400) {
      throw new Error(`Download failed ${res.status}: ${res.text}`);
    }
    return res.arrayBuffer;
  }

  async trash(fileId: string): Promise<void> {
    await this.api(`/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
      query: { fields: "id" },
    });
  }

  async rename(fileId: string, newName: string): Promise<void> {
    await this.api(`/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
      query: { fields: "id,name" },
    });
  }

  async getStartPageToken(): Promise<string> {
    const res = await this.api<{ startPageToken: string }>("/changes/startPageToken", {
      query: { supportsAllDrives: "false" },
    });
    return res.startPageToken;
  }

  guessMime(path: string): string {
    const lower = path.toLowerCase();
    if (lower.endsWith(".md")) return "text/markdown";
    if (lower.endsWith(".json") || lower.endsWith(".canvas")) return "application/json";
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webp")) return "image/webp";
    if (lower.endsWith(".pdf")) return "application/pdf";
    if (lower.endsWith(".svg")) return "image/svg+xml";
    if (lower.endsWith(".css")) return "text/css";
    if (lower.endsWith(".js")) return "application/javascript";
    if (lower.endsWith(".html")) return "text/html";
    if (lower.endsWith(".txt")) return "text/plain";
    return "application/octet-stream";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
