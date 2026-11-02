// Caminho do standalone dentro do pacote (dev: repo; AppImage: extraResources)
import { app } from 'electron';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';

export function findStandaloneScript(): string {
  // 1. pasta dev: ../standalone/golivebypass-standalone.sh (relativo a dist-electron)
  const dev = path.join(app.getAppPath(), '..', 'standalone', 'golivebypass-standalone.sh');
  if (fs.existsSync(dev)) return dev;

  // 2. AppImage: extraResources copia para resources/extra/standalone/
  const bundled = path.join(process.resourcesPath, 'extra', 'standalone', 'golivebypass-standalone.sh');
  if (fs.existsSync(bundled)) return bundled;

  // 3. fallback: ao lado do binário
  const beside = path.join(path.dirname(process.execPath), 'standalone', 'golivebypass-standalone.sh');
  if (fs.existsSync(beside)) return beside;

  // Sem os caminhos tentados, "nao encontrei" nao dizia nem onde procurar (relato: a
  // limpeza no encerramento falhava assim depois de uma atualizacao do AppImage).
  throw new Error(`Nao encontrei golivebypass-standalone.sh (procurei em ${[dev, bundled, beside].join(', ')})`);
}

export interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Roda o script e resolve com a saida completa (para acoes que terminam rapido: status).
export function runScript(args: string[], onChunk?: (chunk: string) => void, extraEnv?: Record<string, string>): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn('sh', [findStandaloneScript(), ...args], {
        // O standalone publico esta temporariamente bloqueado durante a portabilidade.
        // Somente a GUI, que e a variante mantida, pode usar o motor interno por esta marca.
        env: { ...process.env, GOLIVE_GUI: '1', ...extraEnv },
        // Nunca herdar o socket stdin do Electron: status/probe/report nao podem
        // ficar bloqueados aguardando EOF de um processo pai vivo.
        stdio: ['ignore', 'pipe', 'pipe'],
        // A reversao do bypass roda em background depois do app.quit(); sem detached o filho
        // morreria junto com o processo pai e o Discord ficaria com a injecao pendurada.
        detached: true,
      });
      child.unref();
    } catch (err) {
      reject(err);
      return;
    }

    // Com encoding no stream, um caractere UTF-8 dividido entre duas leituras do pipe
    // (caminho com acento, mensagem em portugues) chega inteiro em vez de virar U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s: string) => {
      stdout += s;
      onChunk?.(s);
    });
    child.stderr.on('data', (s: string) => {
      stderr += s;
      onChunk?.(s);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
