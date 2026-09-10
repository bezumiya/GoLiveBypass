import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import { app } from 'electron';
import { spawn } from 'child_process';
import * as logger from './logger';
import { randomUUID } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { RouteProbeResult } from './route-proof';
import type { ProtonRouteMetadata } from './route-failover';
import {
  ensureProtonConfgen as ensureProtonConfgenRuntime,
  findProtonConfgenPath,
  protonConfgenCandidates,
  type ProtonRuntimeContext,
} from './proton-runtime';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type ProtonLoginErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'TWO_FACTOR_REQUIRED'
  | 'TWO_FACTOR_INVALID'
  | 'CAPTCHA_REQUIRED'
  | 'CAPTCHA_INVALID'
  | 'CAPTCHA_CANCELLED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'MISSING_EXECUTABLE'
  | 'SESSION_PERSISTENCE'
  | 'CONFIGURATION_ERROR'
  | 'UNKNOWN';

export interface ProtonLoginResult {
  success: boolean;
  username?: string;
  code?: ProtonLoginErrorCode;
  message?: string;
  error?: string;
  retryable?: boolean;
  captchaUrl?: string;
}

export type ProtonPlanStatus = 'free' | 'premium' | 'unknown';

export interface ProtonPlanResult {
  success: boolean;
  status: ProtonPlanStatus;
  maxTier?: number;
  planName?: string;
  planTitle?: string;
  checkedAt?: string;
  error?: string;
}

const GENERIC_PLAN_ERROR = 'Não foi possível confirmar o plano Proton.';

export interface ProtonSettings {
  vpnMode: 'proton' | 'custom';
  username: string;
  country: string; // "" for AUTO, or "US", "NL", "JP", etc.
  freeOnly: boolean;
  autoPing: boolean;
  lastServer?: {
    name: string;
    country: string;
    city: string;
    tier: string;
    load: number;
    score: number;
    pingMs: number;
    endpoint: string;
    updatedAt: string;
  };
}

export function findProtonConfgenExe(): string {
  const context = protonRuntimeContext();
  const found = findProtonConfgenPath(context);
  if (found) return found;
  const exeName = process.platform === 'win32' ? 'proton-confgen.exe' : 'proton-confgen';
  throw new Error(`Executável ${exeName} não foi encontrado. Caminhos verificados: ${protonConfgenCandidates(context).slice(0, 4).join(', ')}`);
}

function protonRuntimeContext(): ProtonRuntimeContext {
  let appPath = '';
  try {
    appPath = app.getAppPath();
  } catch {}
  return {
    resourcesPath: process.resourcesPath,
    appPath,
    execPath: process.execPath,
    cwd: process.cwd(),
    moduleDir,
    platform: process.platform,
    arch: process.arch,
  };
}

export function ensureProtonConfgen(installDir: string): Promise<string> {
  let version = process.env.npm_package_version || '0.0.0-dev';
  try {
    if (app && typeof app.getVersion === 'function') version = app.getVersion();
  } catch {}
  return ensureProtonConfgenRuntime({ context: protonRuntimeContext(), installDir, version });
}

export interface RunConfgenOptions {
  args: string[];
  timeoutMs?: number;
  exePath?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ProtonOptimizationProgress) => void;
}

// Increment when the route triage changes so a profile measured by an older
// pipeline is not reused as if it had gone through the complete twelve-route
// tunnel preflight.
export const MEASUREMENT_CRITERION_VERSION = 5;

export interface ProtonOptimizationProgress {
  phase: 'ping' | 'catalog' | 'preparing' | 'testing' | 'finalizing' | 'completed' | 'failed' | 'cancelled';
  total: number;
  tested: number;
  succeeded: number;
  server?: string;
  country?: string;
  city?: string;
  tier?: string;
  load?: number;
  score?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  pingMs?: number;
  status?: 'testing' | 'success' | 'failed';
}

export function recordManualMeasurementProgress(
  session: {
    measurementId: string;
    candidates: Map<string, any>;
    expiresAt: number;
  } | undefined,
  measurementId: string,
  progress: ProtonOptimizationProgress,
): void {
  if (!session || session.measurementId !== measurementId || !progress.server || progress.phase === 'catalog') return;
  const current = session.candidates.get(progress.server) ?? {
    server: progress.server,
    pingStatus: 'not-tested',
    preflightStatus: 'not-tested',
    speedStatus: 'not-tested',
  };
  const status = progress.status === 'success' ? 'success' : progress.status === 'failed' ? 'failed' : 'pending';
  if (Number.isFinite(progress.pingMs) && progress.pingMs > 0 && progress.pingMs < 999) current.pingMs = progress.pingMs;
  if (Number.isFinite(progress.downloadMbps) && progress.downloadMbps > 0) current.downloadMbps = progress.downloadMbps;
  if (Number.isFinite(progress.uploadMbps) && progress.uploadMbps > 0) current.uploadMbps = progress.uploadMbps;
  if (progress.phase === 'ping') current.pingStatus = status;
  else if (progress.phase === 'preparing') current.preflightStatus = status;
  else if (progress.phase === 'testing') current.speedStatus = status;
  if (progress.status === 'failed') current.failureReason = progress.phase === 'preparing'
    ? 'Falha no túnel ou HTTPS'
    : progress.phase === 'ping' ? 'Sem resposta ao ping' : 'Não foi possível medir a velocidade';
  session.candidates.set(progress.server, current);
  session.expiresAt = Date.now() + 10 * 60_000;
}

function abortError(): Error {
  const error = new Error('Operação Proton cancelada.');
  error.name = 'AbortError';
  return error;
}

function safeConfgenArgs(args: string[]): string {
  return args.map((arg, index) => {
    const previous = args[index - 1] || '';
    if (/^-?(?:password|2fa|hv-token|session-file)$/i.test(previous)) return '[redacted]';
    if (/^-?username$/i.test(previous)) return '[account]';
    return logger.clipLogText(arg, 160);
  }).join(' ');
}

function validProgress(value: any): ProtonOptimizationProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const phases = ['ping', 'catalog', 'preparing', 'testing', 'finalizing', 'completed', 'failed', 'cancelled'];
  if (!phases.includes(value.phase)) return undefined;
  const total = Number.isFinite(value.total) ? Math.max(0, Math.floor(value.total)) : 0;
  const tested = Number.isFinite(value.tested) ? Math.max(0, Math.min(total, Math.floor(value.tested))) : 0;
  const succeeded = Number.isFinite(value.succeeded) ? Math.max(0, Math.min(tested, Math.floor(value.succeeded))) : 0;
  const result: ProtonOptimizationProgress = { phase: value.phase, total, tested, succeeded };
  for (const key of ['server', 'country', 'city', 'tier'] as const) {
    if (typeof value[key] === 'string' && value[key].length <= 200) result[key] = value[key];
  }
  for (const key of ['downloadMbps', 'uploadMbps', 'pingMs', 'load', 'score'] as const) {
    if (Number.isFinite(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  if (value.status === 'testing' || value.status === 'success' || value.status === 'failed') result.status = value.status;
  return result;
}

export function parseConfgenJson(stdout: string): any | undefined {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // Linhas de progresso podem se parecer com JSON incompleto; tente a anterior.
    }
  }
  return undefined;
}

export function runConfgen(options: RunConfgenOptions): Promise<{ code: number | null; stdout: string; stderr: string; json?: any }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return; }
    let exe: string;
    try {
      exe = options.exePath ? path.resolve(options.exePath) : findProtonConfgenExe();
    } catch (err) {
      reject(err);
      return;
    }

    const timeout = options.timeoutMs ?? 25000;
    const operationId = logger.createOperationId('proton-confgen');
    const startedAt = Date.now();
    const logContext = {
      operation_id: operationId,
      phase: 'confgen',
      executable: path.basename(exe),
      timeout_ms: timeout,
    };
    logger.logEvent('info', 'proton', 'confgen.start', logContext, {
      args: safeConfgenArgs(options.args),
    });
    const child = spawn(exe, options.args, {
      windowsHide: true,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = Boolean(options.signal?.aborted);
    let terminationError: Error | undefined;
    let stderrBuffer = '';
    const stderrDecoder = new StringDecoder('utf8');
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const emitProgress = (chunk: string) => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 128 * 1024) stderrBuffer = stderrBuffer.slice(-128 * 1024);
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || '';
      for (const line of lines) {
        const match = line.match(/^\s*GOLIVE_PROGRESS\s+(\{.*\})\s*$/);
        if (!match) continue;
        try { const progress = validProgress(JSON.parse(match[1])); if (progress && !terminationError) options.onProgress?.(progress); } catch {}
      }
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.logEvent('error', 'proton', 'confgen.failed', logContext, {
        durationMs: Date.now() - startedAt,
        error: error.message,
        aborted,
      });
      reject(error);
    };
    const killAndWait = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill(); } catch { /* Close remains the cleanup boundary. */ }
      killTimer = setTimeout(() => {
        if (!settled) { try { child.kill('SIGKILL'); } catch {} }
      }, 1000);
      killTimer.unref?.();
    };

    const timer = setTimeout(() => {
      killAndWait(new Error(`Tempo limite excedido (${timeout / 1000}s) ao executar proton-confgen.`));
    }, timeout);

    const abort = () => { aborted = true; killAndWait(abortError()); };
    options.signal?.addEventListener('abort', abort, { once: true });

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d: Buffer) => {
      const text = stderrDecoder.write(d); stderr += text; emitProgress(text);
    });

    child.on('error', (err) => {
      // Node emits close after spawn errors too. Never remove an executable
      // or staged profile while its process may still be using it.
      terminationError ??= err;
    });

    child.on('close', (code) => {
      if (settled) return;
      const tail = stderrDecoder.end();
      stderr += tail;
      if (stderrBuffer || tail) emitProgress(tail + '\n');
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (terminationError || aborted) { finishReject(terminationError || abortError()); return; }
      const parsedJson = parseConfgenJson(stdout);
      settled = true;
      logger.logEvent(code === 0 ? 'info' : 'warn', 'proton', 'confgen.complete', logContext, {
        durationMs: Date.now() - startedAt,
        exitCode: code,
        stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf8'),
        json: Boolean(parsedJson),
        stderrTail: logger.clipLogText(stderr, 1200),
      });
      resolve({ code, stdout, stderr, json: parsedJson });
    });
    if (aborted) abort();
  });
}

export async function runRouteProbeFrom(exePath: string | undefined, timeoutMs = 10_000): Promise<RouteProbeResult> {
  const res = await runConfgen({ args: ['--route-probe', '--json'], timeoutMs, exePath });
  const value = res.json as Partial<RouteProbeResult> | undefined;
  if (!value || typeof value.success !== 'boolean' || (value.observations !== undefined && !Array.isArray(value.observations))) {
    return {
      success: false,
      observations: [],
      discordOk: false,
      error: (res.stderr || res.stdout || 'resposta inválida do probe de rota').trim().slice(0, 300),
    };
  }
  return {
    success: value.success,
    observations: value.observations ?? [],
    discordOk: value.discordOk === true,
    discordMs: typeof value.discordMs === 'number' ? value.discordMs : undefined,
    error: typeof value.error === 'string' ? value.error.slice(0, 300) : undefined,
  };
}

export async function runRouteProbe(timeoutMs = 10_000): Promise<RouteProbeResult> {
  return runRouteProbeFrom(undefined, timeoutMs);
}

export function classifyProtonError(error: unknown, stderr = '', stdout = ''): { code: ProtonLoginErrorCode; message: string; retryable: boolean } {
  const raw = `${error instanceof Error ? error.message : String(error)} ${stderr} ${stdout}`.toLowerCase();
  if (/captcha_invalid|captcha.*expired|human verification.*(invalid|expired)/.test(raw)) return { code: 'CAPTCHA_INVALID', message: 'A verificação de segurança expirou ou foi recusada. Abra um novo CAPTCHA e tente novamente.', retryable: true };
  if (/captcha_required|captcha verification required|human verification required|code 9001/.test(raw)) return { code: 'CAPTCHA_REQUIRED', message: 'O Proton solicitou uma verificação de segurança. Abra o CAPTCHA e tente novamente.', retryable: true };
  if (/2fa_required|two.?factor|required.*2fa/.test(raw)) return { code: 'TWO_FACTOR_REQUIRED', message: 'Esta conta exige autenticação em duas etapas.', retryable: false };
  if (/2fa|two.?factor|totp|verification code/.test(raw)) return { code: 'TWO_FACTOR_INVALID', message: 'O código 2FA está incorreto ou expirou.', retryable: false };
  // "authentication failed" não é sinal de credencial: o helper Go embrulha
  // qualquer falha de autenticação (transporte, protocolo, captcha) com esse
  // prefixo. Só texto explícito de credencial pode acusar senha errada.
  if (/invalid credential|invalid password|wrong password|incorrect/.test(raw)) return { code: 'INVALID_CREDENTIALS', message: 'Usuário ou senha incorretos.', retryable: false };
  if (/timeout|tempo limite|timed out/.test(raw)) return { code: 'TIMEOUT', message: 'O ProtonVPN demorou demais para responder. Tente novamente em alguns instantes.', retryable: true };
  if (/encontrado|not found|enoent|spawn/.test(raw)) return { code: 'MISSING_EXECUTABLE', message: 'O componente Proton não pôde ser preparado automaticamente. Verifique sua conexão e tente novamente; se persistir, envie um relatório de diagnóstico.', retryable: true };
  if (/network|connection|dns|tls|temporary|unreachable|reset/.test(raw)) return { code: 'NETWORK_ERROR', message: 'Não foi possível conectar aos servidores ProtonVPN. Verifique sua internet e tente novamente.', retryable: true };
  return { code: 'UNKNOWN', message: 'Não foi possível concluir o login ProtonVPN. Tente novamente ou envie um relatório de diagnóstico.', retryable: true };
}

export function getProtonSessionFile(installDir: string): string {
  return path.join(installDir, 'proton-session.json');
}

/** Read only the non-secret identity metadata from the cached session. */
export function getSavedSessionUsername(installDir: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(getProtonSessionFile(installDir), 'utf8'));
    return typeof raw?.username === 'string' ? raw.username.trim() : '';
  } catch {
    return '';
  }
}

export type ProtonSessionConfirmation = {
  confirmed: boolean;
  savedUsername: string;
  attempts: number;
};

export function protonIdentityMatches(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase('en-US') === right.trim().toLocaleLowerCase('en-US');
}

/**
 * Releitura diagnóstica da sessão. O sidecar só retorna sucesso depois de
 * SessionStore.Save concluir; portanto, uma falha aqui não invalida o login.
 * As tentativas cobrem atraso de visibilidade/antivírus no Windows.
 */
export async function confirmSavedSessionIdentity(
  installDir: string,
  expectedUsername: string,
  options: {
    attempts?: number;
    delayMs?: number;
    readUsername?: () => string;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<ProtonSessionConfirmation> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 100);
  const readUsername = options.readUsername ?? (() => getSavedSessionUsername(installDir));
  const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let savedUsername = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    savedUsername = readUsername();
    if (savedUsername && protonIdentityMatches(savedUsername, expectedUsername)) {
      return { confirmed: true, savedUsername, attempts: attempt };
    }
    if (attempt < attempts) await wait(delayMs);
  }
  return { confirmed: false, savedUsername, attempts };
}

function ensureInstallDir(installDir: string) {
  fs.mkdirSync(installDir, { recursive: true });
}

export async function checkProtonSession(
  installDir: string,
  username: string
): Promise<{ valid: boolean; username?: string; expiresIn?: string; error?: string }> {
  if (!username) {
    return { valid: false, error: 'Usuário não especificado.' };
  }

  const sessionFile = getProtonSessionFile(installDir);
  ensureInstallDir(installDir);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
  const res = await runConfgen({
    args: [
      '-username',
      username,
      '-session-file',
      sessionFile,
      '-check-session',
      '-json',
    ],
    timeoutMs: 10000,
    exePath,
  });

  if (res.json && res.json.valid) {
    return {
      valid: true,
      username: res.json.username || username,
      expiresIn: res.json.expiresIn,
    };
  }

  return {
    valid: false,
    error: res.json?.error || res.stderr || 'Sessão inválida ou não encontrada.',
  };
}

/**
 * Accept only the small, non-secret contract emitted by -check-plan. In
 * particular, a missing/invalid MaxTier is never interpreted as Free.
 */
export function normalizeProtonPlanResult(value: any): ProtonPlanResult {
  if (!value || typeof value !== 'object' || value.success !== true) {
    return { success: false, status: 'unknown', error: GENERIC_PLAN_ERROR };
  }

  const maxTier = value.maxTier;
  if (!Number.isInteger(maxTier) || maxTier < 0) {
    return { success: false, status: 'unknown', error: GENERIC_PLAN_ERROR };
  }

  const result: ProtonPlanResult = {
    success: true,
    status: maxTier === 0 ? 'free' : 'premium',
    maxTier,
  };
  for (const key of ['planName', 'planTitle'] as const) {
    if (typeof value[key] === 'string' && value[key].trim() && value[key].length <= 120) {
      result[key] = value[key].trim();
    }
  }
  if (typeof value.checkedAt === 'string' && value.checkedAt.length <= 40) {
    result.checkedAt = value.checkedAt;
  }
  return result;
}

/**
 * Queries the account plan through the saved Proton session only. This does
 * not request a certificate, select a server, or create a WireGuard tunnel.
 */
export async function getProtonPlan(installDir: string, username: string): Promise<ProtonPlanResult> {
  if (!username || !username.trim()) {
    return { success: false, status: 'unknown', error: 'Sessão Proton não encontrada.' };
  }

  ensureInstallDir(installDir);
  const sessionFile = getProtonSessionFile(installDir);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch {
    return { success: false, status: 'unknown', error: GENERIC_PLAN_ERROR };
  }
  let res;
  try {
    res = await runConfgen({
      args: [
        '-username',
        username.trim(),
        '-session-file',
        sessionFile,
        '-check-plan',
        '-json',
      ],
      timeoutMs: 10000,
      exePath,
    });
  } catch {
    return { success: false, status: 'unknown', error: GENERIC_PLAN_ERROR };
  }

  if (res.code !== 0 || !res.json) {
    logger.warn('proton', 'falha ao consultar plano ProtonVPN', {
      codigo_saida: res.code,
      resposta_json: Boolean(res.json),
    });
    return { success: false, status: 'unknown', error: GENERIC_PLAN_ERROR };
  }

  const normalized = normalizeProtonPlanResult(res.json);
  return { ...normalized, checkedAt: new Date().toISOString() };
}

export async function loginProton(
  installDir: string,
  username: string,
  password?: string,
  twoFactorCode?: string,
  humanVerificationToken?: string
): Promise<ProtonLoginResult> {
  try {
    ensureInstallDir(installDir);
  } catch (error) {
    const classified = classifyProtonError(error);
    return { success: false, ...classified, code: 'SESSION_PERSISTENCE', message: 'Não foi possível preparar a pasta de dados para salvar a sessão ProtonVPN.', retryable: false, error: error instanceof Error ? error.message : String(error) };
  }
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    const classified = classifyProtonError(error);
    return { success: false, ...classified, error: error instanceof Error ? error.message : String(error) };
  }
  const sessionFile = getProtonSessionFile(installDir);
  const args = [
    '-username',
    username,
    '-session-file',
    sessionFile,
    '-login-only',
    '-json',
  ];

  if (password) {
    args.push('-password', password);
  }
  if (twoFactorCode) {
    args.push('-2fa', twoFactorCode);
  }
  if (humanVerificationToken) args.push('-hv-token', humanVerificationToken);

  logger.info('proton', 'iniciando autenticação ProtonVPN');
  let res;
  try {
    res = await runConfgen({ args, timeoutMs: 25000, exePath });
  } catch (error) {
    const classified = classifyProtonError(error);
    logger.error('proton', 'falha ao iniciar proton-confgen', { codigo: classified.code, erro: error instanceof Error ? error.message : String(error) });
    return { success: false, ...classified, error: error instanceof Error ? error.message : String(error) };
  }

  if (res.json && res.json.success) {
    logger.info('proton', 'autenticação bem-sucedida');
    return {
      success: true,
      username: typeof res.json.username === 'string' && res.json.username.trim()
        ? res.json.username.trim()
        : username.trim(),
      message: 'Autenticação concluída.',
    };
  }

  if (res.json?.code === 'CAPTCHA_REQUIRED' || res.json?.code === 'CAPTCHA_INVALID') {
    return {
      success: false,
      code: res.json.code,
      message: res.json.error || (res.json.code === 'CAPTCHA_INVALID'
        ? 'A verificação de segurança expirou ou foi recusada.'
        : 'O Proton solicitou uma verificação de segurança.'),
      retryable: res.json.retryable !== false,
      captchaUrl: typeof res.json.captchaUrl === 'string' ? res.json.captchaUrl : undefined,
      error: res.json.error || (res.json.code === 'CAPTCHA_INVALID'
        ? 'A verificação de segurança expirou ou foi recusada.'
        : 'O Proton solicitou uma verificação de segurança.'),
    };
  }

  // O helper Go emite códigos estruturados no JSON (ver jsonErrorResponse).
  // Eles são a fonte da verdade; o regex de texto é só fallback para saída
  // sem JSON (binários antigos) e nunca pode mascarar o código estruturado.
  const structuredCode = typeof res.json?.code === 'string' ? res.json.code : '';
  const structured = structuredProtonError(structuredCode);
  if (structured) {
    logger.warn('proton', 'falha na autenticação ProtonVPN', { codigo_saida: res.code, codigo_estruturado: structuredCode, erro_json: String(res.json?.error || '').slice(0, 300) });
    return { success: false, code: structuredCode as ProtonLoginErrorCode, ...structured, error: structured.message };
  }

  const errorMsg = res.json?.error || res.stderr || res.stdout || 'Falha na autenticação ProtonVPN.';
  const classified = classifyProtonError(errorMsg, res.stderr, res.stdout);
  logger.warn('proton', 'falha na autenticação ProtonVPN', { codigo_saida: res.code, resposta_json: Boolean(res.json), erro_json: String(res.json?.error || '').slice(0, 300) });
  return { success: false, ...classified, error: classified.message };
}

function structuredProtonError(code: string): { message: string; retryable: boolean } | undefined {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return { message: 'Usuário ou senha incorretos.', retryable: false };
    case 'TWO_FACTOR_REQUIRED':
      return { message: 'Esta conta exige autenticação em duas etapas.', retryable: false };
    case 'TWO_FACTOR_INVALID':
      return { message: 'O código 2FA está incorreto ou expirou.', retryable: false };
    case 'NETWORK_ERROR':
      return { message: 'Não foi possível conectar aos servidores ProtonVPN. Verifique sua internet e tente novamente.', retryable: true };
    default:
      return undefined;
  }
}

export async function generateOptimalProtonConfig(
  installDir: string,
  options: {
    username: string;
    countries?: string;
    freeOnly?: boolean;
    autoPing?: boolean;
    speedTest?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: ProtonOptimizationProgress) => void;
  }
): Promise<{
  success: boolean;
  server?: string;
  country?: string;
  city?: string;
  tier?: string;
  load?: number;
  score?: number;
  pingMs?: number;
  downloadMbps?: number;
  uploadMbps?: number;
  speedTested?: number;
  speedSucceeded?: number;
  endpoint?: string;
  confFile?: string;
  error?: string;
}> {
  const sessionFile = getProtonSessionFile(installDir);
  const outputFile = path.join(installDir, 'wireguard.conf');
  ensureInstallDir(installDir);
  const stagingFile = path.join(installDir, `.wireguard.conf.${randomUUID()}.tmp`);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const args = [
    '-username',
    options.username,
    '-session-file',
    sessionFile,
    '-output',
    stagingFile,
    '-json',
    '-ipv6',
    '-exclude-countries',
    'BR',
  ];

  if (options.autoPing !== false) {
    args.push('-auto-ping');
  }
  if (options.speedTest) args.push('-speed-test');

  if (options.freeOnly !== false) {
    args.push('-free-only');
  }

  if (options.countries && options.countries.trim()) {
    args.push('-countries', options.countries.trim());
  }

  logger.info('proton', 'gerando configuração ótima WireGuard ProtonVPN', {
    country: options.countries || 'AUTO',
    autoPing: options.autoPing !== false,
  });

  // Older WireSock filters may include the normal helper. A uniquely named
  // copy outside Discord directories also avoids nesting with those profiles.
  let res;
  try {
    res = options.speedTest
      ? await runIsolatedSpeedSelection(args, options.signal, options.onProgress, exePath)
      : await runConfgen({ args, timeoutMs: 60000, signal: options.signal, onProgress: options.onProgress, exePath });
  } catch (error) {
    try { fs.rmSync(stagingFile, { force: true }); } catch {}
    throw error;
  }

  const measuredResultValid = !options.speedTest ||
    (finitePositive(res.json?.downloadMbps) && finitePositive(res.json?.uploadMbps));
  if (res.code === 0 && res.json && res.json.success && measuredResultValid && fs.existsSync(stagingFile)) {
    if (options.signal?.aborted) {
      try { fs.rmSync(stagingFile, { force: true }); } catch {}
      throw abortError();
    }
    try { fs.renameSync(stagingFile, outputFile); }
    catch (error) {
      try { fs.rmSync(stagingFile, { force: true }); } catch {}
      throw error;
    }
    logger.info('proton', 'servidor ótimo selecionado com sucesso', {
      server: res.json.server,
      ping: res.json.pingMs,
      load: res.json.load,
      downloadMbps: res.json.downloadMbps,
      uploadMbps: res.json.uploadMbps,
      speedTested: res.json.speedTested,
      speedSucceeded: res.json.speedSucceeded,
    });
    return {
      success: true,
      server: res.json.server,
      country: res.json.country,
      city: res.json.city,
      tier: res.json.tier,
      load: res.json.load,
      score: res.json.score,
      pingMs: res.json.pingMs,
      downloadMbps: res.json.downloadMbps,
      uploadMbps: res.json.uploadMbps,
      speedTested: res.json.speedTested,
      speedSucceeded: res.json.speedSucceeded,
      endpoint: res.json.endpoint,
      confFile: outputFile,
    };
  }

  try { fs.rmSync(stagingFile, { force: true }); } catch {}
  const errMsg = res.json?.error || (options.speedTest && res.json?.success
    ? 'A medição não retornou velocidades válidas de download e upload.'
    : undefined) || res.stderr || res.stdout || 'Falha ao selecionar e gerar configuração ProtonVPN.';
  logger.error('proton', 'erro ao gerar configuração ótima', { codigo_saida: res.code, resposta_json: Boolean(res.json) });
  return { success: false, error: errMsg };
}

export interface ProtonManualRouteOptions {
  username: string;
  server: string;
  countries?: string;
  freeOnly?: boolean;
  autoPing?: boolean;
  signal?: AbortSignal;
}

export interface ProtonManualRouteResult {
  success: boolean;
  manual?: boolean;
  server?: string;
  country?: string;
  city?: string;
  tier?: string;
  load?: number;
  score?: number;
  pingMs?: number;
  endpoint?: string;
  preflight?: string;
  confFile?: string;
  staged?: boolean;
  error?: string;
}

function redactManualRouteError(value: unknown, username: string): string {
  const text = String(value ?? '').trim();
  if (!text) return 'Não foi possível validar a rota ProtonVPN selecionada.';
  const account = username.trim();
  if (!account) return text.slice(0, 500);
  const escaped = account.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'gi'), '[account]').slice(0, 500);
}

/**
 * Probes one server chosen by the user and leaves its profile staged. The
 * active profile is promoted by main.ts only after the lifecycle transaction
 * has taken a backup, so a failed manual selection cannot replace a working
 * route.
 */
export async function generateManualProtonConfig(
  installDir: string,
  options: ProtonManualRouteOptions,
): Promise<ProtonManualRouteResult> {
  const username = typeof options.username === 'string' ? options.username.trim() : '';
  const server = typeof options.server === 'string' ? options.server.trim() : '';
  if (!username) return { success: false, error: 'Nenhuma conta ProtonVPN conectada.' };
  if (!server) return { success: false, error: 'Nenhuma rota ProtonVPN foi selecionada.' };

  ensureInstallDir(installDir);
  const sessionFile = getProtonSessionFile(installDir);
  const stagingFile = path.join(installDir, `.manual-proton-route.${randomUUID()}.tmp`);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    return { success: false, error: redactManualRouteError(error, username) };
  }

  const args = [
    '-username', username,
    '-session-file', sessionFile,
    '-server', server,
    '-output', stagingFile,
    '-json',
    '-ipv6',
    '-manual-probe',
    '-exclude-countries', 'BR',
  ];
  if (options.autoPing !== false) args.push('-auto-ping');
  if (options.freeOnly !== false) args.push('-free-only');
  if (options.countries && options.countries.trim()) args.push('-countries', options.countries.trim());

  logger.info('proton', 'validando rota ProtonVPN escolhida manualmente', {
    server,
    country: options.countries || 'AUTO',
    autoPing: options.autoPing !== false,
  });

  let res;
  try {
    res = await runConfgen({
      args,
      timeoutMs: 60_000,
      signal: options.signal,
      exePath,
    });
  } catch (error) {
    removeStagedProtonConfig(stagingFile);
    throw error;
  }

  const json = res.json;
  const pingMs = Number(json?.pingMs);
  const validResult = res.code === 0 && json?.success === true && json?.manual === true &&
    typeof json.server === 'string' && json.server.trim() === server &&
    Number.isFinite(pingMs) && pingMs > 0 && pingMs < 999 &&
    typeof json.endpoint === 'string' && json.endpoint.trim() &&
    fs.existsSync(stagingFile);
  if (validResult) {
    if (options.signal?.aborted) {
      removeStagedProtonConfig(stagingFile);
      throw abortError();
    }
    logger.info('proton', 'rota ProtonVPN manual validada', {
      server,
      ping: pingMs,
      endpoint: json.endpoint,
    });
    return {
      success: true,
      manual: true,
      server,
      country: typeof json.country === 'string' ? json.country : undefined,
      city: typeof json.city === 'string' ? json.city : undefined,
      tier: typeof json.tier === 'string' ? json.tier : undefined,
      load: Number.isFinite(Number(json.load)) ? Number(json.load) : undefined,
      score: Number.isFinite(Number(json.score)) ? Number(json.score) : undefined,
      pingMs,
      endpoint: json.endpoint.trim(),
      preflight: json.preflight === 'success' ? 'success' : undefined,
      confFile: stagingFile,
      staged: true,
    };
  }

  removeStagedProtonConfig(stagingFile);
  const rawError = json?.error || res.stderr || res.stdout ||
    'Não foi possível validar a rota ProtonVPN selecionada.';
  logger.warn('proton', 'rota ProtonVPN manual rejeitada', {
    server,
    codigo_saida: res.code,
    resposta_json: Boolean(json),
  });
  return { success: false, error: redactManualRouteError(rawError, username) };
}

export function removeStagedProtonConfig(stagedFile: string | undefined): void {
  if (!stagedFile) return;
  try { fs.rmSync(stagedFile, { force: true }); } catch {}
}

export function promoteStagedProtonConfig(stagedFile: string, outputFile?: string): void {
  const resolvedStage = path.resolve(stagedFile || '');
  const target = outputFile || path.join(path.dirname(resolvedStage), 'wireguard.conf');
  const resolvedDir = path.dirname(resolvedStage);
  const relative = path.relative(resolvedDir, resolvedStage);
  if (!stagedFile || !relative || relative.startsWith('..') || path.isAbsolute(relative) ||
    !path.basename(resolvedStage).startsWith('.manual-proton-route.')) {
    throw new Error('arquivo staged Proton inválido');
  }
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    if (!fs.existsSync(resolvedStage)) throw new Error('arquivo staged Proton não foi encontrado');
    fs.copyFileSync(resolvedStage, temp);
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

export interface ProtonRouteCatalogEntry {
  server: string;
  country: string;
  city: string;
  tier: string;
  load: number;
  score: number;
  pingMs?: number;
}

export interface ProtonRouteCatalogResult {
  success: boolean;
  routes?: ProtonRouteCatalogEntry[];
  error?: string;
}

/**
 * Fetches public route metadata without issuing a certificate, opening a
 * tunnel, or creating a temporary profile. The existing session authenticates
 * the request so the helper can apply the account's route filters. When
 * measurePing is enabled, the helper also performs its bounded regional ping
 * scan without creating a profile or tunnel.
 */
export async function generateProtonRouteCatalog(
  installDir: string,
  options: {
    username: string;
    countries?: string;
    freeOnly?: boolean;
    excludeServers?: string[];
    measurePing?: boolean;
    signal?: AbortSignal;
    onProgress?: (progress: ProtonOptimizationProgress) => void;
  },
): Promise<ProtonRouteCatalogResult> {
  ensureInstallDir(installDir);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const username = options.username.trim();
  const sessionFile = getProtonSessionFile(installDir);
  const args = [
    '-username', username,
    '-session-file', sessionFile,
    '-route-catalog',
    '-json',
    '-exclude-countries', 'BR',
  ];
  if (options.measurePing) args.push('-auto-ping');
  if (options.onProgress) args.push('-progress-json');
  if (options.countries && options.countries.trim()) args.push('-countries', options.countries.trim());
  if (options.freeOnly !== false) args.push('-free-only');
  const excluded = (options.excludeServers ?? []).map((item) => item.trim()).filter(Boolean);
  if (excluded.length > 0) args.push('-exclude-servers', excluded.join(','));

  const res = await runConfgen({
    args,
    timeoutMs: 60_000,
    signal: options.signal,
    onProgress: options.onProgress,
    exePath,
  });

  const rawRoutes = Array.isArray(res.json?.routes) ? res.json.routes : undefined;
  const routes: ProtonRouteCatalogEntry[] = [];
  let invalidRoute = false;
  for (const raw of rawRoutes ?? []) {
    if (!raw || typeof raw !== 'object') {
      invalidRoute = true;
      continue;
    }
    const server = typeof raw.server === 'string' ? raw.server.trim() : '';
    const country = typeof raw.country === 'string' ? raw.country.trim() : '';
    const city = typeof raw.city === 'string' ? raw.city.trim() : '';
    const tier = typeof raw.tier === 'string' ? raw.tier.trim() : '';
    const load = Number(raw.load);
    const score = Number(raw.score);
    const pingMs = raw.pingMs === undefined ? undefined : Number(raw.pingMs);
    if (!server || server.length > 200 || !country || country.length > 32 || city.length > 200 ||
      !tier || tier.length > 80 || !Number.isFinite(load) || load < 0 || load > 100 ||
      !Number.isFinite(score) || score < 0 ||
      (raw.pingMs !== undefined && (!Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999))) {
      invalidRoute = true;
      continue;
    }
    routes.push({ server, country, city, tier, load, score, ...(pingMs === undefined ? {} : { pingMs }) });
  }

  if (res.code !== 0 || res.json?.success !== true || rawRoutes === undefined || invalidRoute || routes.length === 0) {
    const rawError = res.json?.error || res.stderr || res.stdout ||
      'Não foi possível carregar o catálogo de rotas ProtonVPN.';
    return {
      success: false,
      error: redactManualRouteError(rawError, username),
    };
  }
  return { success: true, routes };
}

export interface ProtonRoutePoolResult {
  success: boolean;
  stagingDir?: string;
  routes?: ProtonRouteMetadata[];
  expiresAt?: number;
  error?: string;
}

/**
 * Generates ping-ranked reserve profiles in an isolated directory. The Go
 * helper does not create temporary tunnels; the active Discord route therefore
 * remains the only WireGuard session while this background work runs.
 */
export async function generateProtonRoutePool(
  installDir: string,
  options: {
    username: string;
    countries?: string;
    freeOnly?: boolean;
    autoPing?: boolean;
    size: number;
    excludeServers?: string[];
    signal?: AbortSignal;
    onProgress?: (progress: ProtonOptimizationProgress) => void;
  },
): Promise<ProtonRoutePoolResult> {
  ensureInstallDir(installDir);
  let exePath: string;
  try {
    exePath = await ensureProtonConfgen(installDir);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const size = Math.max(1, Math.min(3, Math.floor(options.size)));
  const stagingDir = fs.mkdtempSync(path.join(installDir, '.proton-route-pool-'));
  const sessionFile = getProtonSessionFile(installDir);
  const args = [
    '-username', options.username,
    '-session-file', sessionFile,
    '-route-pool',
    '-route-pool-size', String(size),
    '-route-pool-output-dir', stagingDir,
    '-no-save',
    '-json',
    '-ipv6',
    '-exclude-countries', 'BR',
    '-auto-ping',
  ];
  if (options.onProgress) args.push('-progress-json');
  if (options.countries && options.countries.trim()) args.push('-countries', options.countries.trim());
  if (options.freeOnly !== false) args.push('-free-only');
  const excluded = (options.excludeServers ?? []).map((item) => item.trim()).filter(Boolean);
  if (excluded.length > 0) args.push('-exclude-servers', excluded.join(','));

  try {
    const res = await runConfgen({
      args,
      timeoutMs: 120_000,
      signal: options.signal,
      onProgress: options.onProgress,
    });
    const rawRoutes = Array.isArray(res.json?.routes) ? res.json.routes : [];
    const routes: ProtonRouteMetadata[] = [];
    for (const raw of rawRoutes) {
      if (!raw || typeof raw !== 'object') continue;
      const confFile = typeof raw.confFile === 'string' ? path.resolve(raw.confFile) : '';
      const relative = confFile ? path.relative(path.resolve(stagingDir), confFile) : '';
      const pingMs = Number(raw.pingMs);
      const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim() : '';
      if (!confFile || !relative || relative.startsWith('..') || path.isAbsolute(relative) ||
        !fs.existsSync(confFile) || typeof raw.server !== 'string' || !raw.server.trim() ||
        !endpoint || !Number.isFinite(pingMs) || pingMs <= 0 || pingMs >= 999) continue;
      routes.push({
        success: raw.success === true,
        server: raw.server.trim(),
        country: typeof raw.country === 'string' ? raw.country.trim() : '',
        city: typeof raw.city === 'string' ? raw.city.trim() : '',
        tier: typeof raw.tier === 'string' ? raw.tier.trim() : 'Free',
        load: Number.isFinite(Number(raw.load)) ? Number(raw.load) : 0,
        score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
        pingMs,
        endpoint,
        confFile,
        expiresAt: Number.isFinite(Number(raw.expiresAt)) ? Number(raw.expiresAt) : undefined,
        generatedAt: new Date().toISOString(),
      });
    }
    if (res.code !== 0 || res.json?.success !== true || routes.length < size) {
      const error = res.json?.error || res.stderr || res.stdout || 'Não foi possível preparar reservas Proton Free.';
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return { success: false, error: String(error).trim().slice(0, 500) };
    }
    return {
      success: true,
      stagingDir,
      routes,
      expiresAt: Number.isFinite(Number(res.json?.expiresAt)) ? Number(res.json.expiresAt) : undefined,
    };
  } catch (error) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export async function runIsolatedSpeedSelection(args: string[], signal?: AbortSignal, onProgress?: (progress: ProtonOptimizationProgress) => void, sourceExePath?: string) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-'));
  const exePath = path.join(tempDir, process.platform === 'win32' ? 'golive-speed-probe.exe' : 'golive-speed-probe');
  try {
    fs.copyFileSync(sourceExePath || findProtonConfgenExe(), exePath);
    if (process.platform !== 'win32') fs.chmodSync(exePath, 0o700);
    return await runConfgen({ args: [...args, '-progress-json'], exePath, timeoutMs: 210000, signal, onProgress });
  } finally {
    // Windows may need a moment to release the executable after timeout/exit.
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });
  }
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function canReuseMeasuredProfile(
  installDir: string,
  previous: any,
  filter: { username: string; country?: string; freeOnly?: boolean; autoPing?: boolean },
): boolean {
  if (!previous || previous.measurementVersion !== MEASUREMENT_CRITERION_VERSION) return false;
  if (!protonIdentityMatches(String(previous.measurementUsername || ''), filter.username)) return false;
  if (String(previous.measurementCountry || '') !== String(filter.country || '')) return false;
  if (previous.measurementFreeOnly !== (filter.freeOnly !== false) || previous.measurementAutoPing !== (filter.autoPing !== false)) return false;
  const server = previous.lastServer || previous;
  const name = typeof previous.server === 'string' ? previous.server : server.name;
  const endpoint = typeof previous.endpoint === 'string' ? previous.endpoint : server.endpoint;
  if (typeof name !== 'string' || typeof endpoint !== 'string' || !name || !endpoint) return false;
  if (!finitePositive(previous.downloadMbps ?? server.downloadMbps) || !finitePositive(previous.uploadMbps ?? server.uploadMbps) || !finitePositive(previous.pingMs ?? server.pingMs)) return false;
  return matchesMeasuredProfile(installDir, name, endpoint);
}

export function matchesMeasuredProfile(installDir: string, server: string, endpoint: string): boolean {
  if (!server || !endpoint) return false;
  try {
    const content = fs.readFileSync(path.join(installDir, 'wireguard.conf'), 'utf8');
    return content.split(/\r?\n/).includes(`# - Name: ${server}`) &&
      content.split(/\r?\n/).some(line => line.trim() === `Endpoint = ${endpoint}`);
  } catch { return false; }
}
