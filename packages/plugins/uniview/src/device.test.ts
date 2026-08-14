import { describe, expect, it } from 'vitest';
import { UniviewDevice } from './device.js';
import { UniviewError } from './errors.js';

const DEVICE_INFO_JSON = JSON.stringify({
  DeviceInfo: {
    Name: 'Front Gate Cam',
    Model: 'IPC3616SR3-DUF',
    SerialNumber: 'ABCD1234EFGH',
    Version: 'V1.0.0 build 2024-01-15',
  },
});

const CHANNELS_JSON = JSON.stringify([
  { Id: 1, Name: 'Camera 01', Enable: true },
  { Id: 2, Name: 'Camera 02', Enable: false },
]);

const CHALLENGE_HEADER = 'Digest realm="Login to ABCD1234EFGH", nonce="abc123", algorithm=MD5, qop="auth"';

function makeDevice(handler: (url: string, init: RequestInit) => Response): UniviewDevice {
  return new UniviewDevice({
    host: '192.168.1.64',
    password: '12345',
    fetchImpl: (async (url: string, init: RequestInit) => handler(url, init)) as typeof fetch,
  });
}

/** Returns a device that answers 401 (with a Digest challenge) until authorized. */
function authedDevice(body: () => string): UniviewDevice {
  return makeDevice((_url, init) => {
    const auth = (init.headers as Record<string, string> | undefined)?.authorization;
    if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
    return new Response(body(), { status: 200 });
  });
}

describe('UniviewDevice.request (digest auth flow)', () => {
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

    const res = await device.request('GET', '/LAPI/V1.0/System/DeviceInfo');
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[0]!.auth).toBeNull();
    expect(seen[1]!.auth).toContain('Digest ');
    expect(seen[1]!.auth).toContain('username="admin"');
    expect(seen[1]!.auth).toContain('uri="/LAPI/V1.0/System/DeviceInfo"');
    expect(seen[1]!.url).toBe('http://192.168.1.64:80/LAPI/V1.0/System/DeviceInfo');
  });

  it('returns immediately when no auth is required', async () => {
    let calls = 0;
    const device = makeDevice(() => {
      calls++;
      return new Response('ok', { status: 200 });
    });
    await device.request('GET', '/LAPI/V1.0/System/DeviceInfo');
    expect(calls).toBe(1);
  });

  it('throws HTTP error for non-401, non-2xx responses', async () => {
    const device = makeDevice(() => new Response('nope', { status: 500, statusText: 'Internal Server Error' }));
    await expect(device.request('GET', '/LAPI/V1.0/System/DeviceInfo')).rejects.toThrow(UniviewError);
  });

  it('throws AUTH error when challenge is not Digest', async () => {
    const device = makeDevice(() => new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } }));
    await expect(device.request('GET', '/LAPI/V1.0/System/DeviceInfo')).rejects.toThrow(/Digest/);
  });
});

describe('UniviewDevice.getDeviceInfo', () => {
  it('parses the nested DeviceInfo JSON shape', async () => {
    const device = authedDevice(() => DEVICE_INFO_JSON);
    const info = await device.getDeviceInfo();
    expect(info.deviceName).toBe('Front Gate Cam');
    expect(info.model).toBe('IPC3616SR3-DUF');
    expect(info.serialNumber).toBe('ABCD1234EFGH');
    expect(info.firmwareVersion).toBe('V1.0.0 build 2024-01-15');
  });

  it('parses the flat top-level JSON shape', async () => {
    const device = authedDevice(() =>
      JSON.stringify({ Name: 'Flat Cam', Model: 'IPC-B200', SerialNumber: 'SER42', Version: 'V2.0.0' }),
    );
    const info = await device.getDeviceInfo();
    expect(info.deviceName).toBe('Flat Cam');
    expect(info.model).toBe('IPC-B200');
    expect(info.serialNumber).toBe('SER42');
    expect(info.firmwareVersion).toBe('V2.0.0');
  });

  it('throws PARSE for malformed JSON bodies', async () => {
    const device = authedDevice(() => '{not json');
    await expect(device.getDeviceInfo()).rejects.toThrow(UniviewError);
    await expect(device.getDeviceInfo()).rejects.toMatchObject({ code: 'PARSE' });
  });
});

describe('UniviewDevice.listChannels', () => {
  it('maps the LightAPI channel array with Id/Name/Enable', async () => {
    const device = authedDevice(() => CHANNELS_JSON);
    const channels = await device.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels[0]).toEqual({ id: '1', name: 'Camera 01', enabled: true });
    expect(channels[1]).toEqual({ id: '2', name: 'Camera 02', enabled: false });
  });

  it('falls back to the array index when Id is absent', async () => {
    const device = authedDevice(() => JSON.stringify([{ Name: 'Only Name' }]));
    const channels = await device.listChannels();
    expect(channels[0]).toEqual({ id: '0', name: 'Only Name', enabled: undefined });
  });

  it('throws PARSE when the body is not an array', async () => {
    const device = authedDevice(() => JSON.stringify({ error: 'not an array' }));
    await expect(device.listChannels()).rejects.toMatchObject({ code: 'PARSE' });
  });
});

describe('UniviewDevice PTZ', () => {
  it('PUTs the velocity JSON body to the continuous PTZ path', async () => {
    const seen: Array<{ url: string; method?: string; body?: string; auth?: string | null }> = [];
    const device = makeDevice((url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization ?? null;
      if (auth !== null) seen.push({ url, method: init.method, body: String(init.body ?? ''), auth });
      if (auth === null) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      }
      return new Response('OK', { status: 200 });
    });

    await device.ptzMove(1, 'right');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://192.168.1.64:80/LAPI/V1.0/Channels/1/PTZCtrl/Continuous');
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.body).toBe('{"PTZ":{"Pan":1,"Tilt":0,"Zoom":0}}');
  });

  it('ptzStop PUTs an all-zero body', async () => {
    const bodies: string[] = [];
    const device = makeDevice((_url, init) => {
      const auth = (init.headers as Record<string, string> | undefined)?.authorization;
      if (!auth) return new Response(null, { status: 401, headers: { 'www-authenticate': CHALLENGE_HEADER } });
      bodies.push(String(init.body ?? ''));
      return new Response('OK', { status: 200 });
    });

    await device.ptzStop(1);
    expect(bodies).toEqual(['{"PTZ":{"Pan":0,"Tilt":0,"Zoom":0}}']);
  });
});

describe('UniviewDevice URL builders', () => {
  it('builds IPC and NVR RTSP URLs', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildRtspUrl(1)).toBe('rtsp://admin:12345@192.168.1.64:554/media/video1');
    expect(device.buildRtspUrl(2, 'sub')).toBe('rtsp://admin:12345@192.168.1.64:554/media/video2');
    expect(device.buildRtspUrl(2, 'main', { nvr: true })).toBe(
      'rtsp://admin:12345@192.168.1.64:554/unicast/c2/s0/live',
    );
  });

  it('builds the snapshot URL', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildSnapshotUrl()).toBe('http://192.168.1.64:80/images/snapshot.jpg');
  });

  it('builds MJPEG URLs', () => {
    const device = makeDevice(() => new Response(null, { status: 200 }));
    expect(device.buildMjpegUrl()).toBe('http://192.168.1.64:80/video/mjpeg/stream1');
    expect(device.buildMjpegUrl(2)).toBe('http://192.168.1.64:80/video/mjpeg/stream2');
  });
});
