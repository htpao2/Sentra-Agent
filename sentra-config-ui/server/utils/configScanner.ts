import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ModuleConfig, PluginConfig, ConfigData } from '../types';
import { readEnvFile } from './envParser';

const ROOT_DIR = resolve(process.cwd(), '..');

// 要扫描的模块目录
const MODULES = [
  'sentra-prompts',
  'sentra-mcp',
  'sentra-emo',
  'sentra-adapter',
];

/**
 * 扫描单个模块的配置
 */
function scanModule(moduleName: string): ModuleConfig {
  const modulePath = join(ROOT_DIR, moduleName);
  const envPath = join(modulePath, '.env');
  const examplePath = join(modulePath, '.env.example');

  const hasEnv = existsSync(envPath);
  const hasExample = existsSync(examplePath);

  const variables = hasEnv ? readEnvFile(envPath) : [];
  const exampleVariables = hasExample ? readEnvFile(examplePath) : undefined;

  return {
    name: moduleName,
    path: modulePath,
    hasEnv,
    hasExample,
    variables,
    exampleVariables,
  };
}

/**
 * 扫描插件目录
 */
function scanPlugins(): PluginConfig[] {
  const pluginsDir = join(ROOT_DIR, 'sentra-mcp', 'plugins');
  if (!existsSync(pluginsDir)) {
    return [];
  }

  const plugins: PluginConfig[] = [];
  const entries = readdirSync(pluginsDir);

  for (const entry of entries) {
    const pluginPath = join(pluginsDir, entry);
    
    // 跳过文件，只处理目录
    if (!statSync(pluginPath).isDirectory()) {
      continue;
    }

    const envPath = join(pluginPath, '.env');
    const examplePath = join(pluginPath, '.env.example');
    const configPath = join(pluginPath, 'config.json');

    const hasEnv = existsSync(envPath);
    const hasExample = existsSync(examplePath);
    const hasConfigJson = existsSync(configPath);

    const variables = hasEnv ? readEnvFile(envPath) : [];
    const exampleVariables = hasExample ? readEnvFile(examplePath) : undefined;

    let configJson = undefined;
    if (hasConfigJson) {
      try {
        const configContent = readFileSync(configPath, 'utf-8');
        configJson = JSON.parse(configContent);
      } catch (error) {
        console.error(`Failed to parse config.json for plugin ${entry}:`, error);
      }
    }

    plugins.push({
      name: entry,
      path: pluginPath,
      hasEnv,
      hasExample,
      hasConfigJson,
      variables,
      exampleVariables,
      configJson,
    });
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 扫描所有配置
 */
export function scanAllConfigs(): ConfigData {
  const modules = MODULES.map(scanModule);
  const plugins = scanPlugins();

  return {
    modules,
    plugins,
  };
}
