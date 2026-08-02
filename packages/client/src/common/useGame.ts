import { useSyncExternalStore } from 'react';
import { store, type GameState } from './store.js';

export function useGame(): GameState {
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.state,
  );
}
