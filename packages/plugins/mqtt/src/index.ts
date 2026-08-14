/**
 * @vigilkit/plugin-mqtt — zero-dependency MQTT 3.1.1 client over WebSocket
 * for browser / IoT use, implemented from the OASIS MQTT 3.1.1 specification.
 *
 * MQTT is an IoT control/metadata channel, not a media source: this package
 * ships a standalone client (`MqttClient`) plus a pure packet codec, and a
 * plugin-shaped factory (`mqttPlugin`) that creates clients. See
 * `docs/mqtt-manual-qa.md` for real-broker manual QA notes.
 */

export { MqttError, type MqttErrorCode } from './errors.js';
export {
  PacketStream,
  buildConnack,
  buildConnect,
  buildDisconnect,
  buildPingReq,
  buildPingResp,
  buildPubAck,
  buildPubComp,
  buildPubRec,
  buildPubRel,
  buildPublish,
  buildSubAck,
  buildSubscribe,
  buildUnsubAck,
  buildUnsubscribe,
  decodeVarint,
  encodePacket,
  encodeVarint,
  parsePacket,
  type ConnectOptions,
  type MqttPacket,
  type MqttPacketType,
  type PublishOptions,
  type Qos,
  type SubscribeOptions,
  type UnsubscribeOptions,
  type WillMessage,
} from './packet.js';
export {
  MqttClient,
  type MqttClientEvents,
  type MqttClientOptions,
  type MqttClientState,
  type WebSocketConstructor,
} from './client.js';
export { mqttPlugin, type MqttPlugin } from './plugin.js';
