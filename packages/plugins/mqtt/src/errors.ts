export type MqttErrorCode = 'AUTH' | 'NETWORK' | 'TIMEOUT' | 'PROTOCOL' | 'INVALID_ARGUMENT';

/** Typed error for the MQTT plugin surface. */
export class MqttError extends Error {
  readonly code: MqttErrorCode;

  constructor(code: MqttErrorCode, message: string) {
    super(message);
    this.name = 'MqttError';
    this.code = code;
  }
}
