/** Resultado do preflight Linux emitido pelo standalone.
 *
 * O parser fica separado do Electron para permitir testar os casos de Arch sem
 * executar sudo, ip netns ou alterar o host de desenvolvimento.
 */
export type LinuxPreflight = {
  ok: boolean;
  platform: "linux";
  distro: string;
  archLike: boolean;
  dependencies: { missing: string[]; required: string[] };
  elevation: { available: boolean; method: string };
  netns: { available: boolean };
  kernel: { wireguard: "available" | "unknown" | string };
  discord: { found: boolean; count: number; firstPath: string };
  errors: string[];
  installCommand: string;
}

/** Indica se a GUI pode tentar reparar as dependências ausentes. */
export function linuxPreflightRepairable(preflight: LinuxPreflight): boolean {
  const knownPackages = new Set(["wireguard-tools", "iproute2", "curl", "wg", "ip"]);
  const missing = preflight.dependencies.missing;
  const knownMissing = missing.length > 0 && missing.every((item) => knownPackages.has(item));
  const iprouteMissing = missing.includes("iproute2") || missing.includes("ip");
  return preflight.platform === "linux"
    && knownMissing
    && preflight.elevation.available
    && (preflight.netns.available || iprouteMissing)
    && preflight.discord.found;
}

export function parseLinuxPreflight(raw: string): LinuxPreflight {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("O preflight do Linux retornou JSON inválido.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("O preflight do Linux retornou um objeto inválido.");
  }
  const data = value as Record<string, unknown>;
  const dependencies = (data.dependencies ?? {}) as Record<string, unknown>;
  const elevation = (data.elevation ?? {}) as Record<string, unknown>;
  const netns = (data.netns ?? {}) as Record<string, unknown>;
  const kernel = (data.kernel ?? {}) as Record<string, unknown>;
  const discord = (data.discord ?? {}) as Record<string, unknown>;
  const strings = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
  const count = typeof discord.count === "number" && Number.isFinite(discord.count)
    ? Math.max(0, Math.floor(discord.count))
    : 0;
  return {
    ok: data.ok === true,
    platform: "linux",
    distro: typeof data.distro === "string" && data.distro ? data.distro : "Linux",
    archLike: data.archLike === true,
    dependencies: {
      missing: strings(dependencies.missing),
      required: strings(dependencies.required),
    },
    elevation: {
      available: elevation.available === true,
      method: typeof elevation.method === "string" ? elevation.method : "none",
    },
    netns: { available: netns.available === true },
    kernel: {
      wireguard: typeof kernel.wireguard === "string" ? kernel.wireguard : "unknown",
    },
    discord: {
      found: discord.found === true || count > 0,
      count,
      firstPath: typeof discord.firstPath === "string" ? discord.firstPath : "",
    },
    errors: strings(data.errors),
    installCommand: typeof data.installCommand === "string" ? data.installCommand : "",
  };
}

export function linuxPreflightMessage(preflight: LinuxPreflight): string {
  if (preflight.ok) return "Ambiente Linux pronto para ativar.";
  if (preflight.dependencies.missing.length > 0) {
    return `Dependências ausentes: ${preflight.dependencies.missing.join(", ")}.`;
  }
  if (!preflight.elevation.available) return "É necessária autorização sudo ou pkexec para criar o túnel.";
  if (!preflight.netns.available) return "O sistema não permite consultar namespaces de rede (ip netns).";
  if (!preflight.discord.found) return "Nenhuma instalação do Discord foi encontrada.";
  return preflight.errors[0] || "O ambiente Linux não está pronto para ativar.";
}
