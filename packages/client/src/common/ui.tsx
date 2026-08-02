import { useEffect, useState } from 'react';
import { POINT_VALUES, type BoardState, type PublicRoom } from '@setlist/shared';
import { useGame } from './useGame.js';

export const nameOf = (pub: PublicRoom, id: string | null) =>
  (id && pub.players.find((p) => p.id === id)?.displayName) || '???';

/** Live clock for clip countdowns. */
export function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Fraction of the current clip elapsed, reconciled against server clock skew. */
export function useClipProgress(startedAt: number, durationSeconds: number): number {
  const now = useNow();
  const { serverOffset } = useGame();
  const elapsed = now - serverOffset - startedAt;
  return Math.min(1, Math.max(0, elapsed / (durationSeconds * 1000)));
}

export function ClipBar({
  startedAt,
  durationSeconds,
}: {
  startedAt: number;
  durationSeconds: number;
}) {
  const progress = useClipProgress(startedAt, durationSeconds);
  return (
    <div className="clipbar">
      <div style={{ width: `${progress * 100}%` }} />
    </div>
  );
}

/**
 * The Jeopardy grid. Shared by the TV (read-only, huge) and the host's phone
 * (tappable, compact) so the two can never drift apart.
 */
export function BoardGrid({
  board,
  onPick,
}: {
  board: BoardState;
  onPick?: (categoryIndex: number, rowIndex: number) => void;
}) {
  const columns = board.categories.length;
  const rows = Math.max(...board.cells.map((c) => c.rowIndex + 1), POINT_VALUES.length);
  return (
    <div className="board" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      {board.categories.map((cat) => (
        <div key={cat.id} className="cathead">
          {cat.title}
        </div>
      ))}
      {Array.from({ length: rows }).flatMap((_, rowIndex) =>
        board.categories.map((cat, categoryIndex) => {
          const cell = board.cells.find(
            (c) => c.categoryIndex === categoryIndex && c.rowIndex === rowIndex,
          );
          const key = `${cat.id}-${rowIndex}`;
          if (!cell) return <div key={key} className="cell used" />;
          const label = cell.used ? '' : `$${cell.value}`;
          if (onPick && !cell.used) {
            return (
              <button
                key={key}
                className="cell"
                aria-label={`${cat.title} for ${cell.value}`}
                onClick={() => onPick(categoryIndex, rowIndex)}
              >
                {label}
              </button>
            );
          }
          return (
            <div key={key} className={`cell${cell.used ? ' used' : ''}`}>
              {label}
            </div>
          );
        }),
      )}
    </div>
  );
}
