import { Engine } from './engine.js';
import type { Player, PlayerOptions } from './types.js';

export function createPlayer(options: PlayerOptions): Player {
  return new Engine(options);
}
