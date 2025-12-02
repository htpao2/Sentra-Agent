/**
 * Sentra Agent 统一日志模块
 * 使用 chalk 提供彩色输出，结构化日志格式
 */

import chalk from 'chalk';
import { getEnv } from './envHotReloader.js';

/**
 * 日志级别定义
 */
const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  SUCCESS: 2,
  WARN: 3,
  ERROR: 4
};

/**
 * 格式化时间戳
 */
function getTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString('zh-CN', { 
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/**
 * Logger 类
 */
class Logger {
  constructor(options = {}) {
    this.moduleName = options.moduleName || 'App';
    const levelName = getEnv('LOG_LEVEL', '').toUpperCase();
    this.minLevel = LogLevel[levelName] ?? LogLevel.INFO;
    this.enableTimestamp = options.enableTimestamp !== false;
  }

  /**
   * 格式化模块名标签
   */
  _formatModule() {
    return chalk.gray(`[${this.moduleName}]`);
  }

  /**
   * 格式化时间戳
   */
  _formatTimestamp() {
    return this.enableTimestamp ? chalk.gray(getTimestamp()) : '';
  }

  /**
   * 调试日志（青色，更清晰）
   */
  debug(message, ...args) {
    if (this.minLevel > LogLevel.DEBUG) return;
    const prefix = `${this._formatTimestamp()} ${chalk.cyan('[DEBUG]')} ${this._formatModule()}`;
    console.log(prefix, chalk.white(message), ...args);
  }

  /**
   * 信息日志（蓝色）
   */
  info(message, ...args) {
    if (this.minLevel > LogLevel.INFO) return;
    const prefix = `${this._formatTimestamp()} ${chalk.blue('[INFO]')} ${this._formatModule()}`;
    console.log(prefix, chalk.blue(message), ...args);
  }

  /**
   * 成功日志（绿色）
   */
  success(message, ...args) {
    if (this.minLevel > LogLevel.SUCCESS) return;
    const prefix = `${this._formatTimestamp()} ${chalk.green('[OK]')} ${this._formatModule()}`;
    console.log(prefix, chalk.green(message), ...args);
  }

  /**
   * 警告日志（黄色）
   */
  warn(message, ...args) {
    if (this.minLevel > LogLevel.WARN) return;
    const prefix = `${this._formatTimestamp()} ${chalk.yellow('[WARN]')} ${this._formatModule()}`;
    console.warn(prefix, chalk.yellow(message), ...args);
  }

  /**
   * 错误日志（红色）
   */
  error(message, error, ...args) {
    if (this.minLevel > LogLevel.ERROR) return;
    const prefix = `${this._formatTimestamp()} ${chalk.red('[ERROR]')} ${this._formatModule()}`;
    console.error(prefix, chalk.red(message), ...args);
    if (error && error.stack) {
      console.error(chalk.red(error.stack));
    }
  }

  /**
   * 配置信息日志（专用于启动配置输出）
   */
  config(title, configs) {
    if (this.minLevel > LogLevel.INFO) return;
    console.log(`${this._formatTimestamp()} ${chalk.cyan('[CONFIG]')} ${this._formatModule()} ${chalk.cyan.bold(title)}`);
    Object.entries(configs).forEach(([key, value]) => {
      const formattedKey = chalk.cyan(`  ${key}:`);
      const formattedValue = typeof value === 'number' 
        ? chalk.white(value) 
        : chalk.white(String(value));
      console.log(`${formattedKey} ${formattedValue}`);
    });
  }

  /**
   * 性能日志（专用于性能指标）
   */
  perf(operation, duration) {
    if (this.minLevel > LogLevel.DEBUG) return;
    const durationStr = duration < 1000 
      ? `${duration}ms` 
      : `${(duration / 1000).toFixed(2)}s`;
    const prefix = `${this._formatTimestamp()} ${chalk.magenta('[PERF]')} ${this._formatModule()}`;
    console.log(prefix, chalk.magenta(`${operation}:`), chalk.white(durationStr));
  }

  /**
   * 数据日志（专用于结构化数据输出）
   */
  data(label, data) {
    if (this.minLevel > LogLevel.DEBUG) return;
    const prefix = `${this._formatTimestamp()} ${chalk.gray('[DATA]')} ${this._formatModule()}`;
    console.log(prefix, chalk.white(label));
    console.dir(data, { depth: 3, colors: true });
  }

  /**
   * 分隔线
   */
  divider(char = '─', length = 60) {
    if (this.minLevel > LogLevel.INFO) return;
    console.log(chalk.gray(char.repeat(length)));
  }

  /**
   * 标题日志（用于模块启动标题）
   */
  title(text) {
    if (this.minLevel > LogLevel.INFO) return;
    const border = '='.repeat(text.length + 4);
    console.log(chalk.cyan.bold(border));
    console.log(chalk.cyan.bold(`  ${text}  `));
    console.log(chalk.cyan.bold(border));
  }

  /**
   * 表格日志（用于展示键值对）
   */
  table(data) {
    if (this.minLevel > LogLevel.INFO) return;
    const entries = Array.isArray(data) ? data : Object.entries(data);
    const maxKeyLength = Math.max(...entries.map(([k]) => String(k).length));
    
    entries.forEach(([key, value]) => {
      const paddedKey = String(key).padEnd(maxKeyLength);
      console.log(`  ${chalk.gray(paddedKey)} ${chalk.white(':')} ${chalk.white(value)}`);
    });
  }
}

/**
 * 创建 Logger 实例的工厂函数
 */
export function createLogger(moduleName, options = {}) {
  return new Logger({ ...options, moduleName });
}

/**
 * 默认全局 Logger
 */
export const logger = new Logger({ moduleName: 'Sentra' });

export default logger;
