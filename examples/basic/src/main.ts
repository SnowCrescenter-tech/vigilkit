import { createPlayer } from 'vigilkit';
import type { Player, PlayerState, PlayerStats, RendererSurface } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { hlsSourcePlugin } from '@vigilkit/plugin-hls';
import { createRenderer, createRendererAsync } from '@vigilkit/renderer';
import { createHevcDemo } from './hevc-demo';
import type { ErrorInfo, HevcDemo } from './hevc-demo';

/** Demo mode, selected via `?source=flv|hls|hevc` on the page URL (default flv). */
type DemoMode = 'flv' | 'hls' | 'hevc';

const WS_URL = `ws://${location.host}/live`;
const HLS_URL = `http://${location.host}/hls/master.m3u8`;

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
const modeEl = requiredElement('mode', HTMLSpanElement);

const mode: DemoMode = resolveMode();

let renderer: RendererSurface;
let player: Player | null = null;
let demoActive = false;

function resolveMode(): DemoMode {
  const source = new URLSearchParams(window.location.search).get('source');
  if (source === 'hls' || source === 'hevc') {
    return source;
  }
  return 'flv';
}

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
  connectBtn.disabled = state === 'connecting' || state === 'playing' || demoActive;
  disconnectBtn.disabled = !demoActive;
}

// ---- engine-based modes (flv / hls) -----------------------------------------

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

function buildHlsPlayer(): Player {
  const instance = createPlayer({
    url: HLS_URL,
    demuxer: 'hls',
    plugins: [hlsSourcePlugin()],
    renderer,
  });
  instance.on('stats', renderStats);
  instance.on('error', renderError);
  return instance;
}

// ---- controls ----------------------------------------------------------------

function connect(): void {
  if (demoActive) {
    return;
  }
  demoActive = true;
  syncButtons('connecting');
  if (mode === 'flv') {
    if (player === null) {
      player = buildPlayer();
    }
    player.play();
  } else if (mode === 'hls') {
    player = buildHlsPlayer();
    player.play();
  } else if (hevcDemo !== null) {
    void hevcDemo.start();
  }
}

function disconnect(): void {
  if (!demoActive) {
    return;
  }
  if (mode === 'hevc') {
    hevcDemo?.stop();
  } else {
    if (player === null) {
      return;
    }
    player.destroy();
    player = null;
    statusEl.textContent = STATE_LABELS.stopped;
  }
  demoActive = false;
  syncButtons('stopped');
}

// ---- boot --------------------------------------------------------------------

let hevcDemo: HevcDemo | null = null;

async function main(): Promise<void> {
  modeEl.textContent = mode;
  renderer = mode === 'flv' ? createRenderer(canvas) : await createRendererAsync(canvas);
  if (mode === 'hevc') {
    hevcDemo = createHevcDemo(renderer, renderError);
  }

  const vigilkitExports: Record<string, unknown> = {
    get player(): Player | null {
      return player;
    },
    supports: {
      webcodecs: typeof VideoDecoder !== 'undefined',
    },
    renderMode: renderer.renderMode,
  };
  if (hevcDemo !== null) {
    vigilkitExports.hevc = hevcDemo.stats;
  }
  Object.defineProperty(window, '__vigilkit', {
    configurable: true,
    value: vigilkitExports,
  });

  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);
  syncButtons('idle');
}

main().catch((err: unknown) => {
  renderError({ code: 'UNSUPPORTED', message: err instanceof Error ? err.message : String(err) });
  syncButtons('error');
});
