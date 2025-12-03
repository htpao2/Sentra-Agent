import { useState } from 'react';
import { getAuthHeaders } from '../services/api';

export interface RedisConnectionInfo {
    id: string;
    name: string;
    host: string;
    port: number;
}

export function useRedisEditor(addToast: (type: any, title: string, message?: string) => void) {
    const [redisEditorOpen, setRedisEditorOpen] = useState(false);
    const [connections, setConnections] = useState<RedisConnectionInfo[]>([]);
    const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
    const [minimized, setMinimized] = useState(false);

    const fetchConnections = async () => {
        try {
            const res = await fetch('/api/redis/connections', { headers: getAuthHeaders() });
            const data = await res.json();
            if (data.connections) {
                setConnections(data.connections);
            }
        } catch (error) {
            console.error('Failed to fetch connections', error);
        }
    };

    const connect = async (name: string, host: string, port: number, password?: string) => {
        const id = `redis-${Date.now()}`;
        try {
            const res = await fetch('/api/redis/connect', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ id, name, host, port, password })
            });
            const data = await res.json();
            if (data.success) {
                addToast('success', '已连接', `成功连接到 ${host}:${port}`);
                await fetchConnections();
                setActiveConnectionId(id);
                return true;
            } else {
                addToast('error', '连接失败', data.error);
                return false;
            }
        } catch (error) {
            addToast('error', '连接错误', String(error));
            return false;
        }
    };

    const disconnect = async (id: string) => {
        try {
            await fetch('/api/redis/disconnect', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ id })
            });
            await fetchConnections();
            if (activeConnectionId === id) setActiveConnectionId(null);
            addToast('success', '已断开', '连接已关闭');
        } catch (error) {
            console.error('Disconnect failed', error);
        }
    };

    const executeCommand = async (id: string, command: string, args: string[] = []) => {
        try {
            const res = await fetch('/api/redis/command', {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify({ id, command, args })
            });
            const data = await res.json();
            if (data.success) {
                return { success: true, result: data.result };
            } else {
                return { success: false, error: data.error };
            }
        } catch (error) {
            return { success: false, error: String(error) };
        }
    };

    return {
        redisEditorOpen,
        setRedisEditorOpen,
        minimized,
        setMinimized,
        connections,
        activeConnectionId,
        setActiveConnectionId,
        fetchConnections,
        connect,
        disconnect,
        executeCommand
    };
}
