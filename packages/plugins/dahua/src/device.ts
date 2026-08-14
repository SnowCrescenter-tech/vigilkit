import { generateAuthorization, parseDigestChallenge } from './digest.js';
import { DahuaError } from './errors.js';
import { directionToCode, ptzStartPath, ptzStopPath, zoomToCode, type PtzDirection, type ZoomDirection } from './ptz.js';
import { rtspOverWebSocketUrl, rtspUrl, snapshotUrl } from './urls.js';
import { childByName, childText, childrenByName, parseXml } from './xml.js';

/**
 * High-level Dahua device client.
 *
 * Wraps the HTTP CGI API (`cgi-bin`) with HTTP Digest authentication
 * (RFC 7616). The first request is sent unauthenticated; a `401` carries the
 * digest challenge which is then answered on retry. All parsing is
 * dependency-free.
 */

export interface DahuaDeviceOptions {
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
  deviceType?: string;
  /** Build date string from the magicBox response, when present. */
  build?: string;
}

export interface Channel {
  id: string;
  name?: string;
  enabled?: boolean;
}

/** A pan/tilt direction or zoom command accepted by `ptzStart`. */
export type PtzCommand = PtzDirection | ZoomDirection;

export class DahuaDevice {
  private readonly host: string;
  private readonly port: number;
  private readonly username: string;
  private readonly password: string;
  private readonly https: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DahuaDeviceOptions) {
    if (!options.host || !options.password) {
      throw new DahuaError('INVALID_ARGUMENT', 'host and password are required');
    }
    this.host = options.host;
    this.port = options.port ?? (options.https ? 443 : 80);
    this.username = options.username ?? 'admin';
    this.password = options.password;
    this.https = options.https ?? false;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch ?? undefined) as typeof fetch;
    if (!this.fetchImpl) {
      throw new DahuaError('INVALID_ARGUMENT', 'No fetch implementation available; pass fetchImpl');
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
        throw new DahuaError('HTTP', `Request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Performs a CGI request, transparently handling digest auth.
   * Returns the response; throws `DahuaError` on auth/HTTP failure.
   */
  async request(method: string, path: string, init?: RequestInit): Promise<Response> {
    if (!path.startsWith('/')) throw new DahuaError('INVALID_ARGUMENT', `Path must start with '/': ${path}`);
    const url = `${this.baseUrl()}${path}`;

    const first = await this.doFetch(url, { ...init, method });
    if (first.status !== 401) {
      if (first.ok) return first;
      throw new DahuaError('HTTP', `Request failed: ${first.status} ${first.statusText}`, first.status);
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
      throw new DahuaError('HTTP', `Request failed after auth: ${retry.status} ${retry.statusText}`, retry.status);
    }
    return retry;
  }

  private async requestText(method: string, path: string, init?: RequestInit): Promise<string> {
    const res = await this.request(method, path, init);
    return res.text();
  }

  /**
   * Reads `GET /cgi-bin/magicBox.cgi?action=getSystemInfo`.
   * deviceName = `<deviceName>`, model = `<deviceType>`, serialNumber =
   * `<serialNumber>`, firmwareVersion = `<version>` (falling back to `<build>`).
   */
  async getSystemInfo(): Promise<DeviceInfo> {
    const xml = await this.requestText('GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo');
    const root = parseXml(xml);
    const version = childText(root, 'version');
    const build = childText(root, 'build');
    return {
      deviceName: childText(root, 'deviceName'),
      model: childText(root, 'deviceType') ?? childText(root, 'deviceModel'),
      serialNumber: childText(root, 'serialNumber'),
      firmwareVersion: version ?? build,
      deviceType: childText(root, 'deviceType'),
      build,
    };
  }

  /**
   * Reads `GET /cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle`.
   * The response is a `<table>` of `<ChannelTitle>` rows; each row carries
   * `<Name>` (channel title) and `<value>` (0-based channel index). Rows are
   * mapped to 1-based channel ids (matching every other Dahua channel
   * parameter) with `enabled: true` (the CGI has no enabled flag here).
   */
  async listChannels(): Promise<Channel[]> {
    const xml = await this.requestText(
      'GET',
      '/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle',
    );
    const root = parseXml(xml);
    const table = childByName(root, 'table');
    const rows = table ? childrenByName(table, 'ChannelTitle') : childrenByName(root, 'ChannelTitle');
    return rows.map((row) => {
      const name = childText(row, 'Name');
      const value = childText(row, 'value');
      const index = Number.parseInt(value ?? '', 10);
      const id = Number.isInteger(index) && index >= 0 ? String(index + 1) : '';
      return { id, name, enabled: true };
    });
  }

  /** Starts PTZ motion on a channel (`action=start` with the mapped code). */
  async ptzStart(channel: number, cmd: PtzCommand): Promise<void> {
    const code = cmd === 'in' || cmd === 'out' ? zoomToCode(cmd) : directionToCode(cmd);
    await this.requestText('GET', ptzStartPath(channel, code));
  }

  /** Stops PTZ motion (`action=stop` with the moving direction's code). */
  async ptzStop(channel: number, code: string): Promise<void> {
    await this.requestText('GET', ptzStopPath(channel, code));
  }

  /** Builds an RTSP URL for a channel; subtype 0 = main stream, 1/2 = extra. */
  buildRtspUrl(channel: number, subtype: 0 | 1 | 2 = 0): string {
    return rtspUrl({
      host: this.host,
      username: this.username,
      password: this.password,
      channel,
      subtype,
      rtspPort: 554,
    });
  }

  /** Builds the static RTSP-over-WebSocket bridge URL for the device. */
  buildRtspOverWebSocketUrl(): string {
    return rtspOverWebSocketUrl({ host: this.host });
  }

  /** Builds a snapshot CGI URL for a channel. */
  buildSnapshotUrl(channel: number): string {
    return snapshotUrl({ host: this.host, channel, port: this.port, https: this.https });
  }
}
