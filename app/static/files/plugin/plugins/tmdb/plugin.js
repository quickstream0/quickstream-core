// TMDB Plugin

const apiKey = '7070e2fe1f83238edc3ada49acb2cb25';

const siteBase = 'https://www.themoviedb.org';
const apiBase = 'https://api.themoviedb.org/3';
const imageBase = 'https://image.tmdb.org/t/p';

// =========================
// Helper Functions
// =========================

// Helper function to pick a random item
const getRandomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

function mapToMediaItem(item) {
  const releaseDate = item.release_date || item.first_air_date || null;
  const releaseYear = releaseDate ? parseInt(releaseDate.split('-')[0]) : null;
  const voteAverage = item.vote_average?.toFixed(1);
  const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');
  return {
    id: item.id.toString(),
    adult: item.adult,
    title: item.title || item.name,
    poster_url: item.poster_path
      ? `${imageBase}/w500${item.poster_path}`
      : null,
    backdrop_url: item.backdrop_path
      ? `${imageBase}/w1280${item.backdrop_path}`
      : null,
    overview: item.overview,
    media_type: mediaType,
    release_date: item.release_date || item.first_air_date || null,
    release_year: releaseYear,
    vote_average: item.vote_average ?? 0.0,
    genres: genresFor(mediaType, item.genre_ids),
    images: item.images || null,
    card_style: {
      stacked: {
        top_left: {
          text: voteAverage?.toString(),
          icon: 'rating',
        },
        top_right: {
          text: item.media_type,
        },
        bottom_left: {
          text: releaseYear?.toString(),
        },
        bottom_right: {
          text: item.adult === true ? '18+' : null,
          backgroundColor: item.adult === true ? 'red' : null
        },
      },
    },
  };
}

function mapToMediaItems(items) {
  if (!items || !Array.isArray(items)) return [];
  return items.map(mapToMediaItem);
}

async function getLanguage() {
  const config = await pluginStorage.get() || {};
  if (config.language === 'Default' || !config.language) return 'en-US';
  return config.language;
}

// ISO-639-1 code used to filter localized images (en-US → en).
function langCode(language) {
  return (language || 'en-US').split('-')[0];
}

// Whether the user allows adult titles. TMDb ignores this on endpoints that
// don't support it; where supported it filters server-side.
async function getIncludeAdult() {
  const config = await pluginStorage.get() || {};
  return config.include_adult === true;
}

// Fetches logo images for the first N items in a trending list. Only used for
// the banner category so the hero carousel can show localized logos.
async function enrichBannerWithLogos(items, code, count = 6) {
  if (!items || !items.length) return items;
  const n = Math.min(items.length, count);
  const subset = items.slice(0, n);
  const rest = items.slice(n);

  const enriched = await Promise.all(
    subset.map(async (item) => {
      const mediaType = item.media_type || (item.first_air_date ? 'tv' : 'movie');
      try {
        const resp = await http.get(
          `${apiBase}/${mediaType}/${item.id}/images?include_image_language=${code},en,null&api_key=${apiKey}`
        );
        const logos = (resp.data?.logos || [])
          .map(l => ({
            file_url: l.file_path ? `${imageBase}/w500${l.file_path}` : null,
            aspect_ratio: l.aspect_ratio,
            height: l.height,
            width: l.width,
            iso_639_1: l.iso_639_1,
          }))
          .filter(l => l.file_url);
        return { ...item, images: logos.length ? { logos } : null };
      } catch {
        return { ...item, images: null };
      }
    })
  );
  return [...enriched, ...rest];
}

// Fetches the official square logo for each company via /company/{id} so the
// "Movie Companies" row shows brand artwork instead of random movie backdrops.
async function enrichCompanyLogos(items) {
  if (!items || !Array.isArray(items)) return [];
  const enriched = await Promise.all(
    items.map(async (item) => {
      try {
        const resp = await http.get(
          `${apiBase}/company/${item.id}?api_key=${apiKey}`
        );
        const logo = resp.data?.logo_path;
        if (logo) {
          return {
            ...item,
            poster_url: `${imageBase}/w500${logo}`,
            backdrop_url: null,
          };
        }
        return item;
      } catch {
        return item;
      }
    })
  );
  return enriched;
}

// Fetches a representative backdrop for the first N items of a discover-backed
// row (genres) so their landscape category tiles have artwork.
// Falling back to the item itself keeps the row useful even when enrichment
// fails (e.g. TMDb rate limiting).
async function enrichWithBackdrops(items, mediaType, queryParam, count = 10) {
  if (!items || !Array.isArray(items)) return [];
  const n = Math.min(items.length, count);
  const subset = items.slice(0, n);
  const rest = items.slice(n);
  const language = await getLanguage();
  const includeAdult = await getIncludeAdult();

  const enriched = await Promise.all(
    subset.map(async (item) => {
      try {
        const resp = await http.get(
          `${apiBase}/discover/${mediaType}?${queryParam}=${item.id}&sort_by=popularity.desc&language=${language}&include_adult=${includeAdult}&api_key=${apiKey}`
        );
        const first = (resp.data?.results || [])[0];
        if (first?.backdrop_path) {
          return {
            ...item,
            backdrop_url: `${imageBase}/w1280${first.backdrop_path}`,
          };
        }
        return item;
      } catch {
        return item;
      }
    })
  );
  return [...enriched, ...rest];
}

// =========================
// Reviews
// =========================

function mapReviews(results) {
  return (results || []).map(r => {
    const details = r.author_details || {};
    const avatar = details.avatar_path;
    return {
      author: r.author,
      username: details.username || null,
      avatar_url: avatar
        ? (avatar.startsWith('http') ? avatar : `${imageBase}/w200${avatar}`)
        : null,
      rating: details.rating ?? null,
      content: r.content,
      elapsed_time: r.updated_at || r.created_at || null,
    };
  });
}

// Prefer images in the selected language, then English, then neutral, then all.
function pickLocalizedImages(list, code) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const byLang = list.filter(i => i.iso_639_1 === code);
  if (byLang.length) return byLang;
  const byEnglish = list.filter(i => i.iso_639_1 === 'en');
  if (byEnglish.length) return byEnglish;
  const neutral = list.filter(i => !i.iso_639_1);
  if (neutral.length) return neutral;
  return list;
}

function getGenreEndpoint(id, type) {
  if (type === 'tv') {
    return `/discover/tv?watch_region=US&with_genres=${id}`;
  }
  return `/discover/movie?watch_region=US&with_genres=${id}`;
}

function getWatchProvidersEndpoint(id, type) {
  if (type === 'tv') {
    return `/discover/tv?watch_region=US&with_watch_providers=${id}`;
  }
  return `/discover/movie?watch_region=US&with_watch_providers=${id}`;
}

// =========================
// Genre name index
// =========================
// TMDb list endpoints return only `genre_ids`, so we keep a local
// id → name index (mirroring the selected language) and enrich list items
// with full Genre objects { id, name, type, title, endpoint }.

const GENRE_INDEX_TTL_MS = 6 * 60 * 60 * 1000;
let movieGenresIndex = {};
let tvGenresIndex = {};
let genresIndexedAt = 0;

function indexGenres(genres) {
  const index = {};
  (genres || []).forEach(g => { index[g.id] = g.name; });
  return index;
}

function setGenresIndex(movieGenres, tvGenres) {
  movieGenresIndex = indexGenres(movieGenres);
  tvGenresIndex = indexGenres(tvGenres);
  genresIndexedAt = Date.now();
}

// Fetches both genre lists the first time (or after the TTL expires). Existing
// entries are kept if a refresh fails so enrichment degrades gracefully.
async function ensureGenresIndex() {
  const now = Date.now();
  const loaded = Object.keys(movieGenresIndex).length ||
    Object.keys(tvGenresIndex).length;
  if (loaded && now - genresIndexedAt < GENRE_INDEX_TTL_MS) return;
  const language = await getLanguage();
  try {
    const [m, t] = await Promise.all([
      http.get(`${apiBase}/genre/movie/list?language=${language}&api_key=${apiKey}`),
      http.get(`${apiBase}/genre/tv/list?language=${language}&api_key=${apiKey}`),
    ]);
    setGenresIndex(m.data?.genres, t.data?.genres);
  } catch (e) {
    console.warn(`TMDB: failed to refresh genre index: ${e.message}`);
  }
}

// Map TMDb `genre_ids` to full Genre objects. Returns null when there are no
// ids; unknown ids keep a null name rather than being dropped.
function genresFor(mediaType, genreIds) {
  if (!Array.isArray(genreIds) || genreIds.length === 0) return null;
  const index = mediaType === 'tv' ? tvGenresIndex : movieGenresIndex;
  return genreIds.map((id) => {
    const key = String(id);
    const name = index[key] || null;
    return {
      id: key,
      name,
      type: mediaType,
      title: name,
      endpoint: getGenreEndpoint(id, mediaType),
    };
  });
}

// =========================
// Home Content
// =========================

export async function getHomeContent(page = 1) {
  const language = await getLanguage();
  const includeAdult = await getIncludeAdult();
  const code = langCode(language);
  const tvGenre = getRandomItem(tvGenresIds);
  const movieGenre = getRandomItem(movieGenresIds);
  const tvYear = getRandomItem(yearsList);
  const movieYear = getRandomItem(yearsList);

  const trendingAllEndpoint = '/trending/all/week';
  const popularMoviesEndpoint = '/movie/popular';
  const popularShowsEndpoint = '/tv/popular';
  const featuredMoviesEndpoint = `/discover/movie?primary_release_year=${movieYear}&with_genres=${movieGenre}`;
  const featuredShowsEndpoint = `/discover/tv?first_air_date_year=${tvYear}&with_genres=${tvGenre}`;
  const topRatedMoviesEndpoint = '/movie/top_rated';
  const topRatedShowsEndpoint = '/tv/top_rated';
  const nowPlayingMoviesEndpoint = '/movie/now_playing';
  const airingTodayShowsEndpoint = '/tv/airing_today';
  const upcomingMoviesEndpoint = '/movie/upcoming';
  const onTVShowsEndpoint = '/tv/on_the_air';
  const discoverMoviesEndpoint = '/discover/movie';
  const discoverShowsEndpoint = '/discover/tv';
  const tvProvidersEndpoint = '/watch/providers/tv?watch_region=US';
  const tvGenresEndpoint = '/genre/tv/list';
  const movieGenresEndpoint = '/genre/movie/list';
  const popularAnimeEndpoint = '/discover/tv?with_genres=16&with_origin_country=JP&vote_count.gte=50';

  // Join query params correctly whether the endpoint already has a `?`.
  const fetchList = (endpoint) => http.get(
    `${apiBase}${endpoint}${endpoint.includes('?') ? '&' : '?'}language=${language}&include_adult=${includeAdult}&api_key=${apiKey}`
  );

  const row = (id, title, endpoint, cardStyle, results, data) => ({
    id,
    title,
    endpoint,
    card_style: cardStyle,
    results,
    hasMore: data ? data.page < data.total_pages : false,
    total_pages: data ? data.total_pages : undefined,
    total_results: data ? data.total_results : undefined,
    page: data ? data.page : undefined,
  });

  // Make sure the genre id → name index is warm so `genres` on every item
  // below is enriched. No-op when it was populated recently (6h TTL).
  await ensureGenresIndex();

  switch (page) {
    case 2: {
      const [topRatedMovies, topRatedShows, movieGenreList, tvGenreList, discoverMovies, discoverShows] = await Promise.all([
        fetchList(topRatedMoviesEndpoint),
        fetchList(topRatedShowsEndpoint),
        fetchList(movieGenresEndpoint),
        fetchList(tvGenresEndpoint),
        fetchList(discoverMoviesEndpoint),
        fetchList(discoverShowsEndpoint),
      ]);

      // The genre lists were fetched for the genre rows — reuse them to warm
      // the id → name index used to enrich `genres` on every list item below.
      setGenresIndex(movieGenreList.data?.genres, tvGenreList.data?.genres);

      // Genre tiles (discover-backed with a representative backdrop per genre).
      const movieGenreItems = await enrichWithBackdrops(
        (movieGenreList.data.genres || []).map(g => ({
          id: g.id.toString(),
          title: g.name,
          name: g.name,
          media_type: 'movie',
          endpoint: getGenreEndpoint(g.id, 'movie'),
          card_style: {
            orientation: 'landscape',
            route: 'category',
          },
        })),
        'movie',
        'with_genres',
      );

      const tvGenreItems = await enrichWithBackdrops(
        (tvGenreList.data.genres || []).map(g => ({
          id: g.id.toString(),
          title: g.name,
          name: g.name,
          media_type: 'tv',
          endpoint: getGenreEndpoint(g.id, 'tv'),
          card_style: {
            orientation: 'landscape',
            route: 'category',
          },
        })),
        'tv',
        'with_genres',
      );

      return {
        page: 2,
        hasMore: true,
        total_pages: 3,
        total_results: 18,
        results: [
          row('top_rated_movies', 'Top rated Movies', topRatedMoviesEndpoint, { orientation: 'portrait' }, mapToMediaItems(topRatedMovies.data.results || []), topRatedMovies.data),
          row('top_rated_tv', 'Top rated TV Shows', topRatedShowsEndpoint, { orientation: 'portrait' }, mapToMediaItems(topRatedShows.data.results || []), topRatedShows.data),
          row('movie_genres', 'Movie Genres', movieGenreItems[0]?.endpoint ?? null, { orientation: 'landscape' }, movieGenreItems),
          row('tv_genres', 'TV Genres', tvGenreItems[0]?.endpoint ?? null, { orientation: 'landscape' }, tvGenreItems),
          row('discover_movies', 'Movies', discoverMoviesEndpoint, { orientation: 'portrait' }, mapToMediaItems(discoverMovies.data.results || []), discoverMovies.data),
          row('discover_tv', 'TV Shows', discoverShowsEndpoint, { orientation: 'portrait' }, mapToMediaItems(discoverShows.data.results || []), discoverShows.data),
        ],
      };
    }

    case 3: {
      const [nowPlayingMovies, airingTodayShows, upcomingMovies, onTVShows, tvProviders] = await Promise.all([
        fetchList(nowPlayingMoviesEndpoint),
        fetchList(airingTodayShowsEndpoint),
        fetchList(upcomingMoviesEndpoint),
        fetchList(onTVShowsEndpoint),
        fetchList(tvProvidersEndpoint),
      ]);

      // Streaming networks (from the TV watch providers list, square logos).
      const networksItems = (tvProviders.data.results || [])
        .slice(0, 12)
        .map(p => ({
          id: p.provider_id.toString(),
          title: p.provider_name,
          name: p.provider_name,
          media_type: 'tv',
          poster_url: p.logo_path ? `${imageBase}/w500${p.logo_path}` : null,
          endpoint: getWatchProvidersEndpoint(p.provider_id, 'tv'),
          card_style: {
            orientation: 'square',
            route: 'category',
            show_title: false,
          },
        }));

      // Major production companies (official square logos).
      const companyItems = await enrichCompanyLogos(
        [
          { id: 2, name: 'Walt Disney Pictures' },
          { id: 3, name: 'Pixar' },
          { id: 4, name: 'Paramount Pictures' },
          { id: 5, name: 'Columbia Pictures' },
          { id: 33, name: 'Universal Pictures' },
          { id: 34, name: 'Sony Pictures' },
          { id: 174, name: 'Warner Bros. Pictures' },
          { id: 420, name: 'Marvel Studios' },
          { id: 1632, name: 'Lionsgate' },
          { id: 215, name: 'MGM' },
        ].map(c => ({
          id: c.id.toString(),
          title: c.name,
          name: c.name,
          media_type: 'movie',
          endpoint: `/discover/movie?watch_region=US&with_companies=${c.id}&sort_by=popularity.desc`,
          card_style: {
            orientation: 'square',
            route: 'category',
            show_title: false,
          },
        })),
      );

      return {
        page: 3,
        hasMore: false,
        total_pages: 3,
        total_results: 18,
        results: [
          row('now_playing', 'Now playing', nowPlayingMoviesEndpoint, { orientation: 'portrait' }, mapToMediaItems(nowPlayingMovies.data.results || []), nowPlayingMovies.data),
          row('airing_today', 'Airing today', airingTodayShowsEndpoint, { orientation: 'portrait' }, mapToMediaItems(airingTodayShows.data.results || []), airingTodayShows.data),
          row('upcoming', 'Upcoming Movies', upcomingMoviesEndpoint, { orientation: 'portrait' }, mapToMediaItems(upcomingMovies.data.results || []), upcomingMovies.data),
          row('on_tv', 'On TV', onTVShowsEndpoint, { orientation: 'portrait' }, mapToMediaItems(onTVShows.data.results || []), onTVShows.data),
          row('networks', 'TV Networks', networksItems[0]?.endpoint ?? null, { orientation: 'square', show_title: false }, networksItems),
          row('companies', 'Movie Companies', companyItems[0]?.endpoint ?? null, { orientation: 'square', show_title: false }, companyItems),
        ],
      };
    }

    default: {
      const [trendingAll, popularMovies, popularShows, popularAnime, featuredMovies, featuredShows] = await Promise.all([
        fetchList(trendingAllEndpoint),
        fetchList(popularMoviesEndpoint),
        fetchList(popularShowsEndpoint),
        fetchList(popularAnimeEndpoint),
        fetchList(featuredMoviesEndpoint),
        fetchList(featuredShowsEndpoint),
      ]);

      // Banner category: augment the trending cards with localized logos so
      // the hero carousel can render them. Other rows stay cheap
      // (poster/backdrop-only).
      const trendingItems = await enrichBannerWithLogos(
        trendingAll.data.results || [],
        code,
        trendingAll.data.results.length,
      );

      return {
        page: 1,
        hasMore: true,
        total_pages: 3,
        total_results: 18,
        results: [
          row('trending', 'Trending Now', trendingAllEndpoint, { banner: true }, mapToMediaItems(trendingItems), trendingAll.data),
          row('popular_movies', 'Popular Movies', popularMoviesEndpoint, { orientation: 'portrait' }, mapToMediaItems(popularMovies.data.results || []), popularMovies.data),
          row('popular_tv', 'Popular TV', popularShowsEndpoint, { orientation: 'portrait' }, mapToMediaItems(popularShows.data.results || []), popularShows.data),
          row('popular_anime', 'Popular Anime', popularAnimeEndpoint, { orientation: 'portrait' }, mapToMediaItems(popularAnime.data.results || []), popularAnime.data),
          row('featured_movies', 'Featured Movies', featuredMoviesEndpoint, { orientation: 'landscape' }, mapToMediaItems(featuredMovies.data.results || []), featuredMovies.data),
          row('featured_shows', 'Featured TV Shows', featuredShowsEndpoint, { orientation: 'landscape' }, mapToMediaItems(featuredShows.data.results || []), featuredShows.data),
        ],
      };
    }
  }
}

// =========================
// Media Items
// =========================

export async function getMediaItems(endpoint, page = 1) {
  // The host synthesizes `search:<query>` endpoints when the user taps
  // "See All" on a search rail — delegate to search() so paging matches the
  // search results exactly.
  if (endpoint && endpoint.startsWith('search:')) {
    return search(endpoint.slice('search:'.length), page);
  }

  const language = await getLanguage();
  const includeAdult = await getIncludeAdult();
  const fullEndpoint = endpoint.includes('?') ? `${endpoint}&language=${language}&include_adult=${includeAdult}&page=${page}&api_key=${apiKey}` : `${endpoint}?language=${language}&include_adult=${includeAdult}&page=${page}&api_key=${apiKey}`;

  const response = await http.get(`${apiBase}${fullEndpoint}`);
  await ensureGenresIndex();

  return {
    results: mapToMediaItems(response.data.results || []),
    hasMore: response.data.page < response.data.total_pages,
    total_pages: response.data.total_pages,
    total_results: response.data.total_results,
    page: response.data.page,
    endpoint: endpoint
  };
}

// =========================
// Search
// =========================

export async function search(query, page = 1) {
  if (!query || query.length < 2) {
    return { results: [], hasMore: false, page: 1, total_pages: 0, total_results: 0 };
  }

  const language = await getLanguage();
  const includeAdult = await getIncludeAdult();

  const endpoint = `/search/multi?query=${encodeURIComponent(query)}`;

  const response = await http.get(
    `${apiBase}${endpoint}&language=${language}&include_adult=${includeAdult}&page=${page}&api_key=${apiKey}`
  );
  await ensureGenresIndex();

  return {
    results: mapToMediaItems(response.data.results || []).filter(i => i.media_type !== 'person'),
    hasMore: response.data.page < response.data.total_pages,
    total_pages: response.data.total_pages,
    total_results: response.data.total_results,
    page: response.data.page,
    endpoint: endpoint
  };
}

// =========================
// Details — enriched cast, genre, and full episode data
// =========================

export async function getDetails(id, type, prioritySeason) {
  const language = await getLanguage();
  const code = langCode(language);
  const config = await pluginStorage.get() || {};
  const appendRaw = config.append_to_response;
  const appendList = Array.isArray(appendRaw)
    ? appendRaw
    : String(appendRaw || 'credits,videos,similar,recommendations').split(',');
  const append = [...new Set([
    ...appendList.map(s => String(s).trim()).filter(Boolean),
    'images',
  ])].join(',');

  const [response, reviewsResponse] = await Promise.all([
    http.get(
      `${apiBase}/${type}/${id}?language=${language}&append_to_response=${append}&api_key=${apiKey}`
    ),
    http
      .get(`${apiBase}/${type}/${id}/reviews?language=${language}&api_key=${apiKey}`)
      .catch(e => {
        console.warn(`TMDB: Failed to fetch reviews for ${type}/${id}:`, e.message);
        return null;
      }),
  ]);

  const data = response.data;
  const reviews = mapReviews(reviewsResponse?.data?.results);

  // --- Enriched genres (objects with id + endpoint + name) ---
  await ensureGenresIndex();
  const genres = (data.genres || []).map(g => ({
    id: String(g.id),
    endpoint: getGenreEndpoint(g.id, type),
    name: g.name,
    title: g.name,
    type,
  }));

  // --- Enriched cast (objects with id, name, character, profile_url) ---
  const cast = (data.credits?.cast || []).slice(0, 15).map(c => ({
    id: c.id.toString(),
    name: c.name,
    character: c.character || null,
    profile_url: c.profile_path
      ? `${imageBase}/w154${c.profile_path}`
      : null,
    order: c.order,
  }));

  // --- Director ---
  const director = data.credits?.crew?.find(c => c.job === 'Director');

  // --- Seasons ---
  // The host may hint its last-watched season via the prioritySeason arg. In
  // that case we embed the FULL episode list ONLY for the hinted season so it
  // renders immediately; every other season is stubbed (episode_count only)
  // and lazy-loaded on tap via getSeasonEpisodes(). Hosts that omit the hint
  // keep the legacy all-seasons behavior so older clients are unaffected.
  let seasons = [];
  if (type === 'tv' && data.seasons && Array.isArray(data.seasons)) {
    // Skip season 0 (specials) and other seasons without episodes episodes.
    const seasonList = data.seasons.filter(
      s => s.name !== 'Specials' && s.season_number > 0 && s.episode_count > 0
    );
    const requestedPriority =
      prioritySeason != null && Number(prioritySeason) > 0;
    // If the requested season is not part of this show's list (e.g. a series
    // that premiered at season 2), embed the first real season instead so the
    // initial eager load always carries episodes.
    const priorityNum =
      requestedPriority &&
      seasonList.some(s => s.season_number === Number(prioritySeason))
        ? Number(prioritySeason)
        : (seasonList.length > 0 ? seasonList[0].season_number : 0);
    const hasPriority = requestedPriority && priorityNum > 0;

    const seasonFetches = seasonList.map(async (s) => {
      const base = {
        season_number: s.season_number,
        episode_count: s.episode_count,
        name: s.name,
        overview: s.overview,
        air_date: s.air_date,
        poster_url: s.poster_path
          ? `${imageBase}/w300${s.poster_path}`
          : null,
      };
      if (hasPriority && s.season_number !== priorityNum) {
        return { ...base, episodes: [] };
      }
      try {
        const seasonResp = await http.get(
          `${apiBase}/tv/${id}/season/${s.season_number}?language=${language}&api_key=${apiKey}`
        );
        const episodes = (seasonResp.data.episodes || []).map(e => ({
          episode_number: e.episode_number,
          season_number: s.season_number,
          name: e.name,
          overview: e.overview,
          runtime: e.runtime || null,
          still_url: e.still_path
            ? `${imageBase}/w300${e.still_path}`
            : null,
          air_date: e.air_date,
          vote_average: e.vote_average,
        }));
        return { ...base, episodes };
      } catch (e) {
        console.warn(`TMDB: Failed to fetch season ${s.season_number}:`, e.message);
        return { ...base, episodes: [] };
      }
    });

    seasons = await Promise.all(seasonFetches);
  }
  const title = data.title || data.name;
  const webUrl = `${siteBase}/${type}/${id}`;
  const releaseDate = data.release_date || data.first_air_date || null;
  const releaseYear = releaseDate ? parseInt(releaseDate.split('-')[0]) : null;

  return {
    id: data.id.toString(),
    title: title,
    overview: data.overview,
    tagline: data.tagline,
    poster_url: data.poster_path
      ? `${imageBase}/w500${data.poster_path}`
      : null,
    backdrop_url: data.backdrop_path
      ? `${imageBase}/w1280${data.backdrop_path}`
      : null,
    media_type: type,
    imdb_id: data.imdb_id || data.external_ids?.imdb_id,
    tmdb_id: data.id,
    release_date: releaseDate,
    release_year: releaseYear,
    vote_count: data.vote_count,
    vote_average: data.vote_average,
    original_language: data.original_language,
    runtime: data.runtime || (data.episode_run_time?.[0]) || null,
    status: data.status,
    genres,
    cast,
    director: director ? director.name : null,
    production_companies: (data.production_companies || []).map(p => ({
      endpoint: getWatchProvidersEndpoint(p.id, type),
      name: p.name,
      logo_url: p.logo_path
        ? `${imageBase}/w500${p.logo_path}`
        : null,
      origin_country: p.origin_country || null,
      type: type,
    })),
    images: {
      backdrops: (data.images?.backdrops || []).map(i => ({
        aspect_ratio: i.aspect_ratio,
        height: i.height,
        iso_639_1: i.iso_639_1,
        file_url: i.file_path
          ? `${imageBase}/w500${i.file_path}`
          : null,
        width: i.width
      })),
      posters: pickLocalizedImages(data.images?.posters || [], code).map(i => ({
        aspect_ratio: i.aspect_ratio,
        height: i.height,
        iso_639_1: i.iso_639_1,
        file_url: i.file_path
          ? `${imageBase}/w500${i.file_path}`
          : null,
        width: i.width
      })),
      logos: pickLocalizedImages(data.images?.logos || [], code).map(i => ({
        aspect_ratio: i.aspect_ratio,
        height: i.height,
        iso_639_1: i.iso_639_1,
        file_url: i.file_path
          ? `${imageBase}/w500${i.file_path}`
          : null,
        width: i.width
      })),
    },
    trailers: (data.videos?.results || [])
      .filter(v => v.site === 'YouTube' && v.type !== 'Behind the Scenes' && v.type !== 'Featurette')
      .map(v => ({
        name: v.name,
        key: v.key,
        site: v.site,
        type: v.type,
        url: `https://www.youtube.com/watch?v=${v.key}`,
        image_url: `https://i3.ytimg.com/vi/${v.key}/mqdefault.jpg`
      })),
    recommendations: [
      {
        id: 'similar',
        title: type === 'tv' ? 'Similar Shows' : 'Similar Movies',
        card_style: {
          orientation: 'portrait',
        },
        results: mapToMediaItems(data.similar?.results || []),
      },
      {
        id: 'recommendations',
        title: 'You Might Also Like',
        card_style: {
          orientation: 'portrait',
        },
        results: mapToMediaItems(data.recommendations?.results || []),
      },
    ],
    seasons,
    reviews,
    extra: {
      web_url: webUrl,
      share_text: `Checkout the ${type === 'tv' ? 'series' : 'movie'} ${title}!\n\n${webUrl}`,
    },
    adult: data.adult
  };
}

// =========================
// Get Season Episodes (lazy-load when user taps a season)
// =========================

export async function getSeasonEpisodes(tvId, seasonNumber) {
  const language = await getLanguage();

  try {
    const response = await http.get(
      `${apiBase}/tv/${tvId}/season/${seasonNumber}?language=${language}&api_key=${apiKey}`
    );

    return (response.data.episodes || []).map(e => ({
      episode_number: e.episode_number,
      season_number: Number(seasonNumber),
      name: e.name,
      overview: e.overview,
      runtime: e.runtime || null,
      still_url: e.still_path
        ? `${imageBase}/w300${e.still_path}`
        : null,
      air_date: e.air_date,
      vote_average: e.vote_average,
    }));
  } catch (e) {
    console.warn(`TMDB: Failed to fetch season ${seasonNumber}:`, e.message);
    return [];
  }
}

// =========================
// Streams (capability: source) — providers shape, contract v1
// =========================
//
// TMDb ships a usable source out of the box: it aggregates PrimeSrc (real,
// lazy servers) so users do not need to install/pair a separate source plugin.
// PrimeWire embeds are also pulled in when the PrimeWire plugin is installed,
// extracting each embed through the shared Open Extractors plugin.
// All cross-plugin calls go through `pluginManager.call` (the dependency must
// be declared in this plugin's manifest with the allowed methods listed).

export async function getStreams(metadata) {
  const providers = [];

  // --- Path 1: VixSrc (most reliable — listed first) --------------------
  if (await pluginManager.isInstalled('com.quickstream.plugin.vixsrc')) {
    try {
      const result = await pluginManager.call(
        'com.quickstream.plugin.vixsrc',
        'getStreams',
        [metadata]
      );
      const vixSrc = (result?.providers || []).find(
        (p) => p.id === 'com.quickstream.plugin.vixsrc'
      );
      if (vixSrc) {
        providers.push({
          id: 'com.quickstream.plugin.vixsrc',
          name: 'VixSrc',
          logo: vixSrc.logo ?? null,
          reliable: vixSrc.reliable ?? true,
          // Servers arrive as lazy stubs — getStreamSources() below expands
          // the one the user picks by delegating back to VixSrc.
          servers: vixSrc.servers || [],
        });
        console.log(
          `TMDB: got ${(vixSrc.servers || []).length} servers from VixSrc`
        );
      }
    } catch (e) {
      console.warn('TMDB: VixSrc streams failed:', e.message);
    }
  } else {
    console.warn('TMDB: VixSrc plugin not installed — use the plugin store');
  }

  // --- Path 2: InsertUnit (direct HLS/DASH, inline servers) ------------
  // Sources arrive fully inline (no lazy expansion needed), so nothing is
  // forwarded from getStreamSources() below for this provider.
  if (await pluginManager.isInstalled('com.quickstream.plugin.insertunit')) {
    try {
      const result = await pluginManager.call(
        'com.quickstream.plugin.insertunit',
        'getStreams',
        [metadata]
      );
      const insertUnit = (result?.providers || []).find(
        (p) => p.id === 'com.quickstream.plugin.insertunit'
      );
      if (insertUnit) {
        providers.push({
          id: 'com.quickstream.plugin.insertunit',
          name: 'InsertUnit',
          logo: insertUnit.logo ?? null,
          reliable: insertUnit.reliable ?? true,
          servers: insertUnit.servers || [],
        });
        console.log(
          `TMDB: got ${(insertUnit.servers || []).length} servers from InsertUnit`
        );
      }
    } catch (e) {
      console.warn('TMDB: InsertUnit streams failed:', e.message);
    }
  } else {
    console.warn('TMDB: InsertUnit plugin not installed — use the plugin store');
  }

  // --- Path 3: PrimeSrc (lazy servers, real provider) -----------------
  if (await pluginManager.isInstalled('com.quickstream.plugin.primesrc')) {
    try {
      const result = await pluginManager.call(
        'com.quickstream.plugin.primesrc',
        'getStreams',
        [metadata]
      );
      const primeSrc = (result?.providers || []).find(
        (p) => p.id === 'com.quickstream.plugin.primesrc'
      );
      if (primeSrc) {
        providers.push({
          id: 'com.quickstream.plugin.primesrc',
          name: 'PrimeSrc',
          logo: primeSrc.logo ?? null,
          reliable: primeSrc.reliable ?? true,
          // Servers arrive as lazy stubs — getStreamSources() below expands
          // the one the user picks by delegating back to PrimeSrc.
          servers: primeSrc.servers || [],
        });
        console.log(
          `TMDB: got ${(primeSrc.servers || []).length} servers from PrimeSrc`
        );
      }
    } catch (e) {
      console.warn('TMDB: PrimeSrc streams failed:', e.message);
    }
  } else {
    console.warn('TMDB: PrimeSrc plugin not installed — no bundled sources');
  }

  // // --- Path 4 (optional): PrimeWire embeds via Open Extractors ---------
  // // PrimeWire is still demo
  // if (await pluginManager.isInstalled('com.rand.primewire')) {
  //   try {
  //     const embeds = await pluginManager.call(
  //       'com.rand.primewire',
  //       'getEmbeds',
  //       [metadata]
  //     );
  //     console.log(`TMDB: Got ${(embeds || []).length} embeds from PrimeWire`);

  //     const servers = [];
  //     for (const embed of embeds || []) {
  //       try {
  //         const server = await extractEmbedViaOpenExtractors(embed);
  //         if (server?.sources?.length) servers.push(server);
  //       } catch (e) {
  //         console.warn(`TMDB: failed to extract "${embed.name}":`, e.message);
  //       }
  //     }

  //     if (servers.length) {
  //       providers.push({
  //         id: 'primewire-via-tmdb',
  //         name: 'PrimeWire (via TMDB)',
  //         logo: null,
  //         reliable: true,
  //         servers,
  //       });
  //     }
  //   } catch (e) {
  //     console.warn('TMDB: PrimeWire streams failed:', e.message);
  //   }
  // }

  return { providers };
}

/**
 * Expands one lazy server. TMDb's own source list only marks servers as
 * lazy when they came from PrimeSrc, so forward those to PrimeSrc and let
 * everything else fall through empty for the player to move on.
 */
export async function getStreamSources(metadata, providerId, serverId) {
  if (providerId === 'com.quickstream.plugin.vixsrc') {
    try {
      return await pluginManager.call(
        'com.quickstream.plugin.vixsrc',
        'getStreamSources',
        [metadata, providerId, serverId]
      );
    } catch (e) {
      console.error('TMDB: VixSrc stream sources failed:', e.message);
    }
  }
  if (providerId === 'com.quickstream.plugin.primesrc') {
    try {
      return await pluginManager.call(
        'com.quickstream.plugin.primesrc',
        'getStreamSources',
        [metadata, providerId, serverId]
      );
    } catch (e) {
      console.error('TMDB: PrimeSrc stream sources failed:', e.message);
    }
  }
  return { sources: [], subtitles: [] };
}

const genres = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
};

const movieGenresIds = [
  28,
  12,
  16,
  35,
  80,
  99,
  18,
  10751,
  14,
  36,
  27,
  10402,
  9648,
  10749,
  878,
  10770,
  53,
  10752,
  37,
];

const tvGenresIds = [
  10759,
  16,
  35,
  80,
  99,
  18,
  10751,
  10762,
  9648,
  10763,
  10764,
  10765,
  10766,
  10767,
  10768,
  37,
];

const yearsList = [
  '2026',
  '2025',
  '2024',
  '2023',
  '2022',
  '2021',
  '2020',
  '2019',
  '2018',
  '2017',
  '2016',
  '2015',
  '2014',
  '2013',
  '2012',
  '2011',
  '2010',
  '2009',
  '2008',
  '2007',
  '2006',
  '2005',
  '2004',
  '2003',
  '2002',
  '2001',
  '2000',
  '1999',
  '1998',
  '1997',
  '1996',
  '1995',
  '1994',
  '1993',
  '1992',
  '1991',
  '1990',
  '1989',
  '1988',
  '1987',
  '1986',
  '1985',
  '1984',
  '1983',
  '1982',
  '1981',
  '1980',
  '1979',
  '1978',
  '1977',
  '1976',
  '1975',
  '1974',
  '1973',
  '1972',
  '1971',
  '1970',
  '1969',
  '1968',
  '1967',
  '1966',
  '1965',
  '1964',
  '1963',
  '1962',
  '1961',
  '1960',
];
