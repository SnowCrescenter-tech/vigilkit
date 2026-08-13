import { createPlayer } from 'vigilkit';
import type { Player, PlayerState, PlayerStats, RendererSurface, SoftVideoDecoderFactory } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { hlsSourcePlugin } from '@vigilkit/plugin-hls';
import { createRenderer, createRendererAsync } from '@vigilkit/renderer';
import { createHevcSoftFactory } from '@vigilkit/plugin-hevc-wasm';
import { createHevcDemo } from './hevc-demo';
import type { ErrorInfo, HevcDemo } from './hevc-demo';
import { createMultiviewDemo } from './multiview-demo';
import type { MultiviewDemo } from './multiview-demo';
import { createWhepPlayer } from './whep-demo';

/**
 * Demo mode, selected via `?source=flv|hls|hevc|hevc-flv|hevc-hls|whep|multiview`
 * on the page URL (default flv). `hevc-flv` / `hevc-hls` play HEVC end-to-end
 * through createPlayer (WS-FLV Enhanced-RTMP and TS-HEVC demuxers + the
 * libde265 soft decoder); `multiview` plays `views` independent WS-FLV
 * streams in a CSS grid (default 4) — see multiview-demo.ts.
 */
type DemoMode = 'flv' | 'hls' | 'hevc' | 'hevc-flv' | 'hevc-hls' | 'whep' | 'multiview';

const WS_URL = `ws://${location.host}/live`;
const HLS_URL = `http://${location.host}/hls/master.m3u8`;
const HEVC_FLV_WS_URL = `ws://${location.host}/live-hevc`;
const HEVC_HLS_URL = `http://${location.host}/hls/hevc.m3u8`;
const DEFAULT_VIEW_COUNT = 4;

/** sha256-pinned vendored libde265 artifacts (see vendor/README.md). */
const HEVC_SOFT_OPTIONS = {
  esmUrl: '/vendor/libde265-esm.js',
  wasmUrl: '/vendor/libde265.wasm',
  sha256: '440c6bbc60af222e72141583ce583423b0b8dd3fe0b53e823fa2e99988eca5b8',
  esmSha256: '3d431114c87569ff71b3a8f434c3a67ba8239fbef18cea80e2f22e5049d7b0ab',
} as const;

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

let renderer: RendererSurface | null = null;
let player: Player | null = null;
let hevcDemo: HevcDemo | null = null;
let multiviewDemo: MultiviewDemo | null = null;
let demoActive = false;

function resolveMode(): DemoMode {
  const source = new URLSearchParams(window.location.search).get('source');
  if (
    source === 'hls' ||
    source === 'hevc' ||
    source === 'hevc-flv' ||
    source === 'hevc-hls' ||
    source === 'whep' ||
    source === 'multiview'
  ) {
    return source;
  }
  return 'flv';
}

/** `?views=N` for multiview mode; any non-positive/invalid value falls back to 4. */
function resolveViewCount(): number {
  const raw = new URLSearchParams(window.location.search).get('views');
  const parsed = raw === null ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_VIEW_COUNT;
}

function requireRenderer(): RendererSurface {
  if (renderer === null) {
    throw new Error('renderer not initialized');
  }
  return renderer;
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
    renderer: requireRenderer(),
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
    renderer: requireRenderer(),
  });
  instance.on('stats', renderStats);
  instance.on('error', renderError);
  return instance;
}

// ---- engine-based HEVC modes (hevc-flv / hevc-hls) --------------------------

/** libde265 factory, loaded once and shared across player instances. */
let hevcSoftFactory: SoftVideoDecoderFactory | null = null;

async function buildHevcPlayer(): Promise<Player> {
  const isFlv = mode === 'hevc-flv';
  hevcSoftFactory ??= await createHevcSoftFactory(HEVC_SOFT_OPTIONS);
  const instance = createPlayer({
    url: isFlv ? HEVC_FLV_WS_URL : HEVC_HLS_URL,
    demuxer: isFlv ? 'flv' : 'hls',
    plugins: isFlv ? [wsTransportPlugin(), flvDemuxerPlugin()] : [hlsSourcePlugin()],
    softDecoder: { factory: hevcSoftFactory },
    renderer: requireRenderer(),
  });
  instance.on('stats', renderStats);
  instance.on('error', renderError);
  return instance;
}

// ---- multiview mode -----------------------------------------------------------

/** Creates the multi-view demo; the page's __vigilkit.multiview getter exposes it. */
async function startMultiview(): Promise<void> {
  try {
    const container = requiredElement('multiview', HTMLDivElement);
    const demo = await createMultiviewDemo({
      count: resolveViewCount(),
      container,
      onError: renderError,
    });
    multiviewDemo = demo;
    syncButtons('playing');
  } catch (err) {
    demoActive = false;
    renderError({ code: 'UNSUPPORTED', message: err instanceof Error ? err.message : String(err) });
    syncButtons('error');
  }
}

// ---- controls ----------------------------------------------------------------

async function connect(): Promise<void> {
  if (demoActive) {
    return;
  }
  demoActive = true;
  syncButtons('connecting');
  if (mode === 'multiview') {
    void startMultiview();
  } else if (mode === 'flv') {
    if (player === null) {
      player = buildPlayer();
    }
    player.play();
  } else if (mode === 'hls') {
    player = buildHlsPlayer();
    player.play();
  } else if (mode === 'hevc-flv' || mode === 'hevc-hls') {
    try {
      player = await buildHevcPlayer();
      player.play();
    } catch (err) {
      demoActive = false;
      renderError({ code: 'UNSUPPORTED', message: err instanceof Error ? err.message : String(err) });
      syncButtons('error');
    }
  } else if (mode === 'whep') {
    player = createWhepPlayer(requireRenderer(), renderStats, renderError);
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
  } else if (mode === 'multiview') {
    multiviewDemo?.stop();
    multiviewDemo = null;
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

async function main(): Promise<void> {
  modeEl.textContent = mode;
  const vigilkitExports: Record<string, unknown> = {
    get player(): Player | null {
      return player;
    },
    supports: {
      webcodecs: typeof VideoDecoder !== 'undefined',
    },
    get multiview(): MultiviewDemo | undefined {
      return multiviewDemo ?? undefined;
    },
  };
  Object.defineProperty(window, '__vigilkit', {
    configurable: true,
    value: vigilkitExports,
  });

  if (mode === 'multiview') {
    demoActive = true;
    syncButtons('connecting');
    await startMultiview();
  } else {
    renderer = mode === 'flv' ? createRenderer(canvas) : await createRendererAsync(canvas);
    vigilkitExports.renderMode = renderer.renderMode;
    if (mode === 'hevc') {
      hevcDemo = createHevcDemo(renderer, renderError);
      vigilkitExports.hevc = hevcDemo.stats;
    }
  }

  connectBtn.addEventListener('click', connect);
  disconnectBtn.addEventListener('click', disconnect);
  syncButtons(demoActive ? 'playing' : 'idle');
}

main().catch((err: unknown) => {
  renderError({ code: 'UNSUPPORTED', message: err instanceof Error ? err.message : String(err) });
  syncButtons('error');
});
