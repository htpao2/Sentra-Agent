import { FastifyInstance } from 'fastify';
import { scriptRunner } from '../scriptRunner';

export async function scriptRoutes(fastify: FastifyInstance) {
    // Execute bootstrap script
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/bootstrap', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('bootstrap', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute bootstrap script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute start script
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/start', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('start', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute start script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute napcat script (supports args: ['build'] or ['start'])
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/napcat', async (request, reply) => {
        try {
            const { args = ['start'] } = request.body || {};
            const processId = scriptRunner.executeScript('napcat', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute napcat script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Execute update script (supports args: [] (normal) or ['force'] (force update))
    fastify.post<{
        Body: { args?: string[] };
    }>('/api/scripts/update', async (request, reply) => {
        try {
            const { args = [] } = request.body || {};
            const processId = scriptRunner.executeScript('update', args);

            return { success: true, processId };
        } catch (error) {
            reply.code(500).send({
                error: 'Failed to execute update script',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    });

    // Get script status
    fastify.get<{
        Params: { id: string };
    }>('/api/scripts/status/:id', async (request, reply) => {
        const { id } = request.params;
        const process = scriptRunner.getProcess(id);

        if (!process) {
            return reply.code(404).send({ error: 'Process not found' });
        }

        return {
            id: process.id,
            exitCode: process.exitCode,
            startTime: process.startTime,
            endTime: process.endTime,
            output: process.output,
        };
    });

    // Stream script output via Server-Sent Events
    fastify.get<{
        Params: { id: string };
    }>('/api/scripts/stream/:id', async (request, reply) => {
        const { id } = request.params;
        const process = scriptRunner.getProcess(id);

        if (!process) {
            return reply.code(404).send({ error: 'Process not found' });
        }

        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
            'Access-Control-Allow-Origin': '*',
        });

        if (typeof (reply.raw as any).flushHeaders === 'function') {
            try { (reply.raw as any).flushHeaders(); } catch { }
        }

        // Kick-start the SSE stream with an initial comment to open the pipe immediately
        reply.raw.write(`: stream-open\n\n`);

        // Heartbeat to keep the connection alive and help certain renderers repaint timely
        const heartbeat = setInterval(() => {
            try {
                reply.raw.write(`event: ping\n` + `data: {}\n\n`);
            } catch { }
        }, 15000);

        // Send existing output
        for (const line of process.output) {
            reply.raw.write(`data: ${JSON.stringify({ type: 'output', data: line })}\n\n`);
        }

        // Subscribe to new output
        const unsubscribeOutput = scriptRunner.subscribeToOutput(id, (data) => {
            // Do not spread to avoid overriding the top-level 'type'.
            // Normalize into { type: 'output', stream: 'stdout'|'stderr', data: string }
            const payload = { type: 'output', stream: data.type, data: data.data };
            reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        });

        const unsubscribeExit = scriptRunner.subscribeToExit(id, (data) => {
            reply.raw.write(`data: ${JSON.stringify({ type: 'exit', ...data })}\n\n`);
            clearInterval(heartbeat);
            reply.raw.end();
        });

        request.raw.on('close', () => {
            if (unsubscribeOutput) unsubscribeOutput();
            if (unsubscribeExit) unsubscribeExit();
            clearInterval(heartbeat);
        });
    });

    // Kill script process
    fastify.post<{
        Params: { id: string };
    }>('/api/scripts/kill/:id', async (request) => {
        const { id } = request.params;
        const killed = scriptRunner.killProcess(id);

        if (!killed) {
            // If process not found, consider it already terminated
            return { success: true, message: 'Process already terminated or not found' };
        }

        return { success: true, message: 'Process terminated' };
    });
    // Send input to script process
    fastify.post<{
        Params: { id: string };
        Body: { data: string };
    }>('/api/scripts/input/:id', async (request, reply) => {
        const { id } = request.params;
        const { data } = request.body || {};

        const success = scriptRunner.writeInput(id, data);

        if (!success) {
            return reply.code(400).send({ error: 'Failed to write input (process not found or exited)' });
        }

        return { success: true };
    });
}
