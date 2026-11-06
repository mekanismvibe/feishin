import i18n from '/@/i18n/i18n';
import { maCommand } from '/@/renderer/api/music-assistant/music-assistant-api';
import { getServerUrl, normalizeServerUrl } from '/@/renderer/utils/normalize-server-url';
import {
    maId,
    maNormalize,
    maRef,
    maUri,
} from '/@/shared/api/music-assistant/music-assistant-normalize';
import {
    MAAlbum,
    MAArtist,
    MAGenre,
    MAPlayer,
    MAPlayerQueue,
    MAPlaylist,
    MAQueueItem,
    MATrack,
} from '/@/shared/api/music-assistant/music-assistant-types';
import { sortAlbumList, sortSongList } from '/@/shared/api/utils';
import { toast } from '/@/shared/components/toast/toast';
import {
    AlbumArtistListSort,
    AlbumListSort,
    ArtistListSort,
    InternalControllerEndpoint,
    JukeboxControlQuery,
    JukeboxControlResponse,
    LibraryItem,
    PlaylistListSort,
    ServerListItemWithCredential,
    Song,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

type Server = null | ServerListItemWithCredential;

const ALL = 100_000;

const ALBUM_SORT: Partial<Record<AlbumListSort, string>> = {
    [AlbumListSort.ALBUM_ARTIST]: 'album_artist_name',
    [AlbumListSort.ARTIST]: 'album_artist_name',
    [AlbumListSort.NAME]: 'name',
    [AlbumListSort.PLAY_COUNT]: 'play_count',
    [AlbumListSort.RANDOM]: 'random',
    [AlbumListSort.RECENTLY_ADDED]: 'timestamp_added',
    [AlbumListSort.RECENTLY_PLAYED]: 'last_played',
    [AlbumListSort.RELEASE_DATE]: 'year',
    [AlbumListSort.SORT_NAME]: 'sort_name',
    [AlbumListSort.YEAR]: 'year',
};

const SONG_SORT: Partial<Record<SongListSort, string>> = {
    [SongListSort.ALBUM_ARTIST]: 'track_artist_name',
    [SongListSort.ARTIST]: 'track_artist_name',
    [SongListSort.DURATION]: 'duration',
    [SongListSort.NAME]: 'name',
    [SongListSort.PLAY_COUNT]: 'play_count',
    [SongListSort.RANDOM]: 'random',
    [SongListSort.RECENTLY_ADDED]: 'timestamp_added',
    [SongListSort.RECENTLY_PLAYED]: 'last_played',
    [SongListSort.SORT_NAME]: 'sort_name',
};

const ARTIST_SORT: Partial<Record<AlbumArtistListSort | ArtistListSort, string>> = {
    [AlbumArtistListSort.NAME]: 'sort_name',
    [AlbumArtistListSort.PLAY_COUNT]: 'play_count',
    [AlbumArtistListSort.RANDOM]: 'random',
    [AlbumArtistListSort.RECENTLY_ADDED]: 'timestamp_added',
};

const PLAYLIST_SORT: Partial<Record<PlaylistListSort, string>> = {
    [PlaylistListSort.NAME]: 'sort_name',
    [PlaylistListSort.UPDATED_AT]: 'timestamp_modified',
};

const orderBy = (field: string | undefined, order?: SortOrder) =>
    !field || field === 'random' ? field : `${field}${order === SortOrder.DESC ? '_desc' : ''}`;

const MEDIA_TYPE: Partial<Record<LibraryItem, string>> = {
    [LibraryItem.ALBUM]: 'album',
    [LibraryItem.ALBUM_ARTIST]: 'artist',
    [LibraryItem.ARTIST]: 'artist',
    [LibraryItem.GENRE]: 'genre',
    [LibraryItem.PLAYLIST]: 'playlist',
    [LibraryItem.PLAYLIST_SONG]: 'track',
    [LibraryItem.QUEUE_SONG]: 'track',
    [LibraryItem.SONG]: 'track',
};

const IMAGE_SIZES = [80, 160, 256, 512, 1024];

const paginate = <T>(items: T[], startIndex = 0, limit?: number) => ({
    items: items.slice(startIndex, limit ? startIndex + limit : undefined),
    startIndex,
    totalRecordCount: items.length,
});

const libraryItems = <T>(
    server: Server,
    mediaType: string,
    args: {
        [key: string]: unknown;
        favorite?: boolean;
        limit?: number;
        offset?: number;
        order_by?: string;
        search?: string;
    },
) =>
    maCommand<T[]>(server, `music/${mediaType}/library_items`, {
        ...args,
        // MA treats favorite=false as "disliked", so only ever send true
        favorite: args.favorite || undefined,
        limit: args.limit || ALL,
        search: args.search || undefined,
    });

const albumTracks = async (server: Server, albumIds: string[]) =>
    (
        await Promise.all(
            albumIds.map((id) =>
                maCommand<MATrack[]>(server, 'music/albums/album_tracks', maRef(id)),
            ),
        )
    ).flat();

const artistTracks = (server: Server, artistId: string) =>
    maCommand<MATrack[]>(server, 'music/artists/artist_tracks', maRef(artistId));

const songs = (server: Server, tracks: MATrack[]) =>
    tracks.map((track) => maNormalize.song(track, server));

const genreFilter = (genreIds?: string[]) =>
    genreIds?.length ? genreIds.map(Number).filter(Number.isFinite) : undefined;

// --- Jukebox: Feishin's server-side playback engine drives a Music Assistant player queue ---

// The jukebox engine expects Subsonic semantics: after a track ends it removes entry 0 so the
// playing track is index 0 again. MA keeps played items (and refuses to delete them), so each
// queue is shown to the engine through a window that starts at `offset`.
const jukeboxState = new Map<
    string,
    { offset: number; pending?: { index: number; offset: number } }
>();
const defaultPlayers = new Map<string, string>();

const getPlayerId = async (server: Server) => {
    if (!server) throw new Error('No Music Assistant server selected');
    if (server.musicAssistantPlayerId) return server.musicAssistantPlayerId;

    const cached = defaultPlayers.get(server.id);
    if (cached) return cached;

    // Default to the player last selected in the Music Assistant web UI
    const [me, players] = await Promise.all([
        maCommand<{ preferences?: { activePlayerId?: string } }>(server, 'auth/me'),
        maCommand<MAPlayer[]>(server, 'players/all'),
    ]);
    const available = players.filter((p) => p.available && p.enabled !== false);
    const player =
        available.find((p) => p.player_id === me.preferences?.activePlayerId) || available[0];
    if (!player) throw new Error('No available Music Assistant player');

    defaultPlayers.set(server.id, player.player_id);
    return player.player_id;
};

const jukeboxControl = async (
    server: Server,
    query: JukeboxControlQuery,
): Promise<JukeboxControlResponse> => {
    const queueId = await getPlayerId(server);
    const state = jukeboxState.get(queueId) || { offset: 0 };
    jukeboxState.set(queueId, state);

    const queue = (command: string, args?: object) =>
        maCommand(server, `player_queues/${command}`, { queue_id: queueId, ...args });
    const uris = () => [query.id || []].flat().map((id) => maUri('track', id));

    switch (query.action) {
        case 'add':
            await queue('play_media', { media: uris(), option: 'add' });
            return null;
        case 'clear':
            jukeboxState.set(queueId, { offset: 0 });
            await queue('clear');
            return null;
        case 'remove': {
            const current = await maCommand<MAPlayerQueue>(server, 'player_queues/get', {
                queue_id: queueId,
            });
            const index = state.offset + (query.index ?? 0);
            if (index <= (current.current_index ?? -1)) {
                state.offset = index + 1;
            } else {
                // ponytail: MA ignores deletes of an item it already buffered (the last
                // seconds before a track change), so a late "next" swap can be missed
                await queue('delete_item', { item_id_or_index: index });
            }
            return null;
        }
        case 'set':
            jukeboxState.set(queueId, { offset: 0 });
            await queue('clear');
            await queue('play_media', { media: uris(), option: 'add' });
            return null;
        case 'setGain':
            await maCommand(server, 'players/cmd/volume_set', {
                player_id: queueId,
                volume_level: Math.round((query.gain ?? 1) * 100),
            });
            return null;
        case 'skip': {
            const current = await maCommand<MAPlayerQueue>(server, 'player_queues/get', {
                queue_id: queueId,
            });
            const index = state.offset + (query.index ?? 0);
            const position = Math.floor(query.offset ?? 0);
            if (current.state === 'playing') {
                if (index === current.current_index) {
                    await queue('seek', { position });
                } else {
                    await queue('play_index', { index, seek_position: position });
                }
            } else {
                // Jukebox skip keeps the play state; MA's play_index always starts playback
                state.pending = { index, offset: position };
            }
            return null;
        }
        case 'start':
            if (state.pending) {
                const { index, offset } = state.pending;
                state.pending = undefined;
                await queue('play_index', { index, seek_position: offset });
            } else {
                await queue('play');
            }
            return null;
        case 'stop':
            await queue('pause');
            return null;
        default: {
            const [current, items, player] = await Promise.all([
                maCommand<MAPlayerQueue>(server, 'player_queues/get', { queue_id: queueId }),
                maCommand<MAQueueItem[]>(server, 'player_queues/items', {
                    limit: 500,
                    queue_id: queueId,
                }),
                maCommand<MAPlayer>(server, 'players/get', { player_id: queueId }),
            ]);
            const playing = current.state === 'playing';
            // elapsed_time is a snapshot; extrapolate (clamped, in case the clocks disagree)
            const drift = Math.min(
                Math.max(Date.now() / 1000 - current.elapsed_time_last_updated, 0),
                10,
            );

            return {
                jukeboxPlaylist: {
                    currentIndex: state.pending
                        ? state.pending.index - state.offset
                        : (current.current_index ?? 0) - state.offset,
                    entry: items.slice(state.offset).map((item) => ({
                        duration: item.duration ?? undefined,
                        id: maId(item.media_item) || item.queue_item_id,
                        isDir: false,
                        title: item.name,
                    })),
                    gain: (player.volume_level ?? 100) / 100,
                    // A pause from another MA client must not look like the track ended
                    playing: current.state !== 'idle',
                    position: state.pending
                        ? state.pending.offset
                        : current.elapsed_time + (playing ? drift : 0),
                },
            };
        }
    }
};

export const getMusicAssistantPlayers = async (server: Server) =>
    (await maCommand<MAPlayer[]>(server, 'players/all')).filter(
        (player) => player.available && player.enabled !== false && !player.hide_in_ui,
    );

const notSupported = async (): Promise<never> => {
    throw new Error('Not supported by Music Assistant');
};

export const MusicAssistantController: InternalControllerEndpoint = {
    addToPlaylist: async ({ apiClientProps, body, query }) => {
        await maCommand(apiClientProps.server, 'music/playlists/add_playlist_tracks', {
            db_playlist_id: query.id,
            uris: body.songId.map((id) => maUri('track', id)),
        });
        return null;
    },
    authenticate: async (url, body) => {
        const server = { credential: '', url: normalizeServerUrl(url) };
        let token: string = body.password;

        // The password field may hold an access token (MA tokens are JWTs) instead of a password,
        // needed for Home Assistant add-on users who sign in through Home Assistant. A token wins
        // over the username, so re-entering one in the edit form (which keeps the username) works.
        const isToken = /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token || '');
        if (body.username && !isToken) {
            const res = await maCommand<{ access_token?: string; error?: string }>(
                server,
                'auth/login',
                { device_name: 'Feishin', password: body.password, username: body.username },
            );
            if (!res.access_token) throw new Error(res.error || 'Failed to log in');

            // Swap the 30-day session token for a long-lived one so Feishin stays signed in
            token = await maCommand<string>(
                { ...server, credential: res.access_token },
                'auth/token/create',
                { name: 'Feishin' },
            ).catch(() => res.access_token!);
        }

        const user = await maCommand<{ role: string; user_id: string; username: string }>(
            { ...server, credential: token },
            'auth/me',
        );

        return {
            credential: token,
            isAdmin: user.role === 'admin',
            userId: user.user_id,
            username: user.username,
        };
    },
    createFavorite: async ({ apiClientProps, query }) => {
        const mediaType = MEDIA_TYPE[query.type] || 'track';
        for (const id of query.id) {
            await maCommand(apiClientProps.server, 'music/favorites/add_item', {
                item: maUri(mediaType, id),
            });
        }
        return null;
    },
    createInternetRadioStation: notSupported,
    createPlaylist: async ({ apiClientProps, body }) => {
        const playlist = await maCommand<MAPlaylist>(
            apiClientProps.server,
            'music/playlists/create_playlist',
            { name: body.name },
        );
        return { id: maId(playlist) };
    },
    deleteFavorite: async ({ apiClientProps, query }) => {
        const mediaType = MEDIA_TYPE[query.type] || 'track';
        for (const id of query.id) {
            const ref = maRef(id);
            // Provider items (e.g. tracks of an MA playlist) resolve to their library entry
            const libraryId =
                ref.provider_instance_id_or_domain === 'library'
                    ? ref.item_id
                    : (
                          await maCommand<MATrack>(
                              apiClientProps.server,
                              `music/${mediaType}s/get`,
                              ref,
                          )
                      ).item_id;
            await maCommand(apiClientProps.server, 'music/favorites/remove_item', {
                library_item_id: libraryId,
                media_type: mediaType,
            });
        }
        return null;
    },
    deleteInternetRadioStation: notSupported,
    deletePlaylist: async ({ apiClientProps, query }) => {
        await maCommand(apiClientProps.server, 'music/library/remove_item', {
            library_item_id: query.id,
            media_type: 'playlist',
        });
        return null;
    },
    getAlbumArtistDetail: async ({ apiClientProps, query }) =>
        maNormalize.albumArtist(
            await maCommand<MAArtist>(apiClientProps.server, 'music/artists/get', maRef(query.id)),
            apiClientProps.server,
        ),
    getAlbumArtistList: async ({ apiClientProps, query }) => ({
        items: (
            await libraryItems<MAArtist>(apiClientProps.server, 'artists', {
                album_artists_only: true,
                favorite: query.favorite,
                limit: query.limit,
                offset: query.startIndex,
                order_by: orderBy(ARTIST_SORT[query.sortBy], query.sortOrder),
                search: query.searchTerm,
            })
        ).map((item) => maNormalize.albumArtist(item, apiClientProps.server)),
        startIndex: query.startIndex,
        totalRecordCount: null,
    }),
    getAlbumArtistListCount: async ({ apiClientProps, query }) =>
        query.searchTerm
            ? (
                  await libraryItems(apiClientProps.server, 'artists', {
                      album_artists_only: true,
                      favorite: query.favorite,
                      search: query.searchTerm,
                  })
              ).length
            : maCommand<number>(apiClientProps.server, 'music/artists/count', {
                  album_artists_only: true,
                  favorite_only: Boolean(query.favorite),
              }),
    getAlbumDetail: async ({ apiClientProps, query }) => {
        const { server } = apiClientProps;
        const [album, tracks] = await Promise.all([
            maCommand<MAAlbum>(server, 'music/albums/get', maRef(query.id)),
            albumTracks(server, [query.id]),
        ]);
        return maNormalize.album(album, server, songs(server, tracks));
    },
    getAlbumList: async ({ apiClientProps, query }) => {
        const { server } = apiClientProps;

        if (query.artistIds?.length) {
            const albums = await maCommand<MAAlbum[]>(
                server,
                'music/artists/artist_albums',
                maRef(query.artistIds[0]),
            );
            let items = albums.map((album) => maNormalize.album(album, server));
            if (query.favorite) items = items.filter((album) => album.userFavorite);
            if (query.sortBy) items = sortAlbumList(items, query.sortBy, query.sortOrder);
            return paginate(items, query.startIndex, query.limit);
        }

        const albums = await libraryItems<MAAlbum>(server, 'albums', {
            favorite: query.favorite,
            genre: genreFilter(query.genreIds),
            limit: query.limit,
            offset: query.startIndex,
            order_by: orderBy(ALBUM_SORT[query.sortBy], query.sortOrder),
            search: query.searchTerm,
        });
        return {
            items: albums.map((album) => maNormalize.album(album, server)),
            startIndex: query.startIndex,
            totalRecordCount: null,
        };
    },
    getAlbumListCount: async (args) => {
        const { apiClientProps, query } = args;
        if (query.artistIds?.length || query.searchTerm || query.genreIds?.length) {
            const res = await MusicAssistantController.getAlbumList({
                apiClientProps,
                query: { ...query, limit: undefined, startIndex: 0 },
            });
            return res.totalRecordCount ?? res.items.length;
        }
        return maCommand<number>(apiClientProps.server, 'music/albums/count', {
            favorite_only: Boolean(query.favorite),
        });
    },
    getAlbumRadio: async () => [],
    getArtistList: async ({ apiClientProps, query }) => ({
        items: (
            await libraryItems<MAArtist>(apiClientProps.server, 'artists', {
                favorite: query.favorite,
                limit: query.limit,
                offset: query.startIndex,
                order_by: orderBy(ARTIST_SORT[query.sortBy], query.sortOrder),
                search: query.searchTerm,
            })
        ).map((item) => maNormalize.albumArtist(item, apiClientProps.server)),
        startIndex: query.startIndex,
        totalRecordCount: null,
    }),
    getArtistListCount: async ({ apiClientProps, query }) =>
        query.searchTerm
            ? (
                  await libraryItems(apiClientProps.server, 'artists', {
                      favorite: query.favorite,
                      search: query.searchTerm,
                  })
              ).length
            : maCommand<number>(apiClientProps.server, 'music/artists/count', {
                  favorite_only: Boolean(query.favorite),
              }),
    getArtistRadio: async () => [],
    // ponytail: MA has no file download endpoint; audio is only streamed to its own players
    getDownloadUrl: () => '',
    getFavoriteSongs: async ({ apiClientProps, query }) => {
        const tracks = await artistTracks(apiClientProps.server, query.artistId);
        const items = songs(apiClientProps.server, tracks).filter((song) => song.userFavorite);
        return paginate(items, 0, query.limit);
    },
    getFolder: notSupported,
    getGenreList: async ({ apiClientProps, query }) => {
        const genres = await libraryItems<MAGenre>(apiClientProps.server, 'genres', {
            order_by: orderBy('sort_name', query.sortOrder),
            search: query.searchTerm,
        });
        return paginate(
            genres.map((genre) => maNormalize.genre(genre, apiClientProps.server)),
            query.startIndex,
            query.limit,
        );
    },
    getImageRequest: ({ apiClientProps: { server }, baseUrl, query }) => {
        const url = baseUrl || getServerUrl(server);
        if (!url || !/^[0-9a-f]{64}$/.test(query.id)) return null;

        const size = query.size ? IMAGE_SIZES.find((s) => s >= query.size!) || 1024 : 0;
        return {
            cacheKey: ['music-assistant', server?.id, query.id, size].join(':'),
            url: `${url}/imageproxy/${query.id}?size=${size}`,
        };
    },
    getImageUrl: (args) => MusicAssistantController.getImageRequest(args)?.url || null,
    getInternetRadioStations: async () => [],
    getMusicFolderList: async () => ({ items: [], startIndex: 0, totalRecordCount: 0 }),
    getPlaylistDetail: async ({ apiClientProps, query }) =>
        maNormalize.playlist(
            await maCommand<MAPlaylist>(
                apiClientProps.server,
                'music/playlists/get',
                maRef(query.id),
            ),
            apiClientProps.server,
        ),
    getPlaylistList: async ({ apiClientProps, query }) => ({
        items: (
            await libraryItems<MAPlaylist>(apiClientProps.server, 'playlists', {
                limit: query.limit,
                offset: query.startIndex,
                order_by: orderBy(PLAYLIST_SORT[query.sortBy], query.sortOrder),
                search: query.searchTerm,
            })
        ).map((item) => maNormalize.playlist(item, apiClientProps.server)),
        startIndex: query.startIndex,
        totalRecordCount: null,
    }),
    getPlaylistListCount: async ({ apiClientProps, query }) =>
        query.searchTerm
            ? (await libraryItems(apiClientProps.server, 'playlists', { search: query.searchTerm }))
                  .length
            : maCommand<number>(apiClientProps.server, 'music/playlists/count', {}),
    getPlaylistSongIds: async (args) => {
        const res = await MusicAssistantController.getPlaylistSongList(args);
        return { ...res, items: res.items.map((song) => song.id) };
    },
    getPlaylistSongList: async ({ apiClientProps, query }) => {
        const tracks = await maCommand<MATrack[]>(
            apiClientProps.server,
            'music/playlists/playlist_tracks',
            { ...maRef(query.id), limit: ALL },
        );
        return paginate(songs(apiClientProps.server, tracks));
    },
    getPlayQueue: notSupported,
    getRandomSongList: async ({ apiClientProps, query }) => {
        const tracks = await libraryItems<MATrack>(apiClientProps.server, 'tracks', {
            genre: genreFilter(query.genre ? [query.genre] : undefined),
            limit: query.limit || 50,
            order_by: 'random',
        });
        return paginate(songs(apiClientProps.server, tracks));
    },
    getRoles: async () => [],
    getScanStatus: async () => ({ count: 0, folderCount: 0, scanning: false }),
    getServerInfo: async ({ apiClientProps }) => {
        const info = await maCommand<{ server_version: string }>(apiClientProps.server, 'info');
        return {
            features: { [ServerFeature.JUKEBOX]: [1] },
            id: apiClientProps.server?.id,
            version: info.server_version,
        };
    },
    getSimilarSongs: async ({ apiClientProps, query }) =>
        songs(
            apiClientProps.server,
            await maCommand<MATrack[]>(apiClientProps.server, 'music/tracks/similar_tracks', {
                ...maRef(query.songId),
                limit: query.count || 25,
            }),
        ),
    getSongDetail: async ({ apiClientProps, query }) =>
        maNormalize.song(
            await maCommand<MATrack>(apiClientProps.server, 'music/tracks/get', maRef(query.id)),
            apiClientProps.server,
        ),
    getSongList: async ({ apiClientProps, query }) => {
        const { server } = apiClientProps;
        const artistId = query.artistIds?.[0] || query.albumArtistIds?.[0];

        if (query.albumIds?.length || artistId) {
            const tracks = query.albumIds?.length
                ? await albumTracks(server, query.albumIds)
                : await artistTracks(server, artistId!);
            let items: Song[] = songs(server, tracks);
            if (query.favorite) items = items.filter((song) => song.userFavorite);
            if (query.searchTerm) {
                const term = query.searchTerm.toLowerCase();
                items = items.filter((song) => song.name.toLowerCase().includes(term));
            }
            if (query.sortBy) items = sortSongList(items, query.sortBy, query.sortOrder);
            return paginate(items, query.startIndex, query.limit);
        }

        const tracks = await libraryItems<MATrack>(server, 'tracks', {
            favorite: query.favorite,
            genre: genreFilter(query.genreIds),
            limit: query.limit,
            offset: query.startIndex,
            order_by: orderBy(SONG_SORT[query.sortBy], query.sortOrder),
            search: query.searchTerm,
            // full items carry the audio format (codec, bitrate, sample rate)
            summary: false,
        });
        return {
            items: songs(server, tracks),
            startIndex: query.startIndex,
            totalRecordCount: null,
        };
    },
    getSongListCount: async ({ apiClientProps, query }) => {
        if (
            query.albumIds?.length ||
            query.artistIds?.length ||
            query.albumArtistIds?.length ||
            query.searchTerm ||
            query.genreIds?.length
        ) {
            const res = await MusicAssistantController.getSongList({
                apiClientProps,
                query: { ...query, limit: undefined, startIndex: 0 },
            });
            return res.totalRecordCount ?? res.items.length;
        }
        return maCommand<number>(apiClientProps.server, 'music/tracks/count', {
            favorite_only: Boolean(query.favorite),
        });
    },
    getStreamUrl: async () => {
        // MA only streams to its own players, so the local MPV/Web engines have nothing to play
        const message = i18n.t('error.musicAssistantJukeboxOnly');
        toast.error({ id: 'music-assistant-jukebox-only', message });
        throw new Error(message);
    },
    getTopSongs: async ({ apiClientProps, query }) =>
        paginate(
            songs(
                apiClientProps.server,
                await maCommand<MATrack[]>(
                    apiClientProps.server,
                    'music/artists/top_tracks',
                    maRef(query.artistId),
                ),
            ),
            0,
            query.limit,
        ),
    getUserInfo: async ({ apiClientProps }) => {
        const user = await maCommand<{
            display_name?: string;
            role: string;
            user_id: string;
            username: string;
        }>(apiClientProps.server, 'auth/me');
        return {
            id: user.user_id,
            isAdmin: user.role === 'admin',
            name: user.display_name || user.username,
        };
    },
    jukeboxControl: ({ apiClientProps, query }) => jukeboxControl(apiClientProps.server, query),
    refreshItems: async () => null,
    removeFromPlaylist: async ({ apiClientProps, query }) => {
        await maCommand(apiClientProps.server, 'music/playlists/remove_playlist_tracks', {
            db_playlist_id: query.id,
            positions_to_remove: query.songId.map(Number),
        });
        return null;
    },
    // ponytail: MA applies playlist edits as background tasks with no ordering guarantee, so a
    // remove-all-then-add replace could interleave; add when MA exposes an atomic replace
    replacePlaylist: notSupported,
    // ponytail: no server-side play queue sync; MA keeps its own queue per player
    savePlayQueue: async () => {},
    // MA records plays itself when its players play a track
    scrobble: async () => null,
    search: async ({ apiClientProps, query }) => {
        const { server } = apiClientProps;
        const albumEnd = (query.albumStartIndex || 0) + (query.albumLimit ?? 25);
        const artistEnd = (query.albumArtistStartIndex || 0) + (query.albumArtistLimit ?? 25);
        const songEnd = (query.songStartIndex || 0) + (query.songLimit ?? 25);

        const res = await maCommand<{ albums: MAAlbum[]; artists: MAArtist[]; tracks: MATrack[] }>(
            server,
            'music/search',
            {
                library_only: true,
                limit: Math.max(albumEnd, artistEnd, songEnd),
                media_types: ['artist', 'album', 'track'],
                search_query: query.query || '',
            },
        );

        return {
            albumArtists: res.artists
                .slice(query.albumArtistStartIndex || 0, artistEnd)
                .map((item) => maNormalize.albumArtist(item, server)),
            albums: res.albums
                .slice(query.albumStartIndex || 0, albumEnd)
                .map((item) => maNormalize.album(item, server)),
            songs: songs(server, res.tracks.slice(query.songStartIndex || 0, songEnd)),
        };
    },
    setPlaylistSongs: notSupported,
    startLibraryScan: async ({ apiClientProps }) => {
        await maCommand(apiClientProps.server, 'music/sync', {});
        return null;
    },
    updateInternetRadioStation: notSupported,
    updatePlaylist: notSupported,
};
