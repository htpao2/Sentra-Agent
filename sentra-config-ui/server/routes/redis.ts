import { FastifyInstance } from 'fastify';
import { redisService } from '../services/redisService';

export async function redisRoutes(fastify: FastifyInstance) {
    // Connect
    fastify.post<{
        Body: { id: string; name: string; host: string; port: number; password?: string };
    }>('/api/redis/connect', async (request, reply) => {
        const { id, name, host, port, password } = request.body;
        try {
            await redisService.connect(id, name, host, port, password);
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Disconnect
    fastify.post<{
        Body: { id: string };
    }>('/api/redis/disconnect', async (request, reply) => {
        const { id } = request.body;
        try {
            await redisService.disconnect(id);
            return { success: true };
        } catch (error) {
            reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // List Connections
    fastify.get('/api/redis/connections', async () => {
        return { connections: redisService.getAllConnections() };
    });

    // Execute Command
    fastify.post<{
        Body: { id: string; command: string; args?: string[] };
    }>('/api/redis/command', async (request, reply) => {
        const { id, command, args = [] } = request.body;
        try {
            const result = await redisService.executeCommand(id, command, args);
            return { success: true, result };
        } catch (error) {
            reply.code(500).send({
                success: false,
                error: error instanceof Error ? error.message : String(error)
            });
        }
    });
}
