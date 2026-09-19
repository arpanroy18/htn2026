import type { PongMatch } from './gameStore';

type PongFrameListener = (match: PongMatch) => void;

const listeners = new Set<PongFrameListener>();
let latest: PongMatch | undefined;

export function getPongFrame() {
  return latest;
}

export function emitPongFrame(match: PongMatch) {
  latest = match;
  listeners.forEach((listener) => listener(match));
}

export function clearPongFrame() {
  latest = undefined;
}

export function subscribePongFrame(listener: PongFrameListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
