export interface AppConfig {
  readonly appName: string;
  readonly port: number;
  readonly environment: 'development' | 'test' | 'production';
  readonly enableAuditLog: boolean;
}

export class ConfigError extends Error {
  constructor(issues: string[]) {
    super(`設定錯誤：${issues.join('；')}`);
    this.name = 'ConfigError';
  }
}

// 匯入模組時不讀 process.env；由入口顯式傳入，測試也可提供獨立資料。
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const issues: string[] = [];
  const appName = env.APP_NAME?.trim() ?? '';
  if (appName.length === 0) {
    issues.push('APP_NAME 必須是非空字串');
  }

  const rawPort = env.PORT ?? '';
  const port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push('PORT 必須是 1–65535 的十進位整數');
  }

  const rawEnvironment = env.NODE_ENV ?? 'development';
  let environment: AppConfig['environment'] = 'development';
  if (rawEnvironment === 'development' || rawEnvironment === 'test' || rawEnvironment === 'production') {
    environment = rawEnvironment;
  } else {
    issues.push('NODE_ENV 只接受 development、test、production');
  }

  const rawAudit = env.ENABLE_AUDIT_LOG ?? 'false';
  if (rawAudit !== 'true' && rawAudit !== 'false') {
    issues.push('ENABLE_AUDIT_LOG 只接受 true 或 false');
  }

  if (issues.length > 0) {
    // 錯誤列出欄位與規則，不回顯可能含敏感資訊的原始值。
    throw new ConfigError(issues);
  }

  return Object.freeze({
    appName,
    port,
    environment,
    enableAuditLog: rawAudit === 'true',
  });
}
