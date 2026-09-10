import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { classifyProtonError, loginProton } from '../electron/proton';

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
});
