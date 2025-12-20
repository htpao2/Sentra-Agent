import { readFileSync, writeFileSync, existsSync } from 'fs';
import { EnvVariable } from '../types';

/**
 * 解析 .env 文件内容
 */
export function parseEnvFile(content: string): EnvVariable[] {
  const lines = content.split('\n');
  const variables: EnvVariable[] = [];
  // 支持连续多行注释块：第一行为说明，后续行为 type / range / options 等元数据
  let currentCommentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // 处理注释（支持多行）
    if (trimmed.startsWith('#')) {
      const text = trimmed.substring(1).trim();
      if (text) {
        currentCommentLines.push(text);
      }
      continue;
    }

    // 处理空行：结束当前注释块，避免泄露到下一组配置
    if (!trimmed) {
      currentCommentLines = [];
      continue;
    }

    // 解析变量
    const equalIndex = trimmed.indexOf('=');
    if (equalIndex > 0) {
      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();

      // 移除引号
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.substring(1, value.length - 1);
      }

      variables.push({
        key,
        value,
        comment: currentCommentLines.length ? currentCommentLines.join('\n') : undefined,
      });

      // 重置注释缓冲，下一条变量重新开始
      currentCommentLines = [];
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
    // 添加注释：支持多行，逐行加上 #
    if (variable.comment) {
      const commentLines = variable.comment.split(/\r?\n/);
      for (const c of commentLines) {
        const text = c.trim();
        if (text) {
          lines.push(`# ${text}`);
        } else {
          lines.push('#');
        }
      }
    }

    // 添加变量（如果值包含空格或特殊字符，加引号）
    const needsQuotes = /[\s#]/.test(variable.value);
    const value = needsQuotes ? `"${variable.value}"` : variable.value;
    lines.push(`${variable.key}=${value}`);
    // 在每个配置块之间保留一个空行以增强可读性
    lines.push('');
  }

  // 去掉最后可能多余的空行
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
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
 * 规则：如果同目录下存在 .env.example，则不允许删除 .env.example 中定义的变量
 */
export function writeEnvFile(filePath: string, variables: EnvVariable[]): void {
  // Check if .env.example exists in the same directory
  const examplePath = filePath.replace(/\.env$/, '.env.example');

  if (existsSync(examplePath)) {
    // Read .env.example to get protected variable keys
    const exampleContent = readFileSync(examplePath, 'utf-8');
    const exampleVars = parseEnvFile(exampleContent);
    const protectedKeys = new Set(exampleVars.map(v => v.key));

    // Read current .env to check if any protected variables are being deleted
    if (existsSync(filePath)) {
      const currentVars = readEnvFile(filePath);
      const currentKeys = new Set(currentVars.map(v => v.key));
      const newKeys = new Set(variables.map(v => v.key));

      // Check if any protected variable is being deleted
      for (const protectedKey of protectedKeys) {
        if (currentKeys.has(protectedKey) && !newKeys.has(protectedKey)) {
          throw new Error(`Cannot delete variable "${protectedKey}" because it exists in .env.example`);
        }
      }
    }
  }

  const content = serializeEnvFile(variables);
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * 合并 .env 和 .env.example
 * 1. 补全 .env 中缺失的 key (来自 example)
 * 2. 优先使用 example 中的注释
 */
export function mergeEnvWithExample(envVars: EnvVariable[], exampleVars: EnvVariable[]): EnvVariable[] {
  // 复制一份 envVars 以免修改原数组
  const result = [...envVars];
  const envKeyMap = new Map(result.map((v, i) => [v.key, i]));

  for (const exVar of exampleVars) {
    if (envKeyMap.has(exVar.key)) {
      // Key 存在：检查是否需要更新注释
      // 规则：如果 example 有注释，强制使用 example 的注释
      if (exVar.comment) {
        const index = envKeyMap.get(exVar.key)!;
        result[index].comment = exVar.comment;
      }
    } else {
      // Key 不存在：从 example 补充
      result.push({ ...exVar });
    }
  }

  return result;
}
