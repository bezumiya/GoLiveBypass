import fs from "fs";
import os from "os";
import { windowsInstallerFolderPresent } from "./wiresock-install-diag";

// Retrato do ambiente para o log (uma linha `env snapshot` por abertura) e os metadados do relato.
// Cada campo já precisou ser perguntado à mão: build do Windows e pasta do Windows Installer
// (upgrade do WireSock que falhava com 1632 num Windows "enxugado"), distro/kernel/IPv6,
// módulo WireGuard, empacotamento e sessão gráfica no Linux (#404).
// Só rótulos técnicos: nada de usuário, máquina, caminho, rede ou endpoint.

export function linuxDistroLabel(osRelease: string | null): string {
  if (!osRelease) return "desconhecida";
  const fields = new Map<string, string>();
  for (const line of osRelease.split("\n")) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) fields.set(match[1], match[2].replace(/^"|"$/g, "").trim());
  }
  const clean = (value: string | undefined) => (value ?? "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  const id = clean(fields.get("ID"));
  const version = clean(fields.get("VERSION_ID"));
  return id ? `${id}${version ? ` ${version}` : ""}` : "desconhecida";
}

/** "-03:00": só o deslocamento, para converter os horários do log no que a pessoa conta. */
export function timezoneOffsetLabel(date: Date = new Date()): string {
  const offset = -date.getTimezoneOffset();
  const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");
  return `${offset >= 0 ? "+" : "-"}${pad(Math.abs(offset) / 60)}:${pad(Math.abs(offset) % 60)}`;
}

export interface GuiEnvironmentExtras {
  wiresock?: { version: string; upgrade: string } | null;
}

export function guiEnvironmentSnapshot(extras: GuiEnvironmentExtras = {}, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const snapshot: Record<string, string> = { fuso: timezoneOffsetLabel() };
  if (platform === "win32") {
    snapshot.so = "windows";
    snapshot.so_build = os.release();
    const installer = windowsInstallerFolderPresent();
    snapshot.msi_pasta_installer = installer === null ? "desconhecida" : installer ? "sim" : "nao";
    if (extras.wiresock) {
      snapshot.wiresock_versao = extras.wiresock.version;
      snapshot.wiresock_upgrade = extras.wiresock.upgrade;
    }
  } else if (platform === "linux") {
    let osRelease: string | null = null;
    try { osRelease = fs.readFileSync("/etc/os-release", "utf8"); } catch { osRelease = null; }
    snapshot.so = "linux";
    snapshot.kernel = os.release();
    snapshot.distro = linuxDistroLabel(osRelease);
    snapshot.ipv6_kernel = fs.existsSync("/proc/net/if_inet6") ? "sim" : "nao";
    // Mesmos campos do plugin (goLiveBypass/vpn-linux.ts), sem rodar comando nem pedir senha:
    // o estado do módulo vem do /sys; o empacotamento e a sessão, do ambiente e do execPath.
    snapshot.wg_modulo = fs.existsSync("/sys/module/wireguard") ? "carregado" : "nao_carregado";
    const env = process.env;
    snapshot.empacotamento = env.AppImage ? "appimage" : env.SNAP || process.execPath.startsWith("/snap/") ? "snap" : process.execPath.startsWith("/nix/store/") ? "nix" : env.FLATPAK_ID || process.execPath.startsWith("/app/") ? "flatpak" : "nativo";
    const session = (env.XDG_SESSION_TYPE ?? "").toLowerCase();
    snapshot.sessao_grafica = /^[a-z0-9]{1,16}$/.test(session) ? session : "desconhecida";
  } else {
    snapshot.so = platform;
  }
  return snapshot;
}
