import { generateAuthorization, parseDigestChallenge } from './digest.js';
import { HikvisionError } from './errors.js';
import { childText, childrenByName, parseXml } from './isapi.js';
import { ptzControlPath, ptzDataXml, ptzPresetPath, stop as ptzStopCommand, type PtzMove } from './ptz.js';
import { rtspUrl } from './urls.js';

/**
 * High-level Hikvision device client.
 *
 * Wraps ISAPI REST calls with HTTP Digest authentication (RFC 7616). The first
 * request is sent unauthenticated; a `401` carries the digest challenge which
 * is then answered on retry. All parsing is dependency-free.
 */

export interface HikvisionDeviceOptions {
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
  macAddress?: string;
  firmwareVersion?: string;
  deviceType?: string;
}

export interface Channel {
  id: string;
  name?: string;
  enabled?: boolean;
}

export class HikvisionDevice {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly https: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HikvisionDeviceOptions) {
    if (!options.host || !options.password) {
      throw new HikvisionError('INVALID_ARGUMENT', 'host and password are required');
    }
    this.host = options.host;
    this.port = options.port ?? (options.https ? 443 : 80);
    this.username = options.username ?? 'admin';
    this.password = options.password;
    this.https = options.https ?? false;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch ?? undefined) as typeof fetch;
    if (!this.fetchImpl) {
      throw new HikvisionError('INVALID_ARGUMENT', 'No fetch implementation available; pass fetchImpl');
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
        throw new HikvisionError('HTTP', `Request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Performs an ISAPI request, transparently handling digest auth.
   * Returns the response; throws `HikvisionError` on auth/HTTP failure.
   */
  async request(method: string, path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith('/')) throw new HikvisionError('INVALID_ARGUMENT', `Path must start with '/': ${path}`);
    const url = `${this.baseUrl()}${path}`;

    const first = await this.doFetch(url, { ...init, method });
    if (first.status !== 401) {
      if (first.ok) return first;
      throw new HikvisionError('HTTP', `Request failed: ${first.status} ${first.statusText}`, first.status);
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
      throw new HikvisionError('HTTP', `Request failed after auth: ${retry.status} ${retry.statusText}`, retry.status);
    }
    return retry;
  }

  private async requestText(method: string, path: string, init?: RequestInit): Promise<string> {
    const res = await this.request(method, path, init);
    return res.text();
  }

  /** Reads `GET /ISAPI/System/deviceInfo`. */
  async getDeviceInfo(): Promise<DeviceInfo> {
    const xml = await this.requestText('GET', '/ISAPI/System/deviceInfo');
    const root = parseXml(xml);
    return {
      deviceName: childText(root, 'deviceName'),
      model: childText(root, 'model'),
      serialNumber: childText(root, 'serialNumber'),
      macAddress: childText(root, 'macAddress'),
      firmwareVersion: childText(root, 'firmwareVersion'),
      deviceType: childText(root, 'deviceType'),
    };
  }

  /** Reads `GET /ISAPI/System/Video/inputs/channels` (or proxy channels). */
  async listChannels(): Promise<Channel[]> {
    const xml = await this.requestText('GET', '/ISAPI/System/Video/inputs/channels');
    const root = parseXml(xml);
    const nodes =
      childrenByName(root, 'VideoInputChannel').length > 0
        ? childrenByName(root, 'VideoInputChannel')
        : childrenByName(root, 'InputProxyChannel');
    return nodes.map((node) => ({
      id: childText(node, 'id') ?? '',
      name: childText(node, 'name'),
      enabled: childText(node, 'enabled') === 'true' ? true : childText(node, 'enabled') === 'false' ? false : undefined,
    }));
  }

  /** Sends a PTZ continuous-control command to a channel. */
  async ptzMove(channel: number, move: PtzMove): Promise<void> {
    await this.requestText('PUT', ptzControlPath(channel), { body: ptzDataXml(move) });
  }

  /** Stops PTZ motion on a channel. */
  async ptzStop(channel: number): Promise<void> {
    await this.requestText('PUT', ptzControlPath(channel), { body: ptzDataXml(ptzStopCommand()) });
  }

  /** Moves a PTZ preset (goto) on a channel. */
  async ptzGotoPreset(channel: number, preset: number): Promise<void> {
    await this.requestText('PUT', ptzPresetPath(channel, preset));
  }

  /** Builds an RTSP URL for a channel's main or sub stream. */
  buildRtspUrl(channel: number, stream: 'main' | 'sub' = 'main'): string {
    return rtspUrl({
      host: this.host,
      username: this.username,
      password: this.password,
      channel,
      stream,
      rtspPort: 554,
    });
  }
}
