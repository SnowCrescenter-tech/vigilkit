/**
 * @vigilkit/plugin-hikvision
 *
 * Hikvision ISAPI plugin: digest authentication, device discovery, channel
 * enumeration, PTZ control, and stream URL building. Zero runtime dependencies
 * (MD5 is implemented in-package because WebCrypto intentionally omits it).
 */

export { HikvisionError, type HikvisionErrorCode } from './errors.js';
export { md5 } from './md5.js';
export {
  generateAuthorization,
  parseDigestChallenge,
  type DigestChallenge,
} from './digest.js';
export {
  parseXml,
  childByName,
  childrenByName,
  childText,
  type XmlElement,
} from './isapi.js';
export {
  rtspUrl,
  httpPreviewUrl,
  snapshotUrl,
  normalizeChannel,
  type StreamUrlOptions,
} from './urls.js';
export {
  move,
  zoom,
  stop,
  ptzDataXml,
  ptzControlPath,
  ptzPresetPath,
  type PtzDirection,
  type ZoomDirection,
  type PtzMove,
} from './ptz.js';
export {
  HikvisionDevice,
  type HikvisionDeviceOptions,
  type DeviceInfo,
  type Channel,
} from './device.js';
