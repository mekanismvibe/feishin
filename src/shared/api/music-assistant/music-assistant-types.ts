// Subset of the Music Assistant (https://music-assistant.io) media item JSON this client reads.
// Field names match the server's snake_case serialization.

export type MAAlbum = MAMediaItem & {
    album_type?: string;
    artists?: MAItemMapping[];
    year?: null | number;
};

export type MAArtist = MAMediaItem;

export type MAAudioFormat = {
    bit_depth?: number;
    bit_rate?: number;
    channels?: number;
    content_type?: string;
    sample_rate?: number;
};

export type MAGenre = MAMediaItem;

export type MAImage = {
    path: string;
    provider: string;
    proxy_id?: string;
    remotely_accessible?: boolean;
    type: string;
};

export type MAItemMapping = {
    image?: MAImage | null;
    item_id: string;
    media_type: string;
    name: string;
    provider: string;
    sort_name?: string;
    uri: string;
    version?: string;
    year?: null | number;
};

export type MAMediaItem = MAItemMapping & {
    date_added?: null | string;
    favorite?: boolean | null;
    metadata?: {
        description?: null | string;
        explicit?: boolean | null;
        images?: MAImage[] | null;
        label?: null | string;
        lyrics?: null | string;
        release_date?: null | string;
    };
    position?: null | number;
    provider_mappings?: { audio_format?: MAAudioFormat; provider_domain: string }[];
};

export type MAPlayer = {
    available: boolean;
    enabled?: boolean;
    hide_in_ui?: boolean;
    name: string;
    player_id: string;
    volume_level?: null | number;
};

export type MAPlayerQueue = {
    current_index: null | number;
    elapsed_time: number;
    elapsed_time_last_updated: number;
    queue_id: string;
    state: 'idle' | 'paused' | 'playing' | 'unknown';
};

export type MAPlaylist = MAMediaItem & {
    is_editable?: boolean;
    owner?: string;
};

export type MAQueueItem = {
    duration?: null | number;
    media_item?: MATrack | null;
    name: string;
    queue_item_id: string;
};

export type MATrack = MAMediaItem & {
    album?: MAItemMapping | null;
    artists?: MAItemMapping[];
    disc_number?: number;
    duration?: number;
    last_played?: number;
    track_number?: number;
};
