import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';

const state = vi.hoisted(() => ({
  success: true,
  json: undefined as any,
  error: '',
  executable: '',
  args: [] as string[],
  existed: false,
  code: 0,
  closeDelay: 0,
  createOutput: true,
  downloadMbps: 30,
  uploadMbps: 10,
  progressChunks: [] as string[],
  child: undefined as any,
  killAt: 0,
}));
vi.mock('child_process', () => ({
  spawn: vi.fn((exe: string, args: string[]) => {
    state.executable = exe;
    state.args = args;
    state.existed = fs.existsSync(exe);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    state.child = child;
    child.kill.mockImplementation(() => {
      state.killAt = Date.now();
      setTimeout(() => child.emit('close', state.code), state.closeDelay);
      return true;
    });
    queueMicrotask(() => {
      const routeCatalog = args.includes('-route-catalog');
      const routePool = args.includes('-route-pool');
      const outputDirAt = args.indexOf('-route-pool-output-dir');
      const outputDir = outputDirAt >= 0 ? args[outputDirAt + 1] : '';
      const result = state.json !== undefined
        ? state.json
        : routeCatalog
        ? {
          success: state.success,
          routes: [0, 1, 2].map((index) => ({
            server: index === 0 ? 'US#1' : index === 1 ? 'NL#2' : 'CH#3',
            country: index === 0 ? 'US' : index === 1 ? 'NL' : 'CH',
            city: index === 0 ? 'New York' : index === 1 ? 'Amsterdam' : 'Zurich',
            tier: 'Free', load: 10 + index, score: 1 + index,
            ...(args.includes('-auto-ping') ? { pingMs: 80 + index } : {}),
          })),
        }
        : routePool
        ? {
          success: state.success,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          routes: [0, 1].map((index) => ({
            success: true,
            server: index === 0 ? 'US#1' : 'NL#2',
            country: index === 0 ? 'US' : 'NL',
            city: index === 0 ? 'New York' : 'Amsterdam',
            tier: 'Free', load: 10 + index, score: 1 + index, pingMs: 80 + index,
            endpoint: `192.0.2.${index + 1}:51820`,
            confFile: outputDir ? path.join(outputDir, `route-0${index}.conf`) : '',
          })),
        }
        : args.includes('-manual-probe')
        ? state.success
          ? {
            success: true,
            manual: true,
            server: args[args.indexOf('-server') + 1] || 'US#8',
            pingMs: 188,
            endpoint: '192.0.2.8:51820',
          }
          : { success: false, error: state.error || 'rota manual indisponível' }
        : state.success
        ? { success: true, server: 'US#1', pingMs: 100, downloadMbps: state.downloadMbps, uploadMbps: state.uploadMbps, speedTested: 6, speedSucceeded: 5 }
        : { success: false, error: state.error || 'nenhum candidato completou a medição' };
      child.stdout.emit('data', Buffer.from(JSON.stringify(result)));
      if (state.createOutput && routePool && outputDir) {
        fs.mkdirSync(outputDir, { recursive: true });
        for (let index = 0; index < 2; index++) {
          fs.writeFileSync(path.join(outputDir, `route-0${index}.conf`), `# - Name: ${index === 0 ? 'US#1' : 'NL#2'}\nEndpoint = 192.0.2.${index + 1}:51820\n`);
        }
      } else if (state.createOutput) {
        const outputAt = args.indexOf('-output');
        if (outputAt >= 0 && args[outputAt + 1]) fs.writeFileSync(args[outputAt + 1], '# - Name: US#1\nEndpoint = 192.0.2.1:51820\n');
      }
      for (const chunk of state.progressChunks) child.stderr.emit('data', Buffer.from(chunk));
      setTimeout(() => child.emit('close', state.code || (state.success ? 0 : 1)), state.closeDelay);
    });
    return child;
  }),
}));

import { canReuseMeasuredProfile, generateManualProtonConfig, generateOptimalProtonConfig, generateProtonRouteCatalog, generateProtonRoutePool, findProtonConfgenExe, MEASUREMENT_CRITERION_VERSION, removeStagedProtonConfig, runConfgen } from '../electron/proton';

describe('medidor isolado da regra WireSock', () => {
  beforeEach(() => {
    state.success = true; state.json = undefined; state.error = ''; state.code = 0; state.closeDelay = 0; state.createOutput = true;
    state.progressChunks = []; state.killAt = 0; state.downloadMbps = 30; state.uploadMbps = 10;
  });

  it('gera somente a rota manual solicitada e deixa o perfil ativo intacto', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-manual-route-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'existing profile');
    try {
      const result = await generateManualProtonConfig(dir, {
        username: 'test@example.test',
        server: 'US#8',
        countries: 'US',
        freeOnly: true,
        autoPing: true,
      });

      expect(state.args).toEqual(expect.arrayContaining([
        '-server', 'US#8', '-manual-probe',
      ]));
      expect(state.args).not.toContain('-speed-test');
      expect(result).toMatchObject({
        success: true,
        server: 'US#8',
        pingMs: 188,
        staged: true,
      });
      expect(result.confFile).toBeTruthy();
      expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8'))
        .toBe('existing profile');
      expect(fs.readFileSync(result.confFile!, 'utf8')).toContain('US#1');
    } finally {
      if (state.args.length > 0) {
        const staged = fs.readdirSync(dir).find((name) => name.includes('.manual-proton-route.'));
        if (staged) removeStagedProtonConfig(path.join(dir, staged));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejeita JSON manual inválido e limpa o staged', async () => {
    state.json = { success: true, manual: false, server: 'US#8', pingMs: 188 };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-manual-invalid-json-'));
    try {
      const result = await generateManualProtonConfig(dir, {
        username: 'test@example.test', server: 'US#8',
      });
      expect(result.success).toBe(false);
      expect(fs.readdirSync(dir).filter((name) => name.includes('.manual-proton-route.'))).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('não promove saída não zero nem deixa arquivo staged', async () => {
    state.success = false;
    state.code = 1;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-manual-nonzero-'));
    try {
      const result = await generateManualProtonConfig(dir, {
        username: 'test@example.test', server: 'US#8',
      });
      expect(result.success).toBe(false);
      expect(fs.readdirSync(dir).filter((name) => name.includes('.manual-proton-route.'))).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejeita sucesso sem arquivo staged e limpa o diretório', async () => {
    state.createOutput = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-manual-no-output-'));
    try {
      const result = await generateManualProtonConfig(dir, {
        username: 'test@example.test', server: 'US#8',
      });
      expect(result.success).toBe(false);
      expect(fs.readdirSync(dir).filter((name) => name.includes('.manual-proton-route.'))).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('redige a conta nos erros manuais', async () => {
    state.success = false;
    state.error = 'falha ao validar test@example.test na sessão';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-manual-redaction-'));
    try {
      const result = await generateManualProtonConfig(dir, {
        username: 'test@example.test', server: 'US#8',
      });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('test@example.test');
      expect(result.error).toContain('[account]');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('usa outro executável temporário, transmite Mbps reais e remove a cópia', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-result-'));
    try {
      const result = await generateOptimalProtonConfig(dir, { username: 'test', speedTest: true });
      expect(state.existed).toBe(true);
      expect(state.executable).not.toBe(findProtonConfgenExe());
      expect(path.basename(state.executable)).not.toBe(path.basename(findProtonConfgenExe()));
      expect(state.args).toContain('-speed-test');
      expect(state.args).toContain('-progress-json');
      expect(result).toMatchObject({ success: true, downloadMbps: 30, uploadMbps: 10, speedTested: 6, speedSucceeded: 5 });
      expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toContain('US#1');
      expect(fs.existsSync(path.dirname(state.executable))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('carrega o catálogo completo sem ping, perfil ou arquivo temporário', async () => {
    state.progressChunks = [
      'GOLIVE_PROGRESS {"phase":"catalog","total":3,"tested":2,"succeeded":2,"server":"NL#2","country":"NL","city":"Amsterdam","tier":"Free","load":11,"score":2,"status":"success"}\n',
    ];
    const progress: any[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-route-catalog-'));
    try {
      const result = await generateProtonRouteCatalog(dir, {
        username: 'test',
        countries: 'US,NL',
        freeOnly: true,
        excludeServers: ['OLD#1'],
        onProgress: (event) => progress.push(event),
      });
      expect(result).toEqual({
        success: true,
        routes: [
          { server: 'US#1', country: 'US', city: 'New York', tier: 'Free', load: 10, score: 1 },
          { server: 'NL#2', country: 'NL', city: 'Amsterdam', tier: 'Free', load: 11, score: 2 },
          { server: 'CH#3', country: 'CH', city: 'Zurich', tier: 'Free', load: 12, score: 3 },
        ],
      });
      expect(state.args).toEqual(expect.arrayContaining([
        '-route-catalog', '-json', '-exclude-countries', 'BR', '-countries', 'US,NL',
        '-free-only', '-exclude-servers', 'OLD#1', '-progress-json',
      ]));
      expect(state.args).not.toContain('-route-pool');
      expect(state.args).not.toContain('-route-pool-output-dir');
      expect(result.routes?.[0]).not.toHaveProperty('endpoint');
      expect(result.routes?.[0]).not.toHaveProperty('confFile');
      expect(progress).toEqual([
        { phase: 'catalog', total: 3, tested: 2, succeeded: 2, server: 'NL#2', country: 'NL', city: 'Amsterdam', tier: 'Free', load: 11, score: 2, status: 'success' },
      ]);
      expect(fs.readdirSync(dir).filter((name) => name.includes('route-pool') || name.includes('manual-proton-route'))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('mede ping regional sem gerar perfil temporário', async () => {
    state.progressChunks = [
      'GOLIVE_PROGRESS {"phase":"ping","total":2,"tested":1,"succeeded":1,"server":"NL#2","pingMs":81,"status":"success"}\n',
      'GOLIVE_PROGRESS {"phase":"catalog","total":3,"tested":2,"succeeded":2,"server":"NL#2","country":"NL","city":"Amsterdam","tier":"Free","load":11,"score":2,"pingMs":81,"status":"success"}\n',
    ];
    const progress: any[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-route-catalog-ping-'));
    try {
      const result = await generateProtonRouteCatalog(dir, {
        username: 'test',
        countries: 'US,NL',
        freeOnly: true,
        measurePing: true,
        onProgress: (event) => progress.push(event),
      });
      expect(result).toMatchObject({
        success: true,
        routes: [
          { server: 'US#1', pingMs: 80 },
          { server: 'NL#2', pingMs: 81 },
          { server: 'CH#3', pingMs: 82 },
        ],
      });
      expect(state.args).toEqual(expect.arrayContaining([
        '-route-catalog', '-json', '-auto-ping', '-progress-json',
      ]));
      expect(state.args).not.toContain('-speed-test');
      expect(state.args).not.toContain('-route-pool');
      expect(progress).toEqual([
        { phase: 'ping', total: 2, tested: 1, succeeded: 1, server: 'NL#2', pingMs: 81, status: 'success' },
        { phase: 'catalog', total: 3, tested: 2, succeeded: 2, server: 'NL#2', country: 'NL', city: 'Amsterdam', tier: 'Free', load: 11, score: 2, pingMs: 81, status: 'success' },
      ]);
      expect(fs.readdirSync(dir).filter((name) => name.includes('route-pool') || name.includes('manual-proton-route'))).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('prepara duas reservas em pasta temporária sem promover o perfil ativo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-route-pool-result-'));
    try {
      fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'active profile');
      const result = await generateProtonRoutePool(dir, {
        username: 'test', size: 2, countries: 'US,NL', excludeServers: ['OLD#1'],
      });
      expect(result.success).toBe(true);
      expect(result.routes).toHaveLength(2);
      expect(state.args).toContain('-route-pool');
      expect(state.args).toContain('-no-save');
      expect(state.args).toContain('-exclude-servers');
      expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toBe('active profile');
      expect(result.stagingDir).toBeTruthy();
      expect(fs.existsSync(result.routes![0].confFile)).toBe(true);
      fs.rmSync(result.stagingDir!, { recursive: true, force: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('propaga progresso de ping enquanto prepara reservas', async () => {
    state.progressChunks = [
      'GOLIVE_PROGRESS {"phase":"ping","total":24,"tested":1,"succeeded":1,"server":"NL#12","pingMs":42,"status":"success"}\n',
    ];
    const progress: any[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-route-pool-progress-'));
    try {
      const result = await generateProtonRoutePool(dir, {
        username: 'test',
        size: 2,
        countries: 'US,NL',
        excludeServers: ['OLD#1'],
        onProgress: (event) => progress.push(event),
      });
      expect(result.success).toBe(true);
      expect(state.args).toContain('-progress-json');
      expect(progress).toEqual([
        { phase: 'ping', total: 24, tested: 1, succeeded: 1, server: 'NL#12', pingMs: 42, status: 'success' },
      ]);
      fs.rmSync(result.stagingDir!, { recursive: true, force: true });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('preserva configuração anterior e limpa o medidor se a medição falhar', async () => {
    state.success = false;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-failure-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'existing profile');
    try {
      const result = await generateOptimalProtonConfig(dir, { username: 'test', speedTest: true });
      expect(result.success).toBe(false);
      expect(result.downloadMbps).toBeUndefined();
      expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toBe('existing profile');
      expect(fs.existsSync(path.dirname(state.executable))).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('lê progresso em stderr fragmentado e aplica allowlist', async () => {
    state.progressChunks = [
      'ruído\nGOLIVE_PROGRESS {"phase":"testing","total":6,"tested":1,',
      '"succeeded":1,"server":"US#1","downloadMbps":20,"status":"testing"}\n',
      'GOLIVE_PROGRESS {"phase":"testing","total":6,"tested":2,"succeeded":2,"downloadMbps":-3,"uploadMbps":10,"secret":"x"}\n',
    ];
    const progress: any[] = [];
    await runConfgen({ args: ['-progress-json'], exePath: findProtonConfgenExe(), onProgress: (value) => progress.push(value) });
    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({ phase: 'testing', total: 6, tested: 1, succeeded: 1, server: 'US#1', downloadMbps: 20 });
    expect(progress[1]).not.toHaveProperty('secret');
    expect(progress[1]).not.toHaveProperty('downloadMbps');
  });

  it('aceita a fase de ping da triagem no mesmo canal da medição', async () => {
    state.progressChunks = [
      'GOLIVE_PROGRESS {"phase":"ping","total":24,"tested":24,"succeeded":20,"server":"NL#12","pingMs":42,"status":"success"}\n',
    ];
    const progress: any[] = [];
    await runConfgen({ args: ['-progress-json'], exePath: findProtonConfgenExe(), onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([{ phase: 'ping', total: 24, tested: 24, succeeded: 20, server: 'NL#12', pingMs: 42, status: 'success' }]);
  });

  it('aguarda close após cancelamento, limpa staging e preserva o perfil anterior', async () => {
    state.closeDelay = 35;
    const controller = new AbortController();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-cancel-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'previous');
    const promise = generateOptimalProtonConfig(dir, { username: 'test', speedTest: true, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - state.killAt).toBeGreaterThanOrEqual(25);
    expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toBe('previous');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('aguarda close no timeout e não promove código não zero, sucesso inválido ou output ausente', async () => {
    state.closeDelay = 20; state.code = 1;
    const timeoutStarted = Date.now();
    await expect(runConfgen({ args: [], exePath: findProtonConfgenExe(), timeoutMs: 5 })).rejects.toMatchObject({ message: expect.stringContaining('Tempo limite') });
    expect(Date.now() - timeoutStarted).toBeGreaterThanOrEqual(15);
    state.closeDelay = 0;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-invalid-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'previous');
    state.success = true;
    const result = await generateOptimalProtonConfig(dir, { username: 'test', speedTest: true });
    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toBe('previous');
    state.code = 0; state.createOutput = false;
    const missing = await generateOptimalProtonConfig(dir, { username: 'test', speedTest: true });
    expect(missing.success).toBe(false);
    state.createOutput = true;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('não promove medições sem upload/download positivos', async () => {
    state.success = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-metrics-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), 'previous');
    state.uploadMbps = 0;
    const result = await generateOptimalProtonConfig(dir, { username: 'test', speedTest: true });
    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'wireguard.conf'), 'utf8')).toBe('previous');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reutiliza cache somente com conta, filtros, versão, métricas e perfil compatíveis', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golive-speed-cache-'));
    fs.writeFileSync(path.join(dir, 'wireguard.conf'), '# - Name: US#1\nEndpoint = 192.0.2.1:51820\n');
    const previous = { measurementVersion: MEASUREMENT_CRITERION_VERSION, measurementUsername: 'test', measurementCountry: 'US', measurementFreeOnly: true, measurementAutoPing: true, server: 'US#1', endpoint: '192.0.2.1:51820', downloadMbps: 40, uploadMbps: 8, pingMs: 90 };
    expect(canReuseMeasuredProfile(dir, previous, { username: 'TEST', country: 'US', freeOnly: true, autoPing: true })).toBe(true);
    expect(canReuseMeasuredProfile(dir, { ...previous, measurementVersion: 1 }, { username: 'test', country: 'US', freeOnly: true, autoPing: true })).toBe(false);
    expect(canReuseMeasuredProfile(dir, { ...previous, measurementCountry: 'NL' }, { username: 'test', country: 'US', freeOnly: true, autoPing: true })).toBe(false);
    expect(canReuseMeasuredProfile(dir, { ...previous, uploadMbps: 0 }, { username: 'test', country: 'US', freeOnly: true, autoPing: true })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
