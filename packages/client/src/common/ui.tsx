import type { PublicRoom } from '@setlist/shared';

export const nameOf = (pub: PublicRoom, id: string | null) =>
  (id && pub.players.find((p) => p.id === id)?.displayName) || '???';
