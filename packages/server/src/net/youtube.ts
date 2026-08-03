// ============================================================================
// The one live external call this server makes: a YouTube Data API v3 search
// for an alternate upload of a song that just failed to play.
//
// Injectable seam, mirroring the RoomManager/EngineDeps constructor-injection
// pattern — the real implementation is built in index.ts, tests pass a fake.
// No test ever constructs this with a real key or touches the network.
// ============================================================================

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  channelTitle: string;
}

export interface YouTubeSearchClient {
  /** Resolves to [] on any failure — never throws, never rejects. */
  searchVideos(query: string): Promise<YouTubeSearchResult[]>;
}

export interface CreateYouTubeSearchClientOptions {
  apiKey: string;
  /** Defaults to global fetch (Node 24). Overridable for tests. */
  fetchImpl?: typeof fetch;
  /** A hung search is dead air with buzzers cold — keep this tight. */
  timeoutMs?: number;
  maxResults?: number;
}

const SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESULTS = 10;

/** Untrusted remote JSON — same defensive posture as validateQuestionBank. */
function parseItems(body: unknown): YouTubeSearchResult[] {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: YouTubeSearchResult[] = [];
  for (const raw of items) {
    const item = raw as { id?: { videoId?: unknown }; snippet?: { title?: unknown; channelTitle?: unknown } };
    const videoId = item?.id?.videoId;
    const title = item?.snippet?.title;
    const channelTitle = item?.snippet?.channelTitle;
    if (typeof videoId !== 'string' || !videoId) continue;
    if (typeof title !== 'string') continue;
    if (typeof channelTitle !== 'string') continue;
    out.push({ videoId, title, channelTitle });
  }
  return out;
}

export function createYouTubeSearchClient(
  opts: CreateYouTubeSearchClientOptions,
): YouTubeSearchClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResults = opts.maxResults ?? DEFAULT_MAX_RESULTS;

  return {
    async searchVideos(query: string): Promise<YouTubeSearchResult[]> {
      const url = new URL(SEARCH_URL);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', query);
      url.searchParams.set('type', 'video');
      // Free removal of globally-non-embeddable results. Does NOT catch the
      // per-domain allowlists that caused the failure in the first place.
      url.searchParams.set('videoEmbeddable', 'true');
      url.searchParams.set('maxResults', String(maxResults));
      url.searchParams.set('key', opts.apiKey);
      // Deliberately no videoCategoryId=10: many legitimate lyric and fan
      // uploads are categorized Entertainment.

      try {
        const res = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          console.warn(`[youtube] search failed: HTTP ${res.status}`);
          return [];
        }
        const results = parseItems(await res.json());
        // 100 quota units a call — log every one so usage is visible in logs.
        console.log(`[youtube] search "${query}" -> ${results.length} results`);
        return results;
      } catch (e) {
        console.warn(`[youtube] search failed: ${(e as Error).message}`);
        return [];
      }
    },
  };
}
