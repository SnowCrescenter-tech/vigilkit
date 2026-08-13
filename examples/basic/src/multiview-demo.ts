// Multi-view performance baseline demo (mode: ?source=multiview&views=N).
//
// Opens N independent WS-FLV streams on one page — one canvas + one
// createPlayer per view — to exercise the multi-stream surface the engine is
// built for (surveillance / IoT dashboards). This is the reference harness for
// the budgets in docs/performance-budget.md: per-view stats are sampled on a
// 1 s interval and folded into a per-view snapshot plus an aggregate status
// line. Aggregate JS heap usage is sampled via
// performance.measureUserAgentSpecificMemory when the API is available
// (cross-origin isolated pages, i.e. the server run with --coop); elsewhere
// the demo reports memoryMB = null.

import { createPlayer } from 'vigilkit';
import type { Player } from 'vigilkit';
import { flvDemuxerPlugin } from '@vigilkit/plugin-flv';
import { wsTransportPlugin } from '@vigilkit/plugin-ws';
import { createRendererAsync } from '@vigilkit/renderer';
import type { ErrorInfo } from './hevc-demo';

export interface MultiviewViewStats {
  fps: number;
  framesDecoded: number;
  errors: number;
  stalledCount: number;
}

export interface MultiviewStats {
  views: MultiviewViewStats[];
  /** Aggregate JS heap usage in MB, or null when the memory API is unavailable. */
  memoryMB: number | null;
}

export interface MultiviewDemo {
  stats(): MultiviewStats;
  stop(): void;
}

export interface MultiviewDemoOptions {
  count: number;
  container: HTMLElement;
  onError: (info: ErrorInfo) => void;
}

/** Chromium-only API; lib.dom has no declaration for it, so narrow it here. */
interface MemoryPerformance extends Performance {
  measureUserAgentSpecificMemory(): Promise<{ bytes: number }>;
}

const STREAM_URL = `ws://${location.host}/live`;
const STATS_INTERVAL_MS = 1000;
/** Re-sample heap memory roughly every 30 s (a measurement itself takes ~20 s). */
const MEMORY_SAMPLE_EVERY = 30;
/** Fixture native resolution (426x240); CSS keeps the 16:9 box regardless. */
const CANVAS_WIDTH = 426;
const CANVAS_HEIGHT = 240;

export async function createMultiviewDemo(options: MultiviewDemoOptions): Promise<MultiviewDemo> {
  const views: MultiviewViewStats[] = [];
  const players: Player[] = [];
  let memoryMB: number | null = null;
  let memoryPending = false;
  let stopped = false;
  let ticks = 0;

  const statusEl = document.getElementById('multiview-status');
  if (statusEl !== null) {
    statusEl.textContent = 'connecting / 连接中';
  }

  for (let i = 0; i < options.count; i += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    options.container.appendChild(canvas);
    // One stats slot per requested view; a failed view stays at zeros and the
    // failure is surfaced through onError, so stats().views.length === count
    // always holds.
    views.push({ fps: 0, framesDecoded: 0, errors: 0, stalledCount: 0 });
    try {
      const renderer = await createRendererAsync(canvas);
      const player = createPlayer({
        url: STREAM_URL,
        demuxer: 'flv',
        plugins: [wsTransportPlugin(), flvDemuxerPlugin()],
        renderer,
        qos: {},
        // Video-only baseline. With audio on, the engine's audio-master
        // resync() (packages/core/src/engine.ts onFirstAudio) re-bases the
        // video clock on the next enqueue; the e2e server bursts the whole
        // clip in ~320 ms, so that re-base lands at the clip tail and the
        // drop-late policy discards the buffered backlog (~260/352 frames),
        // stalling every view. audio:false keeps the clock anchored for the
        // multi-view decode/render budget. See docs/performance-budget.md.
        audio: false,
      });
      player.on('error', (info) => options.onError(info));
      players.push(player);
      player.play();
    } catch (err) {
      options.onError({
        code: 'UNSUPPORTED',
        message: `multiview view ${i}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function sampleMemory(): Promise<void> {
    const memoryApi = (performance as MemoryPerformance).measureUserAgentSpecificMemory;
    if (typeof memoryApi !== 'function' || memoryPending) {
      return;
    }
    memoryPending = true;
    try {
      const measurement = await memoryApi.call(performance);
      memoryMB = measurement.bytes / (1024 * 1024);
    } catch {
      // Unavailable (needs cross-origin isolation, e.g. server --coop).
      memoryMB = null;
    } finally {
      memoryPending = false;
    }
  }

  function updateStatus(): void {
    if (statusEl === null) {
      return;
    }
    let totalFps = 0;
    let totalFrames = 0;
    let totalErrors = 0;
    let totalStalls = 0;
    for (const view of views) {
      totalFps += view.fps;
      totalFrames += view.framesDecoded;
      totalErrors += view.errors;
      totalStalls += view.stalledCount;
    }
    const memory = memoryMB === null ? '' : ` · mem ${memoryMB.toFixed(1)} MB`;
    statusEl.textContent =
      `views ${players.length}/${options.count} · fps ${totalFps} · frames ${totalFrames}` +
      ` · errors ${totalErrors} · stalls ${totalStalls}${memory}`;
  }

  function sample(): void {
    for (let i = 0; i < players.length; i += 1) {
      const view = views[i];
      const stats = players[i]?.getStats();
      if (view === undefined || stats === undefined) {
        continue;
      }
      view.fps = stats.fps;
      view.framesDecoded = stats.framesDecoded;
      view.errors = stats.errors.length;
      view.stalledCount = stats.stalledCount;
    }
    ticks += 1;
    if (ticks % MEMORY_SAMPLE_EVERY === 1) {
      void sampleMemory();
    }
    updateStatus();
  }

  void sampleMemory();
  sample();
  const intervalId = window.setInterval(sample, STATS_INTERVAL_MS);

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    window.clearInterval(intervalId);
    for (const player of players) {
      player.destroy(); // engine destroy also destroys the view's renderer
    }
    for (const canvas of [...options.container.children]) {
      canvas.remove();
    }
    players.length = 0;
    views.length = 0;
    memoryMB = null;
    if (statusEl !== null) {
      statusEl.textContent = 'stopped / 已断开';
    }
  }

  function stats(): MultiviewStats {
    return { views: views.map((view) => ({ ...view })), memoryMB };
  }

  return { stats, stop };
}
