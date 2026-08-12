import { createPlayer } from 'vigilkit';
import type { Player, PlayerEvents, PlayerState, PlayerStats } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { createRenderer } from '@vigilkit/renderer';

type ErrorInfo = PlayerEvents['error'];

const WS_URL = `ws://${location.host}/live`;

const STATE_LABELS: Record<PlayerState, string> = {
  idle: 'idle / 未连接',
  connecting: 'connecting / 连接中',
  playing: 'playing / 播放中',
  paused: 'paused / 已暂停',
  stopped: 'stopped / 已断开',
  error: 'error / 错误',
};

function requiredElement<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`#${id}: expected a <${ctor.name}> element in the DOM`);
  }
  return el;
}

const canvas = requiredElement('screen', HTMLCanvasElement);
const statusEl = requiredElement('status', HTMLSpanElement);
const fpsEl = requiredElement('fps', HTMLSpanElement);
const framesEl = requiredElement('frames', HTMLSpanElement);
const errorsEl = requiredElement('errors', HTMLDivElement);
const connectBtn = requiredElement('connect', HTMLButtonElement);
const disconnectBtn = requiredElement('disconnect', HTMLButtonElement);

const renderer = createRenderer(canvas);

let player: Player | null = null;

function renderStats(stats: PlayerStats): void {
  statusEl.textContent = STATE_LABELS[stats.state];
  fpsEl.textContent = `${Math.round(stats.fps)}`;
  framesEl.textContent = `${stats.framesDecoded} (${stats.framesDropped} dropped)`;
  syncButtons(stats.state);
}

function renderError(error: ErrorInfo): void {
  const stamp = new Date().toLocaleTimeString();
  const line = `[${stamp}] ${error.code}: ${error.message}`;
  const history = errorsEl.textContent ?? '';
  const lines = history ? [...history.split('\n'), line] : [line];
  errorsEl.textContent = lines.slice(-20).join('\n');
}

function syncButtons(state: PlayerState): void {
  connectBtn.disabled = state === 'connecting' || state === 'playing';
  disconnectBtn.disabled = player === null;
}

function buildPlayer(): Player {
  const instance = createPlayer({
    url: WS_URL,
    demuxer: 'flv',
    plugins: [wsTransportPlugin(), flvDemuxerPlugin()],
    renderer,
  });
  instance.on('stats', renderStats);
  instance.on('error', renderError);
  return instance;
}

function connect(): void {
  if (player === null) {
    player = buildPlayer();
  }
  player.play();
}

function disconnect(): void {
  if (player === null) {
    return;
  }
  player.destroy();
  player = null;
  statusEl.textContent = STATE_LABELS.stopped;
  syncButtons('stopped');
}

connectBtn.addEventListener('click', connect);
disconnectBtn.addEventListener('click', disconnect);
syncButtons('idle');

Object.defineProperty(window, '__vigilkit', {
  configurable: true,
  value: {
    get player(): Player | null {
      return player;
    },
    supports: {
      webcodecs: typeof VideoDecoder !== 'undefined',
    },
  },
});
