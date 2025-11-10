import { FastifyInstance } from 'fastify';
import { scanAllConfigs } from '../utils/configScanner';
import { writeEnvFile } from '../utils/envParser';
import { join } from 'path';
import { EnvVariable } from '../types';

export async function configRoutes(fastify: FastifyInstance) {
  // 获取所有配置
  fastify.get('/api/configs', async (request, reply) => {
    try {
      const configs = scanAllConfigs();
      return configs;
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to scan configurations',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 保存模块配置
  fastify.post<{
    Body: { moduleName: string; variables: EnvVariable[] };
  }>('/api/configs/module', async (request, reply) => {
    try {
      const { moduleName, variables } = request.body;
      
      if (!moduleName || !variables) {
        return reply.code(400).send({ error: 'Missing moduleName or variables' });
      }

      const modulePath = join(process.cwd(), '..', moduleName);
      const envPath = join(modulePath, '.env');

      writeEnvFile(envPath, variables);

      return { success: true, message: `Configuration saved for ${moduleName}` };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to save configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 保存插件配置
  fastify.post<{
    Body: { pluginName: string; variables: EnvVariable[] };
  }>('/api/configs/plugin', async (request, reply) => {
    try {
      const { pluginName, variables } = request.body;
      
      if (!pluginName || !variables) {
        return reply.code(400).send({ error: 'Missing pluginName or variables' });
      }

      const pluginPath = join(process.cwd(), '..', 'sentra-mcp', 'plugins', pluginName);
      const envPath = join(pluginPath, '.env');

      writeEnvFile(envPath, variables);

      return { success: true, message: `Configuration saved for plugin ${pluginName}` };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to save plugin configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
