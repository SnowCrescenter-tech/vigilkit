import { describe, expect, it } from 'vitest';
import { DahuaDevice } from './device.js';
import { DahuaError } from './errors.js';
import { directionToCode } from './ptz.js';

const SYSTEM_INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<magicBox>
<deviceName>Front Gate Cam</deviceName>
<deviceType>IPC-HFW1230S</deviceType>
<deviceModel>IPC-HFW1230S</deviceModel>
<hardwareVersion>1.00</hardwareVersion>
<softwareVersion>2.800.0000000.0</softwareVersion>
<serialNumber>4D04J1TPA00042</serialNumber>
<build>2020-04-20</build>
<version>2.800.0000000.0</version>
</magicBox>`;

const CHANNELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<configManager>
<table>
<ChannelTitle><Name>Camera 01</Name><value>0</value></ChannelTitle>
<ChannelTitle><Name>Camera 02</Name><value>1</value></ChannelTitle>
</table>
</configManager>`;

const CHALLENGE_HEADER = 'Digest realm="Login to 4D04J1TPA00042", nonce="abc123", algorithm=MD5, qop="auth"';

function makeDevice(handler: (url: string, init: RequestInit) => Response): DahuaDevice {
  return new DahuaDevice({
    host: '192.168.1.64',
    password: '12345',
    fetchImpl: (async (url: string, init: RequestInit) => handler(url, init)) as typeof fetch,
  });
}

describe('DahuaDevice.request (digest auth flow)', () => {
  it('retries with Authorization after a 401 challenge', async () => {
    const seen: Array<{ method?: string; url: string; auth?: string | null }> = [];
    const device = makeDevice((url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization ?? null;
      seen.push({ method: init.method, url, auth });
      if (auth === null) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      }
      return new Response('ok', { status: 200 });
    });

    const res = await device.request('GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.auth).toBeNull();
    expect(seen[1]!.auth).toContain('Digest ');
    expect(seen[1]!.auth).toContain('username="admin"');
    expect(seen[1]!.auth).toContain('uri="/cgi-bin/magicBox.cgi?action=getSystemInfo"');
    expect(seen[1]!.url).toBe('http://192.168.1.64:80/cgi-bin/magicBox.cgi?action=getSystemInfo');
  });

  it('returns immediately when no auth is required', async () => {
    let calls = 0;
    const device = makeDevice(() => {
      calls++;
      return new Response('ok', { status: 200 });
    });
    await device.request('GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo');
    expect(calls).toBe(1);
  });

  it('throws HTTP error for non-401, non-2xx responses', async () => {
    const device = makeDevice(() => new Response('nope', { status: 500, statusText: 'Internal Server Error' }));
    await expect(device.request('GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo')).rejects.toThrow(
      DahuaError,
    );
  });

  it('throws AUTH error when challenge is not Digest', async () => {
    const device = makeDevice(() => new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    await expect(device.request('GET', '/cgi-bin/magicBox.cgi?action=getSystemInfo')).rejects.toThrow(
      /Digest/,
    );
  });
});

describe('DahuaDevice.getSystemInfo', () => {
  it('parses device info from the magicBox response', async () => {
    const device = makeDevice((_url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      return new Response(SYSTEM_INFO_XML, { status: 200 });
    });
    const info = await device.getSystemInfo();
    expect(info.deviceName).toBe('Front Gate Cam');
    expect(info.model).toBe('IPC-HFW1230S');
    expect(info.serialNumber).toBe('4D04J1TPA00042');
    expect(info.firmwareVersion).toBe('2.800.0000000.0');
    expect(info.build).toBe('2020-04-20');
  });
});

describe('DahuaDevice.listChannels', () => {
  it('parses the ChannelTitle table into 1-based channel ids', async () => {
    const device = makeDevice((_url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      return new Response(CHANNELS_XML, { status: 200 });
    });
    const channels = await device.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels[0]).toEqual({ id: '1', name: 'Camera 01', enabled: true });
    expect(channels[1]).toEqual({ id: '2', name: 'Camera 02', enabled: true });
  });
});

describe('DahuaDevice PTZ', () => {
  it('sends the start CGI path for a direction', async () => {
    const urls: string[] = [];
    const device = makeDevice((url, init) => {
      if ((init.headers as Record<string, string> | undefined)?.authorization) {
        urls.push(url);
        return new Response('OK', { status: 200 });
      }
      return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
    });
    await device.ptzStart(1, 'right');
    expect(urls).toEqual(['http://192.168.1.64:80/cgi-bin/ptz.cgi?action=start&channel=1&code=Right&arg1=0&arg2=0&arg3=0']);
  });

  it('maps zoom commands to ZoomTele/ZoomWide', async () => {
    const urls: string[] = [];
    const device = makeDevice((url, init) => {
      if ((init.headers as Record<string, string> | undefined)?.authorization) {
        urls.push(url);
        return new Response('OK', { status: 200 });
      }
      return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
    });
    await device.ptzStart(1, 'in');
    expect(urls[0]).toContain('action=start&channel=1&code=ZoomTele');
  });

  it('sends the stop CGI path', async () => {
    const urls: string[] = [];
    const device = makeDevice((url, init) => {
      if ((init.headers as Record<string, string> | undefined)?.authorization) {
        urls.push(url);
        return new Response('OK', { status: 200 });
      }
      return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
    });
    await device.ptzStop(1, directionToCode('right'));
    expect(urls).toEqual(['http://192.168.1.64:80/cgi-bin/ptz.cgi?action=stop&channel=1&code=Right&arg1=0&arg2=0&arg3=0']);
  });
});

describe('DahuaDevice URL builders', () => {
  it('builds RTSP URLs', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildRtspUrl(1)).toBe('rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=1&subtype=0');
    expect(device.buildRtspUrl(2, 1)).toBe('rtsp://admin:12345@192.168.1.64:554/cam/realmonitor?channel=2&subtype=1');
  });

  it('builds the RTSP-over-WebSocket bridge URL', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildRtspOverWebSocketUrl()).toBe('ws://192.168.1.64/rtspoverwebsocket');
  });

  it('builds a snapshot URL', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildSnapshotUrl(1)).toBe('http://192.168.1.64:80/cgi-bin/snapshot.cgi?channel=1');
  });
});
