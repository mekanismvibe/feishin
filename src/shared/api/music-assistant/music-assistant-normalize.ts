import {
    MAAlbum,
    MAArtist,
    MAGenre,
    MAItemMapping,
    MAMediaItem,
    MAPlaylist,
    MATrack,
} from '/@/shared/api/music-assistant/music-assistant-types';
import {
    Album,
    AlbumArtist,
    ExplicitStatus,
    Genre,
    LibraryItem,
    Playlist,
    RelatedArtist,
    ServerListItemWithCredential,
    ServerType,
    Song,
} from '/@/shared/types/domain-types';

// Library items keep their numeric id; items that only exist on a provider (e.g. a streaming
// service track inside a playlist) use their full MA uri so they can still be played.
export const maId = (item?: null | Pick<MAItemMapping, 'item_id' | 'provider' | 'uri'>) =>
    !item ? '' : item.provider === 'library' ? item.item_id : item.uri;

export const maUri = (mediaType: string, id: string) =>
    id.includes('://') ? id : `library://${mediaType}/${id}`;

export const maRef = (id: string) => {
    const match = id.match(/^(.+?):\/\/[^/]+\/(.+)$/);
    return match
        ? { item_id: match[2], provider_instance_id_or_domain: match[1] }
        : { item_id: id, provider_instance_id_or_domain: 'library' };
};

const imageId = (item?: MAItemMapping | MAMediaItem | null) => {
    if (!item) return null;
    const images = (item as MAMediaItem).metadata?.images;
    const image = images?.find((i) => i.type === 'thumb') || images?.[0] || item.image;
    return image?.proxy_id || null;
};

const relatedArtist = (artist: MAItemMapping): RelatedArtist => ({
    id: maId(artist),
    imageId: imageId(artist),
    imageUrl: null,
    name: artist.name,
    userFavorite: false,
    userRating: null,
});

const displayName = (item: MAItemMapping) =>
    item.version ? `${item.name} (${item.version})` : item.name;

const explicitStatus = (item: MAMediaItem) =>
    item.metadata?.explicit === true
        ? ExplicitStatus.EXPLICIT
        : item.metadata?.explicit === false
          ? ExplicitStatus.CLEAN
          : null;

const base = (server?: null | ServerListItemWithCredential) => ({
    _serverId: server?.id || 'unknown',
    _serverType: ServerType.MUSIC_ASSISTANT,
    blurHash: null,
    thumbHash: null,
});

const normalizeSong = (item: MATrack, server?: null | ServerListItemWithCredential): Song => {
    const artists = (item.artists || []).map(relatedArtist);
    const artistName = artists.map((a) => a.name).join(', ');
    const format = item.provider_mappings?.[0]?.audio_format;
    const year = item.album?.year || null;
    const container =
        format?.content_type && format.content_type !== '?' ? format.content_type : null;

    return {
        ...base(server),
        _itemType: LibraryItem.SONG,
        album: item.album?.name || null,
        albumArtistName: artistName,
        albumArtists: artists,
        albumId: maId(item.album),
        artistName,
        artists,
        bitDepth: format?.bit_depth || null,
        bitRate: format?.bit_rate || 0,
        bpm: null,
        channels: format?.channels || null,
        codec: container,
        comment: null,
        compilation: null,
        container,
        createdAt: item.date_added || '',
        date: year ? String(year) : null,
        discNumber: item.disc_number || 1,
        discSubtitle: null,
        duration: (item.duration || 0) * 1000,
        explicitStatus: explicitStatus(item),
        folderId: null,
        gain: null,
        genres: [],
        id: maId(item),
        imageId: imageId(item) || imageId(item.album),
        imageUrl: null,
        lastPlayedAt: item.last_played ? new Date(item.last_played * 1000).toISOString() : null,
        libraryId: null,
        libraryName: null,
        lyrics: item.metadata?.lyrics || null,
        mbzAlbumId: null,
        mbzAlbumType: null,
        mbzRecordingId: null,
        mbzReleaseGroupId: null,
        mbzTrackId: null,
        missing: null,
        name: displayName(item),
        originalDate: null,
        originalYear: null,
        participants: null,
        path: null,
        peak: null,
        playCount: 0,
        playlistItemId: item.position != null ? String(item.position) : undefined,
        releaseDate: year ? String(year) : null,
        releaseYear: year,
        sampleRate: format?.sample_rate || null,
        size: 0,
        sortName: item.sort_name || item.name,
        tags: null,
        trackNumber: item.track_number || 1,
        trackSubtitle: null,
        updatedAt: '',
        userFavorite: Boolean(item.favorite),
        userRating: null,
        year,
    };
};

const normalizeAlbum = (
    item: MAAlbum,
    server?: null | ServerListItemWithCredential,
    songs?: Song[],
): Album => {
    const albumArtists = (item.artists || []).map(relatedArtist);
    const year = item.year || null;
    const releaseType = item.album_type && item.album_type !== 'unknown' ? item.album_type : null;

    return {
        ...base(server),
        _itemType: LibraryItem.ALBUM,
        albumArtistName: albumArtists.map((a) => a.name).join(', '),
        albumArtists,
        artists: [],
        comment: null,
        createdAt: item.date_added || '',
        discs: null,
        dominantColor: null,
        duration: songs ? songs.reduce((sum, song) => sum + song.duration, 0) : null,
        explicitStatus: explicitStatus(item),
        gain: null,
        genres: [],
        id: maId(item),
        imageId: imageId(item),
        imageUrl: null,
        isCompilation: item.album_type === 'compilation',
        lastPlayedAt: null,
        mbzId: null,
        mbzReleaseGroupId: null,
        missing: null,
        name: displayName(item),
        originalDate: null,
        originalYear: null,
        participants: null,
        peak: null,
        playCount: null,
        ratedAt: null,
        recordLabels: item.metadata?.label ? [item.metadata.label] : [],
        releaseDate: year ? String(year) : null,
        releaseType,
        releaseTypes: releaseType ? [releaseType] : [],
        releaseYear: year,
        size: null,
        songCount: songs ? songs.length : null,
        songs,
        sortName: item.sort_name || item.name,
        starredAt: null,
        tags: null,
        trackYearRange: null,
        updatedAt: item.date_added || '',
        userFavorite: Boolean(item.favorite),
        userRating: null,
        version: item.version || null,
    };
};

const normalizeAlbumArtist = (
    item: MAArtist,
    server?: null | ServerListItemWithCredential,
): AlbumArtist => ({
    ...base(server),
    _itemType: LibraryItem.ALBUM_ARTIST,
    albumCount: null,
    biography: item.metadata?.description || null,
    dominantColor: null,
    duration: null,
    genres: [],
    id: maId(item),
    imageId: imageId(item),
    imageUrl: null,
    lastPlayedAt: null,
    mbz: null,
    missing: null,
    name: item.name,
    playCount: null,
    ratedAt: null,
    similarArtists: null,
    songCount: null,
    starredAt: null,
    userFavorite: Boolean(item.favorite),
    userRating: null,
});

const normalizePlaylist = (
    item: MAPlaylist,
    server?: null | ServerListItemWithCredential,
    songCount?: number,
): Playlist => ({
    ...base(server),
    _itemType: LibraryItem.PLAYLIST,
    description: item.metadata?.description || null,
    dominantColor: null,
    duration: null,
    evaluatedAt: null,
    genres: [],
    id: maId(item),
    imageId: imageId(item),
    imageUrl: null,
    name: item.name,
    owner: item.owner || null,
    ownerId: item.owner || null,
    public: null,
    size: null,
    songCount: songCount ?? null,
});

const normalizeGenre = (item: MAGenre, server?: null | ServerListItemWithCredential): Genre => ({
    _itemType: LibraryItem.GENRE,
    _serverId: server?.id || 'unknown',
    _serverType: ServerType.MUSIC_ASSISTANT,
    albumCount: null,
    id: maId(item),
    imageId: imageId(item),
    imageUrl: null,
    name: item.name,
    songCount: null,
});

export const maNormalize = {
    album: normalizeAlbum,
    albumArtist: normalizeAlbumArtist,
    genre: normalizeGenre,
    playlist: normalizePlaylist,
    song: normalizeSong,
};
