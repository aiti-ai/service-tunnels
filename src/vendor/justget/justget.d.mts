/**
 * justget bundle 的类型声明（src/vendor/justget/justget.mjs 的 .d.mts）。
 *
 * justget 是自有包（justdb/justget），打包进单文件后保留最小类型面：
 * tools.ts 只用到 download。完整类型见原包 dist/*.d.ts。
 */

export interface JustgetConfig {
  /** 单请求超时（ms） */
  timeout?: number;
  /** 连接超时（ms） */
  connectTimeout?: number;
  /** 重试次数 */
  retries?: number;
  /** 重试延迟（ms） */
  retryDelay?: number;
  /** 每源失败即交给镜像 */
  onComplete?: (result: JustgetResult) => void;
  [key: string]: unknown;
}

export interface JustgetResult {
  url: string;
  output: string;
  duration: number;
  /** 实际使用的源（官方或镜像） */
  source?: string;
  [key: string]: unknown;
}

export interface DownloadOptions {
  /** 官方源 URL（必填） */
  url: string;
  /** 输出文件路径（必填） */
  output: string;
  /** 镜像源（官方失败时接管） */
  mirrors?: string[];
  options?: JustgetConfig;
}

/** 多源竞速分块下载。 */
export function download(options: DownloadOptions): Promise<JustgetResult>;

export class Downloader {
  constructor(options?: DownloadOptions);
  download(options: DownloadOptions): Promise<JustgetResult>;
}

export const DEFAULT_CONFIG: JustgetConfig;
export function mergeConfig(userConfig?: JustgetConfig): JustgetConfig;
