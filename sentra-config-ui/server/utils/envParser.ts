import { readFileSync, writeFileSync, existsSync } from 'fs';
import { EnvVariable } from '../types';

/**
 * 解析 .env 文件内容
 */
export function parseEnvFile(content: string): EnvVariable[] {
  const lines = content.split('\n');
  const variables: EnvVariable[] = [];
  let currentComment = '';

  for (const line of lines) {
    const trimmed = line.trim();

    // 处理注释
    if (trimmed.startsWith('#')) {
      currentComment = trimmed.substring(1).trim();
      continue;
    }

    // 处理空行
    if (!trimmed) {
      currentComment = '';
      continue;
    }

    // 解析变量
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();

      // 移除引号
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }

      variables.push({
        key,
        value,
        comment: currentComment || undefined,
      });

      currentComment = '';
    }
  }

  return variables;
}

/**
 * 将变量数组序列化为 .env 文件内容
 */
export function serializeEnvFile(variables: EnvVariable[]): string {
  const lines: string[] = [];

  for (const variable of variables) {
    // 添加注释
    if (variable.comment) {
      lines.push(`# ${variable.comment}`);
    }

    // 添加变量（如果值包含空格或特殊字符，加引号）
    const needsQuotes = /[\s#]/.test(variable.value);
    const value = needsQuotes ? `"${variable.value}"` : variable.value;
    lines.push(`${variable.key}=${value}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * 读取 .env 文件
 */
export function readEnvFile(filePath: string): EnvVariable[] {
  if (!existsSync(filePath)) {
    return [];
  }
  const content = readFileSync(filePath, 'utf-8');
  return parseEnvFile(content);
}

/**
 * 写入 .env 文件
 */
export function writeEnvFile(filePath: string, variables: EnvVariable[]): void {
  const content = serializeEnvFile(variables);
  writeFileSync(filePath, content, 'utf-8');
}
