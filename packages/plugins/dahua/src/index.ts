/**
 * @vigilkit/plugin-dahua
 *
 * Dahua CGI vendor plugin: digest authentication, device info, channel
 * enumeration, PTZ control, and stream URL building (RTSP and the unique
 * RTSP-over-WebSocket bridge). Zero runtime dependencies (MD5 is implemented
 * in-package because WebCrypto intentionally omits it).
 */

export { DahuaError, type DahuaErrorCode } from './errors.js';
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
} from './xml.js';
export {
  rtspUrl,
  rtspOverWebSocketUrl,
  snapshotUrl,
  mjpegUrl,
  normalizeChannel,
  type DahuaRtspUrlOptions,
  type DahuaHttpUrlOptions,
  type DahuaWsUrlOptions,
} from './urls.js';
export {
  ptzStartPath,
  ptzStopPath,
  directionToCode,
  zoomToCode,
  type PtzDirection,
  type ZoomDirection,
} from './ptz.js';
export {
  DahuaDevice,
  type DahuaDeviceOptions,
  type DeviceInfo,
  type Channel,
  type PtzCommand,
} from './device.js';
