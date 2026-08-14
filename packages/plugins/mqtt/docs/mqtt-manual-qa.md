# @vigilkit/plugin-mqtt — Manual QA against a real broker

CI covers the packet codec (pure, deterministic) and the client with a mock
WebSocket. This document describes the manual QA that proves the client
against **real brokers** — the last mile no mock can fake: keepalive timing,
broker-side session behavior, and the QoS 2 handshake with a third-party
implementation.

## Prerequisites

- A Node 20+ runtime with the package built (`pnpm --filter @vigilkit/plugin-mqtt build`).
- A broker. Two options:

  **Public broker (zero setup):** EMQX's public test broker
  `wss://broker.emqx.io:8084/mqtt` (or `ws://broker.emqx.io:8083/mqtt`).
  Anything you publish there is visible to anyone — never send secrets.

  **Local Mosquitto (recommended for QoS 2 + auth testing):**
  `mosquitto.conf` with websockets enabled:

  ```conf
  listener 9001
  protocol websockets
  allow_anonymous true
  ```

  Start it: `mosquitto -c mosquitto.conf`, broker at `ws://127.0.0.1:9001`.

## Script 1 — connect + subscribe/publish round-trip

```ts
import { MqttClient } from '@vigilkit/plugin-mqtt';

const url = 'ws://127.0.0.1:9001'; // or 'wss://broker.emqx.io:8084/mqtt'
const client = new MqttClient(url, { clientId: `qa-${Date.now()}`, keepaliveSec: 30 });

client.on('message', (topic, payload) => {
  console.log(`message ${topic}: ${new TextDecoder().decode(payload)}`);
  client.close();
});
client.on('close', () => console.log('closed'));
client.on('error', (e) => console.error('error', e.code, e.message));

await client.connect();
console.log('connected');
await client.subscribe(['qa/echo']);
await client.publish('qa/echo', `hello at ${Date.now()}`); // QoS 0
```

Expect: `connected`, then one `message qa/echo: hello at …`, then `closed`.

## Script 2 — QoS 2 flow (PUBREC → PUBREL → PUBCOMP)

```ts
const client = new MqttClient(url, { clientId: `qa-qos2-${Date.now()}` });
client.on('message', (topic, payload) => {
  console.log(`got ${topic} = ${new TextDecoder().decode(payload)}`);
  client.close();
});
await client.connect();
const codes = await client.subscribe([{ topic: 'qa/qos2', qos: 2 }]);
console.log('granted qos:', codes); // expect [2]
await client.publish('qa/qos2', 'exactly-once', { qos: 2 });
```

Verify with `mosquitto_sub -t 'qa/#' -v -q 2` on the broker side that the
message arrives **exactly once**, even if you kill the subscriber and
reconnect mid-handshake. With the EMQX public broker, watch the EMQX
dashboard's "QoS 2 messages received" counter move by exactly 1.

## Script 3 — keepalive / ping

With `keepaliveSec: 4`, connect and leave the client idle for ~30 seconds
with debug logging of `ws` traffic (browser devtools Network tab, or a
`WebSocketCtor` wrapper that logs sends). Expect a PINGREQ roughly every 2 s
and a matching PINGRESP from the broker. Kill the broker (Ctrl-C on
Mosquitto) and expect the client to emit `error` with code `NETWORK`
(ping timeout) followed by `close` within ~8 s.

## Script 4 — auth rejection

With Mosquitto, add a user (`mosquitto_passwd`), set
`allow_anonymous false`, then connect with a wrong password. Expect
`connect()` to reject with an `MqttError` whose `code` is `'AUTH'` (CONNACK
return code 4/5). Retry with the correct credentials and expect success.

## Script 5 — will message

Connect with `will: { topic: 'qa/will', payload: 'gone', qos: 1, retain: true }`,
subscribe another client to `qa/will`, then kill the first client's process
without sending DISCONNECT (Ctrl-C). Expect the subscriber to receive
`gone` within one keepalive period.

## Reconnect note

This client does **not** auto-reconnect (like `ws-transport`, reconnect is a
deliberate opt-in that the caller implements). In production, wrap
`connect()` in a backoff loop keyed on the `close`/`error` events and
re-subscribe after `connect()` resolves. For an always-on IoT edge device,
run one `MqttClient` per broker and reconnect with exponential backoff (start
at 1 s, cap at 30 s, full jitter).

## Browser note

The package has zero dependencies and uses only the native WebSocket API.
In the browser, `binaryType = 'arraybuffer'` is set on the socket, so
messages arrive as `Uint8Array` views — no polyfills, no bundler plugins.
`MqttClient` also runs in Node (global `WebSocket` exists in Node 22+; in
Node 20 pass a WebSocket implementation via `WebSocketCtor`).
