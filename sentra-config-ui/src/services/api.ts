import { ConfigData, EnvVariable } from '../types/config';

const API_BASE = '/api';

export async function fetchConfigs(): Promise<ConfigData> {
  const response = await fetch(`${API_BASE}/configs`);
  if (!response.ok) {
    throw new Error('Failed to fetch configurations');
  }
  return response.json();
}

export async function saveModuleConfig(
  moduleName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/module`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ moduleName, variables }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save module configuration');
  }
}

export async function savePluginConfig(
  pluginName: string,
  variables: EnvVariable[]
): Promise<void> {
  const response = await fetch(`${API_BASE}/configs/plugin`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pluginName, variables }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to save plugin configuration');
  }
}
