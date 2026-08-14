/**
 * @vigilkit/plugin-uniview
 *
 * Uniview (UNV) LightAPI vendor plugin: digest authentication, device info,
 * channel enumeration, PTZ control, and stream URL building (RTSP IPC/NVR,
 * MJPEG, snapshot). Zero runtime dependencies (MD5 is implemented in-package
 * because WebCrypto intentionally omits it).
 */

export { UniviewError, type UniviewErrorCode } from './errors.js';
export { md5 } from './md5.js';
export {
  generateAuthorization,
  parseDigestChallenge,
  type DigestChallenge,
} from './digest.js';
export {
  parseJsonResponse,
  getString,
  getNumber,
  getBoolean,
} from './json.js';
export {
  rtspUrl,
  snapshotUrl,
  mjpegUrl,
  normalizeChannel,
  type UniviewStream,
  type UniviewRtspUrlOptions,
  type UniviewHttpUrlOptions,
  type UniviewMjpegUrlOptions,
} from './urls.js';
export {
  ptzPath,
  ptzBody,
  ptzStartPath,
  directionToVector,
  zoomToVector,
  type PtzVector,
  type PtzDirection,
  type ZoomDirection,
} from './ptz.js';
export {
  UniviewDevice,
  type UniviewDeviceOptions,
  type DeviceInfo,
  type Channel,
  type PtzCommand,
} from './device.js';
