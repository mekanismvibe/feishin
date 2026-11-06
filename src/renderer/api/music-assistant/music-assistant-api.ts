import { logger } from '/@/renderer/utils/logger';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { ServerListItemWithCredential } from '/@/shared/types/domain-types';

// Music Assistant speaks JSON-RPC over a websocket (/ws). The HTTP /api endpoint sends no CORS
// headers, so the websocket is the only transport that works from the renderer and the web build.

type Connection = {
    pending: Map<string, Pending>;
    ready: Promise<WebSocket>;
};

type Pending = {
    items: unknown[];
    reject: (error: Error) => void;
    resolve: (result: unknown) => void;
};

const COMMAND_TIMEOUT_MS = 60_000;
const connections = new Map<string, Connection>();
let messageId = 0;

const toWsUrl = (url: string) => `${url.replace(/\/$/, '').replace(/^http/i, 'ws')}/ws`;

const send = (ws: WebSocket, pending: Connection['pending'], command: string, args?: object) =>
    new Promise<unknown>((resolve, reject) => {
        const id = String(++messageId);
        const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Music Assistant command timed out: ${command}`));
        }, COMMAND_TIMEOUT_MS);

        pending.set(id, {
            items: [],
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            },
            resolve: (result) => {
                clearTimeout(timeout);
                resolve(result);
            },
        });
        ws.send(JSON.stringify({ args, command, message_id: id }));
    });

const connect = (url: string, token: string): Connection => {
    const key = `${url}|${token}`;
    const pending: Connection['pending'] = new Map();

    const ready = new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(toWsUrl(url));

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);

            // The server greets every connection with its info before accepting commands
            if (message.server_version) {
                if (!token) return resolve(ws);
                send(ws, pending, 'auth', { token })
                    .then(() => resolve(ws))
                    .catch((error) => {
                        reject(error);
                        ws.close();
                    });
                return;
            }

            const request = message.message_id && pending.get(message.message_id);
            if (!request) return; // events and stray replies

            // Large listings arrive in chunks flagged `partial`, then a final message
            if (message.partial) {
                request.items.push(...message.result);
                return;
            }

            pending.delete(message.message_id);

            if ('error_code' in message) {
                request.reject(new Error(message.details || `Error ${message.error_code}`));
            } else if (request.items.length) {
                request.resolve([...request.items, ...message.result]);
            } else {
                request.resolve(message.result);
            }
        };

        ws.onclose = () => {
            connections.delete(key);
            reject(new Error('Could not connect to Music Assistant'));
            pending.forEach((request) =>
                request.reject(new Error('Music Assistant connection closed')),
            );
            pending.clear();
        };
    });

    ready.catch((error) => {
        connections.delete(key);
        logger.error('Music Assistant connection failed', { error: error.message, url });
    });

    const connection = { pending, ready };
    connections.set(key, connection);
    return connection;
};

export const maCommand = async <T = unknown>(
    server: null | Pick<ServerListItemWithCredential, 'credential' | 'url'> | undefined,
    command: string,
    args?: object,
): Promise<T> => {
    const url = getServerUrl(server as ServerListItemWithCredential);
    if (!url) throw new Error('No Music Assistant server selected');

    const token = server?.credential || '';
    const connection = connections.get(`${url}|${token}`) || connect(url, token);
    const ws = await connection.ready;

    return send(ws, connection.pending, command, args) as Promise<T>;
};
