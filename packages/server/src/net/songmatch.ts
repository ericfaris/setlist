// ============================================================================
// Same-song matching for runtime substitution. Pure, dependency-free, directly
// unit-testable.
//
// YouTube search will happily hand back a karaoke backing track, a cover, or an
// unrelated song with two words in common. Confidently playing one of those is
// strictly worse than falling back to the host's Skip button, so this module is
// deliberately conservative: a hard reject-list first, then a token-overlap
// score with thresholds tuned to reject rather than guess.
//
// Ranking is where the embeddable-friendly bias lives (NOT the search query,
// which stays a plain "title artist" so YouTube's relevance ranking works):
// auto-generated "<Artist> - Topic" uploads and lyric/audio videos are far less
// likely to carry the per-domain embed allowlist we are trying to escape than
// the official music video is.
// ============================================================================

export interface SongMatchInput {
  title: string;
  artist: string;
}

export interface Candidate {
  videoId: string;
  title: string;
  channelTitle: string;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'feat',
  'ft',
  'featuring',
  'with',
  'official',
  'video',
  'audio',
  'lyrics',
  'lyric',
  'hd',
  'hq',
  '4k',
  'remaster',
  'remastered',
  'version',
  'music',
  'mv',
]);

/**
 * Titles that mean "this is not the recording we asked for". The `live *`
 * entries are two-word phrases on purpose so "Live and Let Die" survives.
 */
const REJECT_PHRASES = [
  'karaoke',
  'instrumental',
  'cover',
  'tribute',
  'reaction',
  'nightcore',
  'remix',
  'sped up',
  'slowed',
  '8 bit',
  'backing track',
  'live at',
  'live from',
  'live in',
  'live performance',
];

export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Whole-word-run containment, so "cover" doesn't match "Undercover". */
function containsPhrase(normalized: string, phrase: string): boolean {
  return ` ${normalized} `.includes(` ${phrase} `);
}

function overlap(a: string[], b: string[]): number {
  if (a.length === 0) return 0;
  const set = new Set(b);
  return a.filter((t) => set.has(t)).length / a.length;
}

export interface CandidateScore {
  accepted: boolean;
  reason: string;
  titleScore: number;
  artistScore: number;
  rank: number;
}

export function scoreCandidate(song: SongMatchInput, candidate: Candidate): CandidateScore {
  const normTitle = normalize(candidate.title);
  const normChannel = normalize(candidate.channelTitle);
  const reject = REJECT_PHRASES.find((p) => containsPhrase(normTitle, p));
  if (reject) {
    return { accepted: false, reason: `rejected: ${reject}`, titleScore: 0, artistScore: 0, rank: 0 };
  }

  const T = tokens(song.title);
  const A = tokens(song.artist);
  const C = tokens(candidate.title);
  const Ch = tokens(candidate.channelTitle);

  const titleScore = overlap(T, C);
  // The channel form is what catches auto-generated "<Artist> - Topic" uploads.
  const artistScore = Math.max(overlap(A, C), overlap(A, Ch));

  // A one-word title can't be matched at 70% — it either matches or it doesn't.
  const titleOk = T.length === 1 ? titleScore === 1 : titleScore >= 0.7;
  const accepted = T.length > 0 && titleOk && artistScore >= 0.5;

  let rank = titleScore + artistScore;
  if (normChannel.endsWith(' topic')) rank += 3;
  if (normTitle.includes('audio') || normTitle.includes('lyric')) rank += 2;
  if (normTitle.includes('official video') || normTitle.includes('music video')) rank -= 1;

  return {
    accepted,
    reason: accepted ? 'accepted' : `below threshold (${titleScore.toFixed(2)}/${artistScore.toFixed(2)})`,
    titleScore,
    artistScore,
    rank,
  };
}

/**
 * Filter search results down to an ordered, capped list of plausible alternate
 * uploads of the same song. Ties keep API result order (Array#sort is stable).
 */
export function pickCandidates(
  song: SongMatchInput,
  candidates: Candidate[],
  opts: { excludeVideoIds: string[]; limit: number },
): Candidate[] {
  const excluded = new Set(opts.excludeVideoIds);
  const seen = new Set<string>();
  const scored: Array<{ candidate: Candidate; rank: number }> = [];

  for (const c of candidates) {
    if (!c.videoId || excluded.has(c.videoId) || seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    const s = scoreCandidate(song, c);
    if (!s.accepted) continue;
    scored.push({ candidate: c, rank: s.rank });
  }

  scored.sort((a, b) => b.rank - a.rank);
  return scored.slice(0, Math.max(0, opts.limit)).map((s) => s.candidate);
}
