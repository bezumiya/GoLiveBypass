// Canal de atualizacao: "stable" (padrao) vs "beta" (opt-in dos testadores).
//
// A garantia estrutural (regra §9 do AGENTS.md): prereleases do GitHub NUNCA
// aparecem em /releases/latest — o usuario do canal estavel so ve release "de
// verdade", mesmo com uma beta publicada. O acidente da beta.3 (publicada como
// release normal, virou "latest" e disparou update em massa numa base com
// updater quebrado) ficou estruturalmente impossivel. Quem opta pelo canal beta
// recebe a candidata de MAIOR versao entre estaveis + prereleases com exe
// anexado — e NUNCA leva downgrade: pelo semver, 1.1.12 stable > 1.1.12-beta.7
// (prerelease perde do proprio release), e 1.1.13-beta.1 > 1.1.12.

export type Canal = "stable" | "beta";

export interface ReleaseCandidata {
  tag: string; // tag_name do GitHub (ex.: "v1.1.12-beta.7")
  url: string | null; // browser_download_url do exe (null = sem exe anexado)
  digest: string | null; // sha256 que a propria API do GitHub devolve no asset
  prerelease: boolean;
  assetName?: string;
  size?: number;
}

export interface AssetWindows {
  name: string;
  browser_download_url?: string;
  digest?: string;
  size?: number;
}

// O portable tem o nome exato da tag sem o prefixo "v". Não aceite apenas o
// prefixo "GoLiveBypass-": a mesma release também carrega o proton-confgen.exe.
export function escolherAssetWindows(tag: string, assets: AssetWindows[]): AssetWindows | null {
  const semV = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(semV)) return null;

  const esperado = "GoLiveBypass-" + semV + ".exe";
  return assets.find((asset) => {
    if (!asset || typeof asset.name !== "string" || asset.name !== esperado) return false;
    if (asset.browser_download_url === undefined) return true;
    if (typeof asset.browser_download_url !== "string") return false;
    try {
      const url = new URL(asset.browser_download_url);
      const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      return url.protocol === "https:" && filename === esperado;
    } catch {
      return false;
    }
  }) ?? null;
}

function partir(versao: string): { base: number[]; pre: string[] | null } {
  const limpa = versao.trim().replace(/^v/, "");
  const hifen = limpa.indexOf("-");
  const parteBase = hifen === -1 ? limpa : limpa.slice(0, hifen);
  const partePre = hifen === -1 ? null : limpa.slice(hifen + 1);
  const base = parteBase.split(".").map((n) => parseInt(n, 10) || 0);
  while (base.length < 3) base.push(0);
  return {
    base: base.slice(0, 3),
    pre: partePre === null ? null : partePre.replace(/^beta-(\d+)$/, "beta.$1").split("."),
  };
}

// Regra do semver para identificadores de prerelease: numerico < alfanumerico.
function compararIdentificador(a: string, b: string): number {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) {
    const n = parseInt(a, 10) - parseInt(b, 10);
    return n === 0 ? 0 : n < 0 ? -1 : 1;
  }
  if (numA) return -1;
  if (numB) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Comparacao semver minima para as versoes do projeto: "v1.2.3" e "v1.2.3-beta.N".
// Negativo = a < b, zero = iguais, positivo = a > b.
export function compararVersoes(a: string, b: string): number {
  const va = partir(a);
  const vb = partir(b);
  for (let i = 0; i < 3; i++) {
    if (va.base[i] !== vb.base[i]) return va.base[i] < vb.base[i] ? -1 : 1;
  }
  // Mesmo triplo: release > prerelease (1.1.12 > 1.1.12-beta.6).
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  const n = Math.max(va.pre.length, vb.pre.length);
  for (let i = 0; i < n; i++) {
    const ia = va.pre[i];
    const ib = vb.pre[i];
    if (ia === undefined) return -1; // prefixo igual, o mais curto perde
    if (ib === undefined) return 1;
    const c = compararIdentificador(ia, ib);
    if (c !== 0) return c;
  }
  return 0;
}

// Escolhe a candidata de update: a release de MAIOR versao com exe anexado,
// respeitando o canal (beta inclui prereleases; stable so releases "de verdade").
// Devolve null quando a maior candidata nao e mais nova que a versao atual —
// NUNCA faz downgrade: quem esta na beta.7 com o canal stable so recebe update
// quando sair uma stable >= 1.1.12 (que e maior que qualquer beta do mesmo
// triplo). A Linux (electron-updater) nao passa por aqui: la o canal e nativo
// (allowPrerelease + beta.yml), com semver do proprio electron-updater.
export function escolherRelease(
  releases: ReleaseCandidata[],
  atual: string,
  canal: Canal,
): ReleaseCandidata | null {
  let melhor: ReleaseCandidata | null = null;
  for (const r of releases) {
    if (r.url === null) continue; // sem exe anexado, nao ha o que instalar
    if (canal === "stable" && r.prerelease) continue;
    if (melhor === null || compararVersoes(r.tag, melhor.tag) > 0) melhor = r;
  }
  if (melhor === null) return null;
  if (compararVersoes(melhor.tag, atual) <= 0) return null;
  return melhor;
}
