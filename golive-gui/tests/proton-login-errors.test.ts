import { afterAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const state = vi.hoisted(() => ({
  json: undefined as any,
  success: false,
}));
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (state.json !== undefined) child.stdout.emit('data', Buffer.from(JSON.stringify(state.json)));
      setTimeout(() => child.emit('close', state.success ? 0 : 1), 0);
    });
    return child;
  }),
}));

// Sem o stub o produto tentaria baixar o runtime Proton pela rede (no macOS nem existe runtime).
vi.mock('../electron/proton-runtime', async (original) =>
  (await import('./helpers/confgen-runtime-stub')).stubProtonRuntime(await original<object>()));
import { removeConfgenStub } from './helpers/confgen-runtime-stub';
import { checkProtonSession, classifyProtonError, loginProton } from '../electron/proton';
import { decideProtonSession, protonSessionUnverifiedMessage } from '../src/proton-session';

const VERSAO_RECUSADA_LOGIN = 'A Proton deixou de aceitar esta versão do GoLiveBypass. Atualize o GoLiveBypass para continuar.';
// Texto de helpers anteriores ao código APP_VERSION_UNSUPPORTED.
const VERSAO_RECUSADA_HELPER_ANTIGO = 'authentication failed: failed to get auth info: authentication failed with code: 5003';

afterAll(removeConfgenStub);

describe('classificação dos erros de login Proton', () => {
  beforeEach(() => {
    state.json = undefined;
    state.success = false;
  });

  it('honra o código estruturado NETWORK_ERROR sem acusar senha incorreta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-login-net-'));
    try {
      state.json = {
        success: false,
        error: 'authentication failed: Proton session verification returned an invalid HTTP status (200)',
        code: 'NETWORK_ERROR',
        retryable: true,
      };
      const res = await loginProton(dir, 'teste_golive', 'senha');
      expect(res.success).toBe(false);
      expect(res.code).toBe('NETWORK_ERROR');
      expect(res.retryable).toBe(true);
      expect(res.error).not.toContain('senha incorretos');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifica commit de migração da sessão como persistência, não como senha', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-login-session-'));
    try {
      state.json = {
        success: false,
        error: 'authentication failed: failed to read session file: failed to migrate session file: failed to commit session file: Acesso negado.',
        code: 'SESSION_PERSISTENCE',
        retryable: true,
      };
      const res = await loginProton(dir, 'teste_golive', 'senha');
      expect(res).toMatchObject({ success: false, code: 'SESSION_PERSISTENCE', retryable: true });
      expect(res.message).toContain('senha não foi verificada');
      expect(res.message).not.toContain('senha incorretos');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honra o código estruturado INVALID_CREDENTIALS', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-login-cred-'));
    try {
      state.json = {
        success: false,
        error: 'authentication failed: incorrect username or password',
        code: 'INVALID_CREDENTIALS',
        retryable: false,
      };
      const res = await loginProton(dir, 'teste_golive', 'senha');
      expect(res.success).toBe(false);
      expect(res.code).toBe('INVALID_CREDENTIALS');
      expect(res.error).toBe('Usuário ou senha incorretos.');
      expect(res.retryable).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não traduz o prefixo genérico do helper como credencial inválida', () => {
    const classified = classifyProtonError('authentication failed: Proton session verification returned an invalid HTTP status (200)');
    expect(classified.code).toBe('UNKNOWN');
    expect(classified.retryable).toBe(true);
  });

  it('mantém texto explícito de credencial como senha incorreta', () => {
    expect(classifyProtonError('authentication failed: incorrect username or password').code).toBe('INVALID_CREDENTIALS');
    expect(classifyProtonError('invalid password').code).toBe('INVALID_CREDENTIALS');
  });

  it('honra o código estruturado APP_VERSION_UNSUPPORTED com a mensagem de atualização', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-login-version-'));
    try {
      state.json = {
        success: false,
        error: 'authentication failed: failed to get auth info: Proton no longer accepts this app version (code 5003); update GoLiveBypass',
        code: 'APP_VERSION_UNSUPPORTED',
        retryable: false,
      };
      const res = await loginProton(dir, 'teste_golive', 'senha');
      expect(res).toEqual({
        success: false,
        code: 'APP_VERSION_UNSUPPORTED',
        message: VERSAO_RECUSADA_LOGIN,
        retryable: false,
        error: VERSAO_RECUSADA_LOGIN,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconhece a versão recusada no texto de helpers antigos em vez do erro genérico', async () => {
    expect(classifyProtonError(VERSAO_RECUSADA_HELPER_ANTIGO)).toEqual({
      code: 'APP_VERSION_UNSUPPORTED',
      message: VERSAO_RECUSADA_LOGIN,
      retryable: false,
    });
    // Mensagem do helper novo sem JSON e a frase da própria API Proton.
    expect(classifyProtonError('Error: authentication failed: Proton no longer accepts this app version (code 5003); update GoLiveBypass').code)
      .toBe('APP_VERSION_UNSUPPORTED');
    expect(classifyProtonError('This version of the app is no longer supported').code).toBe('APP_VERSION_UNSUPPORTED');
    // Linhas de rede no stderr não engolem o código da versão.
    expect(classifyProtonError(VERSAO_RECUSADA_HELPER_ANTIGO, 'connection reset, retrying').code).toBe('APP_VERSION_UNSUPPORTED');

    // Helper antigo com -json: o JSON vem sem `code` e o fallback de texto decide.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-login-version-old-'));
    try {
      state.json = { success: false, error: VERSAO_RECUSADA_HELPER_ANTIGO };
      const res = await loginProton(dir, 'teste_golive', 'senha');
      expect(res).toMatchObject({ success: false, code: 'APP_VERSION_UNSUPPORTED', retryable: false, message: VERSAO_RECUSADA_LOGIN });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('não confunde senha errada nem outros códigos com versão recusada', () => {
    expect(classifyProtonError('authentication failed: incorrect username or password').code).toBe('INVALID_CREDENTIALS');
    expect(classifyProtonError('authentication failed: failed to get auth info: incorrect username or password').code).toBe('INVALID_CREDENTIALS');
    expect(classifyProtonError('authentication failed: failed to get auth info: authentication failed with code: 50030').code).toBe('UNKNOWN');
    expect(classifyProtonError('authentication failed: failed to get auth info: authentication failed with code: 2001').code).toBe('UNKNOWN');
  });

  it('o painel traduz o código de versão recusada no login', () => {
    const renderer = fs.readFileSync(path.resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const fn = renderer.slice(renderer.indexOf('function protonLoginMessage'), renderer.indexOf('type ProtonPlanView'));
    expect(fn).toContain(`case 'APP_VERSION_UNSUPPORTED': return '${VERSAO_RECUSADA_LOGIN}';`);
  });
});

describe('verificação da sessão Proton com a versão do app recusada', () => {
  beforeEach(() => {
    state.json = undefined;
    state.success = false;
  });

  it('mantém a conta conectada e explica a atualização', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-session-version-'));
    try {
      // Contrato do helper para -check-session: sai com 0 e descreve a falha no JSON.
      state.success = true;
      state.json = {
        success: false,
        valid: false,
        error: 'A Proton não aceita mais esta versão do GoLiveBypass',
        code: 'APP_VERSION_UNSUPPORTED',
        retryable: true,
      };
      const chk = await checkProtonSession(dir, 'teste_golive');
      expect(chk).toEqual({
        valid: false,
        code: 'APP_VERSION_UNSUPPORTED',
        retryable: true,
        error: 'A Proton não aceita mais esta versão do GoLiveBypass',
      });
      expect(decideProtonSession(chk)).toBe('unverified');
      expect(protonSessionUnverifiedMessage(chk)).toBe(
        'A Proton deixou de aceitar esta versão do GoLiveBypass. A ativação com a rota já preparada continua disponível; para entrar ou trocar de rota, atualize o GoLiveBypass.',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
