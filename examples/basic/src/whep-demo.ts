// WHEP demo assembly (?source=whep&endpoint=<resource-url>).
//
// The WHEP source plugin POSTs an SDP offer to the endpoint, adopts the
// server's answer, and hands decoded frames to the renderer. The endpoint is
// taken from `?endpoint=`; without it the placeholder below is used (no
// server, so the demo surfaces a transport error until a real URL is given).

import { createPlayer } from 'vigilkit';
import type { Player, PlayerStats, RendererSurface } from 'vigilkit';
import { whepSourcePlugin } from '@vigilkit/plugin-whep';
import type { ErrorInfo } from './hevc-demo';

/** Documented placeholder; replace with a WHEP server URL (mediamtx, SRS, ...). */
export const WHEP_DEFAULT_ENDPOINT = 'https://example.invalid/whep';

export function createWhepPlayer(
  renderer: RendererSurface,
  onStats: (stats: PlayerStats) => void,
  onError: (error: ErrorInfo) => void,
): Player {
  const endpoint =
    new URLSearchParams(window.location.search).get('endpoint') ?? WHEP_DEFAULT_ENDPOINT;
  const player = createPlayer({
    url: endpoint,
    demuxer: 'whep',
    plugins: [whepSourcePlugin()],
    renderer,
  });
  player.on('stats', onStats);
  player.on('error', onError);
  return player;
}
