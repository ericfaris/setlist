// Small seedable PRNG (mulberry32) so the engine can be driven deterministically
// in tests while still defaulting to real randomness in production.
export interface Rng {
  next(): number; // [0,1)
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: T[]): T[];
}

export function makeRng(seed?: number): Rng {
  let a = (seed ?? (Math.random() * 2 ** 32)) >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number => Math.floor(next() * maxExclusive);
  const pick = <T>(arr: readonly T[]): T => {
    if (arr.length === 0) throw new Error('pick from empty array');
    return arr[int(arr.length)] as T;
  };
  const shuffle = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [arr[i], arr[j]] = [arr[j] as T, arr[i] as T];
    }
    return arr;
  };
  return { next, int, pick, shuffle };
}
