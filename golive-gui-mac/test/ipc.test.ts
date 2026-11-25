import { describe, it, expect, vi } from 'vitest';
import { makeRouter } from '../src/main/ipc';

describe('makeRouter', () => {
  it('encaminha tunnel:activate para o handler', async () => {
    const activate = vi.fn(async () => ({ state: 'active', publicIp: '1.2.3.4' }));
    const router = makeRouter({ activate, deactivate: vi.fn(), importConfig: vi.fn(), status: vi.fn() } as any);
    const r = await router('tunnel:activate', undefined);
    expect(activate).toHaveBeenCalled();
    expect(r).toEqual({ state: 'active', publicIp: '1.2.3.4' });
  });

  it('settings:set só repassa booleanos', async () => {
    const setSettings = vi.fn(async (p: unknown) => p);
    const router = makeRouter({ setSettings } as any);
    await router('settings:set', { openAtLogin: true, devMode: 'sim', routePreference: 'qualquer', extra: 1 });
    expect(setSettings).toHaveBeenCalledWith({
      openAtLogin: true, devMode: undefined, theme: undefined, routePreference: undefined, autoFailover: undefined, routePromptAnswered: false,
    });
  });

  it('proton:fetch só aceita modos conhecidos', async () => {
    const fetchProton = vi.fn(async (p: unknown) => p);
    const router = makeRouter({ fetchProton } as any);
    await router('proton:fetch', { username: 'a', mode: 'rm -rf', server: 'US-FREE#1' });
    expect(fetchProton).toHaveBeenCalledWith({ username: 'a', password: undefined, mode: undefined, server: 'US-FREE#1' });
  });

  it('phone:generate só aceita entrega conhecida', async () => {
    const phoneGenerate = vi.fn(async (p: unknown) => p);
    const router = makeRouter({ phoneGenerate } as any);
    await router('phone:generate', { delivery: 'file', platform: 'ios' });
    expect(phoneGenerate).toHaveBeenLastCalledWith({ delivery: 'file' });
    await router('phone:generate', { delivery: 'email' });
    expect(phoneGenerate).toHaveBeenLastCalledWith({ delivery: undefined });
  });

  it('phone:save ignora qualquer caminho vindo da janela', async () => {
    const phoneSave = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
    const router = makeRouter({ phoneSave } as any);
    await router('phone:save', { path: '/etc/passwd' });
    expect(phoneSave).toHaveBeenCalledWith();
  });

  it('demais canais do celular', async () => {
    const h = { phoneStatus: vi.fn(), phoneDeleteSaved: vi.fn(), phoneClear: vi.fn() };
    const router = makeRouter(h as any);
    await router('phone:status', undefined);
    await router('phone:deleteSaved', undefined);
    await router('phone:clear', undefined);
    expect(h.phoneStatus).toHaveBeenCalled();
    expect(h.phoneDeleteSaved).toHaveBeenCalled();
    expect(h.phoneClear).toHaveBeenCalled();
  });

  it('erro para canal desconhecido', async () => {
    const router = makeRouter({} as any);
    await expect(router('canal:invalido', undefined)).rejects.toThrow();
  });
});

describe('report:send', () => {
  it('limita e normaliza o payload do relato', async () => {
    const reportBug = vi.fn(async () => ({ ok: true }));
    const router = makeRouter({ reportBug } as any);
    await router('report:send', { title: 'x'.repeat(300), description: 7, includeLogs: undefined });
    expect(reportBug).toHaveBeenCalledWith({ title: 'x'.repeat(200), description: '7', includeLogs: true });
  });
});
