import { MqttClient, type MqttClientOptions } from './client.js';

/**
 * MQTT plugin factory for vigilkit.
 *
 * MQTT is **not** a media source: it is an IoT control / metadata channel
 * (event triggers, device state, telemetry) that accompanies a vigilkit
 * video pipeline. Forcing it into the plugin SDK's `MediaSource` /
 * `DemuxerEvent` shape (which has no 'message' event) would be dishonest, so
 * this package deliberately does **not** implement `MediaSourcePlugin`.
 *
 * `mqttPlugin()` returns a plain, plugin-shaped factory that produces
 * `MqttClient` instances — the standalone MQTT 3.1.1 client from this
 * package. A future integration may map MQTT messages onto demuxer metadata
 * events or player-level event hooks; until then the client is consumed
 * directly by application code (e.g. an IoT dashboard that also renders
 * vigilkit video streams).
 */
export interface MqttPlugin {
  type: 'source';
  id: 'mqtt';
  schemes: Array<'mqtt' | 'mqtts' | 'ws' | 'wss'>;
  /** Creates an MQTT client for the given broker URL. */
  create(url: string, options?: MqttClientOptions): MqttClient;
}

export function mqttPlugin(): MqttPlugin {
  return {
    type: 'source',
    id: 'mqtt',
    schemes: ['mqtt', 'mqtts', 'ws', 'wss'],
    create: (url, options) => new MqttClient(url, options),
  };
}
