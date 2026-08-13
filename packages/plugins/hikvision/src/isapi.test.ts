import { describe, expect, it } from 'vitest';
import { childByName, childText, childrenByName, parseXml } from './isapi.js';

const DEVICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<deviceName>Front Gate Cam</deviceName>
<deviceID>ffffffff-ffff-ffff-ffff-ffffffffffff</deviceID>
<model>DS-2CD2142FWD-I</model>
<serialNumber>DS-2CD2142FWD-I20160101AAWR123456789</serialNumber>
<macAddress>44:19:b6:xx:xx:xx</macAddress>
<firmwareVersion>V5.5.0</firmwareVersion>
<firmwareReleasedDate>build 160510</firmwareReleasedDate>
<encoderVersion>V7.3</encoderVersion>
<encoderReleasedDate>build 160425</encoderReleasedDate>
<deviceType>IPCamera</deviceType>
</DeviceInfo>`;

describe('parseXml', () => {
  it('parses the root element name and version attribute', () => {
    const root = parseXml(DEVICE_INFO);
    expect(root.name).toBe('DeviceInfo');
    expect(root.attributes['version']).toBe('2.0');
  });

  it('extracts flat child text values', () => {
    const root = parseXml(DEVICE_INFO);
    expect(childText(root, 'deviceName')).toBe('Front Gate Cam');
    expect(childText(root, 'model')).toBe('DS-2CD2142FWD-I');
    expect(childText(root, 'serialNumber')).toBe('DS-2CD2142FWD-I20160101AAWR123456789');
    expect(childText(root, 'firmwareVersion')).toBe('V5.5.0');
  });

  it('returns undefined for missing children', () => {
    const root = parseXml(DEVICE_INFO);
    expect(childText(root, 'nope')).toBeUndefined();
  });

  it('parses nested channel lists', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<InputProxyChannelList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<InputProxyChannel version="2.0">
<id>1</id>
<name>Camera 01</name>
<enabled>true</enabled>
</InputProxyChannel>
<InputProxyChannel version="2.0">
<id>2</id>
<name>Camera 02</name>
<enabled>false</enabled>
</InputProxyChannel>
</InputProxyChannelList>`;
    const root = parseXml(xml);
    const channels = childrenByName(root, 'InputProxyChannel');
    expect(channels).toHaveLength(2);
    expect(childText(channels[0]!, 'id')).toBe('1');
    expect(childText(channels[1]!, 'name')).toBe('Camera 02');
  });

  it('handles self-closing tags', () => {
    const xml = '<DeviceInfo version="2.0"><empty /></DeviceInfo>';
    const root = parseXml(xml);
    expect(root.name).toBe('DeviceInfo');
    expect(childByName(root, 'empty')).toBeDefined();
  });

  it('throws on non-XML garbage', () => {
    expect(() => parseXml('not xml at all')).toThrow(/PARSE|root/);
  });
});
