import { readFileSync } from "fs";
import { createHash } from "crypto";

export interface WindowsAssetIdentity {
  assetName: string;
  url: string;
  size: number;
  digest: string;
}

// A identidade vem do asset da API; tamanho sozinho nao distingue GUI de helper.
export function validWindowsIdentity(tag: string, value: unknown): value is WindowsAssetIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) return false;
  const name = `GoLiveBypass-${tag.replace(/^v/, "")}.exe`;
  if (item.assetName !== name || typeof item.url !== "string" ||
      !Number.isSafeInteger(item.size) || (item.size as number) <= 0 ||
      typeof item.digest !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(item.digest)) return false;
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      decodeURIComponent(url.pathname) === `/bezumiya/GoLiveBypass/releases/download/${tag}/${name}`;
  } catch {
    return false;
  }
}

// O portable NSIS e PE GUI (inclusive stub x86 para payload x64). O helper Go
// e console. Nao exigir tamanho minimo nem machine x64 do stub portable.
export function isWindowsGuiExecutable(bytes: Buffer): boolean {
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 24 || bytes.readUInt32LE(pe) !== 0x4550) return false;
  const optional = pe + 24;
  const size = bytes.readUInt16LE(pe + 20);
  if (size < 70 || optional + size > bytes.length) return false;
  const magic = bytes.readUInt16LE(optional);
  const machine = bytes.readUInt16LE(pe + 4);
  return ((magic === 0x10b && machine === 0x14c) || (magic === 0x20b && machine === 0x8664)) &&
    (bytes.readUInt16LE(pe + 22) & 0x2002) === 0x0002 &&
    bytes.readUInt16LE(optional + 68) === 2;
}

// NSIS firstheader: flags, 0xDEADBEEF, "NullsoftInst", header length,
// archive length. Procura somente no overlay, nunca strings dentro das secoes.
export function isWindowsPortableExecutable(bytes: Buffer): boolean {
  if (!isWindowsGuiExecutable(bytes)) return false;
  const pe = bytes.readUInt32LE(0x3c);
  const sections = bytes.readUInt16LE(pe + 6);
  const table = pe + 24 + bytes.readUInt16LE(pe + 20);
  if (sections === 0 || sections > 96 || table + sections * 40 > bytes.length) return false;
  let overlay = Math.max(table + sections * 40, bytes.readUInt32LE(pe + 24 + 60));
  for (let i = 0; i < sections; i++) {
    const entry = table + i * 40;
    const end = bytes.readUInt32LE(entry + 20) + bytes.readUInt32LE(entry + 16);
    if (end > bytes.length) return false;
    overlay = Math.max(overlay, end);
  }
  const signature = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
  // O primeiro header NSIS fica no inicio do overlay, apos o DWORD de flags.
  // Nao aceitar assinatura solta em qualquer ponto de um arquivo renomeado.
  if (overlay + 28 > bytes.length || !bytes.subarray(overlay + 4, overlay + 20).equals(signature)) return false;
  const headerLength = bytes.readUInt32LE(overlay + 20);
  const archiveLength = bytes.readUInt32LE(overlay + 24);
  return headerLength > 0 && archiveLength >= 28 && archiveLength <= bytes.length - overlay;
}

export function verifyWindowsAsset(file: string, tag: string, identity: unknown): boolean {
  if (!validWindowsIdentity(tag, identity)) return false;
  try {
    const bytes = readFileSync(file);
    return bytes.length === identity.size && isWindowsPortableExecutable(bytes) &&
      createHash("sha256").update(bytes).digest("hex") === identity.digest.slice(7).toLowerCase();
  } catch {
    return false;
  }
}
