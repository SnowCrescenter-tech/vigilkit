import { generateAuthorization, parseDigestChallenge } from './digest.js';
import { UniviewError } from './errors.js';
import { getBoolean, getNumber, getString, parseJsonResponse } from './json.js';
import { ptzBody, ptzPath, type PtzDirection, type ZoomDirection } from './ptz.js';
import { mjpegUrl, rtspUrl, snapshotUrl, type UniviewStream } from './urls.js';

/**
 * High-level Uniview (UNV) device client.
 *
 * Wraps the LightAPI (`/LAPI/V1.0`) REST control plane with HTTP Digest
 * authentication (RFC 7616). The first request is sent unauthenticated; a
 * `401` carries the digest challenge which is then answered on retry. Unlike
 * the Hikvision ISAPI (XML), LightAPI is HTTP + JSON, parsed by the
 * dependency-free helpers in `json.ts`.
 */

export interface UniviewDeviceOptions {
  /** Hostname or IP (no scheme). */
  host: string;
  /** HTTP port (default 80). */
  port?: number;
  /** Username (default 'admin'). */
  username?: string;
  password: string;
  /** Use HTTPS (default false). */
  https?: boolean;
  /** Request timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Injectable fetch implementation (for testing / non-standard runtimes). */
  fetchImpl?: typeof fetch;
}

export interface DeviceInfo {
  deviceName?: string;
  model?: string;
  serialNumber?: string;
  firmwareVersion?: string;
}

export interface Channel {
  id: string;
  name?: string;
  enabled?: boolean;
}

/** A pan/tilt direction or zoom command accepted by `ptzMove`. */
export type PtzCommand = PtzDirection | ZoomDirection;

export class UniviewDevice {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly https: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UniviewDeviceOptions) {
    if (!options.host || !options.password) {
      throw new UniviewError('INVALID_ARGUMENT', 'host and password are required');
    }
    this.host = options.host;
    this.port = options.port ?? (options.https ? 443 : 80);
    this.username = options.username ?? 'admin';
    this.password = options.password;
    this.https = options.https ?? false;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch ?? undefined) as typeof fetch;
    if (!this.fetchImpl) {
      throw new UniviewError('INVALID_ARGUMENT', 'No fetch implementation available; pass fetchImpl');
    }
  }

  private baseUrl(): string {
    return `${this.https ? 'https' : 'http'}://${this.host}:${this.port}`;
  }

  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new UniviewError('HTTP', `Request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Performs a LightAPI request, transparently handling digest auth.
   * Returns the response; throws `UniviewError` on auth/HTTP failure.
   */
  async request(method: string, path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith('/')) throw new UniviewError('INVALID_ARGUMENT', `Path must start with '/': ${path}`);
    const url = `${this.baseUrl()}${path}`;

    const first = await this.doFetch(url, { ...init, method });
    if (first.status !== 401) {
      if (first.ok) return first;
      throw new UniviewError('HTTP', `Request failed: ${first.status} ${first.statusText}`, first.status);
    }

    const challenge = parseDigestChallenge(first.headers.get('www-authenticate'));
    const authorization = generateAuthorization(this.username, this.password, method, path, challenge, {
      entityBody: typeof init?.body === 'string' ? init.body : undefined,
    });

    const retry = await this.doFetch(url, {
      ...init,
      method,
      headers: { ...(init?.headers as Record<string, string> | undefined), authorization },
    });
    if (!retry.ok) {
      throw new UniviewError('HTTP', `Request failed after auth: ${retry.status} ${retry.statusText}`, retry.status);
    }
    return retry;
  }

  private async requestText(method: string, path: string, init?: RequestInit): Promise<string> {
    const res = await this.request(method, path, init);
    return res.text();
  }

  /**
   * Reads `GET /LAPI/V1.0/System/DeviceInfo`. The response is JSON with the
   * device object either nested under `DeviceInfo` or at the top level; both
   * shapes are read via the dotted-path helpers.
   */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const parsed = parseJsonResponse(await this.requestText('GET', '/LAPI/V1.0/System/DeviceInfo'));
    return {
      deviceName: getString(parsed, 'DeviceInfo.Name') ?? getString(parsed, 'Name'),
      model: getString(parsed, 'DeviceInfo.Model') ?? getString(parsed, 'Model'),
      serialNumber: getString(parsed, 'DeviceInfo.SerialNumber') ?? getString(parsed, 'SerialNumber'),
      firmwareVersion: getString(parsed, 'DeviceInfo.Version') ?? getString(parsed, 'Version'),
    };
  }

  /**
   * Reads `GET /LAPI/V1.0/Channels`. The response is a JSON array of channel
   * objects; each is mapped best-effort to `{id, name, enabled}` where
   * `id` is the channel's `Id` (or its array index when `Id` is absent),
   * `name` is `Name`, and `enabled` is `Enable`.
   */
  async listChannels(): Promise<Channel[]> {
    const parsed = parseJsonResponse(await this.requestText('GET', '/LAPI/V1.0/Channels'));
    let list: unknown;
    if (Array.isArray(parsed)) {
      list = parsed;
    } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).Channels)) {
      list = (parsed as Record<string, unknown>).Channels;
    } else {
      list = null;
    }
    if (list === null) {
      throw new UniviewError('PARSE', 'Channel list is not a JSON array');
    }
    return (list as unknown[]).map((entry, index) => {
      const idNumber = getNumber(entry, 'Id');
      const idString = getString(entry, 'Id');
      return {
        id: idString ?? (idNumber !== undefined ? String(idNumber) : String(index)),
        name: getString(entry, 'Name'),
        enabled: getBoolean(entry, 'Enable'),
      };
    });
  }

  /**
   * Starts continuous PTZ motion by PUTting the velocity body to
   * `/LAPI/V1.0/Channels/<id>/PTZCtrl/Continuous`. Motion continues until a
   * `stop` body is PUT to the same path (see `ptzStop`).
   */
  async ptzMove(channel: number, cmd: PtzCommand): Promise<void> {
    await this.requestText('PUT', ptzPath(channel), {
      body: ptzBody(cmd),
      headers: { 'content-type': 'application/json' },
    });
  }

  /** Stops all PTZ motion (PUTs an all-zero velocity body). */
  async ptzStop(channel: number): Promise<void> {
    await this.ptzMove(channel, 'stop');
  }

  /** Builds an RTSP URL for a channel; `nvr` selects the unicast template. */
  buildRtspUrl(channel: number, stream: UniviewStream = 'main', opts?: { rtspPort?: number; nvr?: boolean }): string {
    return rtspUrl({
      host: this.host,
      username: this.username,
      password: this.password,
      channel,
      stream,
      rtspPort: opts?.rtspPort ?? 554,
      nvr: opts?.nvr,
    });
  }

  /** Builds the documented snapshot URL for the device. */
  buildSnapshotUrl(): string {
    return snapshotUrl({ host: this.host, port: this.port, https: this.https });
  }

  /** Builds an MJPEG stream URL (stream index 1..3, default 1). */
  buildMjpegUrl(stream: number = 1): string {
    return mjpegUrl({ host: this.host, port: this.port, https: this.https, stream });
  }
}
