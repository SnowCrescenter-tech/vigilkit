import { describe, expect, it } from 'vitest';
import { HikvisionDevice } from './device.js';
import { HikvisionError } from './errors.js';

const DEVICE_INFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<deviceName>Front Gate Cam</deviceName>
<model>DS-2CD2142FWD-I</model>
<serialNumber>DS-2CD2142FWD-I20160101AAWR123456789</serialNumber>
<macAddress>44:19:b6:aa:bb:cc</macAddress>
<firmwareVersion>V5.5.0</firmwareVersion>
<deviceType>IPCamera</deviceType>
</DeviceInfo>`;

const CHANNELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<InputProxyChannelList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<InputProxyChannel version="2.0"><id>1</id><name>Camera 01</name><enabled>true</enabled></InputProxyChannel>
<InputProxyChannel version="2.0"><id>2</id><name>Camera 02</name><enabled>false</enabled></InputProxyChannel>
</InputProxyChannelList>`;

const CHALLENGE_HEADER = 'Digest realm="IP Camera(C4606)", nonce="abc123", algorithm=MD5, qop="auth"';

function makeDevice(handler: (url: string, init: RequestInit) => Response): HikvisionDevice {
  return new HikvisionDevice({
    host: '192.168.1.64',
    password: '12345',
    fetchImpl: (async (url: string, init: RequestInit) => handler(url, init)) as typeof fetch,
  });
}

describe('HikvisionDevice.request (digest auth flow)', () => {
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

    const res = await device.request('GET', '/ISAPI/System/deviceInfo');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.auth).toBeNull();
    expect(seen[1]!.auth).toContain('Digest ');
    expect(seen[1]!.auth).toContain('username="admin"');
    expect(seen[1]!.auth).toContain('uri="/ISAPI/System/deviceInfo"');
    expect(seen[1]!.url).toBe('http://192.168.1.64:80/ISAPI/System/deviceInfo');
  });

  it('returns immediately when no auth is required', async () => {
    let calls = 0;
    const device = makeDevice(() => {
      calls++;
      return new Response('ok', { status: 200 });
    });
    await device.request('GET', '/ISAPI/System/deviceInfo');
    expect(calls).toBe(1);
  });

  it('throws HTTP error for non-401, non-2xx responses', async () => {
    const device = makeDevice(() => new Response('nope', { status: 500, statusText: 'Internal Server Error' }));
    await expect(device.request('GET', '/ISAPI/System/deviceInfo')).rejects.toThrow(HikvisionError);
  });

  it('throws AUTH error when challenge is not Digest', async () => {
    const device = makeDevice(() => new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    await expect(device.request('GET', '/ISAPI/System/deviceInfo')).rejects.toThrow(/Digest/);
  });
});

describe('HikvisionDevice.getDeviceInfo', () => {
  it('parses device info from the ISAPI response', async () => {
    const device = makeDevice((_url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      return new Response(DEVICE_INFO_XML, { status: 200 });
    });
    const info = await device.getDeviceInfo();
    expect(info.model).toBe('DS-2CD2142FWD-I');
    expect(info.serialNumber).toBe('DS-2CD2142FWD-I20160101AAWR123456789');
    expect(info.macAddress).toBe('44:19:b6:aa:bb:cc');
  });
});

describe('HikvisionDevice.listChannels', () => {
  it('parses channel list', async () => {
    const device = makeDevice((_url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      return new Response(CHANNELS_XML, { status: 200 });
    });
    const channels = await device.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels[0]).toEqual({ id: '1', name: 'Camera 01', enabled: true });
    expect(channels[1]!.enabled).toBe(false);
  });
});

describe('HikvisionDevice PTZ', () => {
  it('sends the continuous-control XML body', async () => {
    let body: string | null = null;
    let url = '';
    const device = makeDevice((_url, init) => {
      if ((init.headers as Record<string, string> | undefined)?.authorization) {
        url = _url;
        body = (init.body as string) ?? null;
        return new Response('ok', { status: 200 });
      }
      return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
    });
    await device.ptzMove(1, { pan: 50, tilt: 0, zoom: 0 });
    expect(url).toBe('http://192.168.1.64:80/ISAPI/PTZCtrl/channels/1/continuous');
    expect(body).toBe('<PTZData><pan>50</pan><tilt>0</tilt><zoom>0</zoom></PTZData>');
  });
});

describe('HikvisionDevice.buildRtspUrl', () => {
  it('builds RTSP URLs', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildRtspUrl(1)).toBe('rtsp://admin:12345@192.168.1.64:554/Streaming/Channels/101');
    expect(device.buildRtspUrl(2, 'sub')).toBe('rtsp://admin:12345@192.168.1.64:554/Streaming/Channels/202');
  });
});
