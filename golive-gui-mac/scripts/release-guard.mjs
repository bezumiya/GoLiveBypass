// Regras da release macOS, sem efeitos colaterais (testadas em test/release-guard.test.ts).
// Uma release macOS nunca pode virar /releases/latest do repositório: o updater
// estável do Linux e o catálogo do site/API dependem dessa latest.

export const DEFAULT_UPDATE_REPO = 'bezumiya/GoLiveBypass';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const releaseTag = version => `macos-v${version}`;
export const dmgName = version => `GoLiveBypass-macos-${version}-universal.dmg`;
export const expectedAssets = version => [dmgName(version), `${dmgName(version)}.sha256`].sort();

export function isPrerelease(version) {
  return !!SEMVER.exec(version)?.[4];
}

/** Erros que impedem publicar; lista vazia = pode seguir. */
export function preflightErrors({ version, repo, files, bundled }) {
  const errors = [];
  if (!SEMVER.test(version ?? '')) errors.push(`versão inválida: ${version}`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) errors.push(`repositório inválido: ${repo}`);
  for (const name of expectedAssets(version)) {
    if (!files?.[name]) errors.push(`asset ausente: ${name}`);
  }
  if (bundled) {
    if (bundled.version !== version) errors.push(`o app no DMG é ${bundled.version}, esperado ${version}`);
    const updatesFrom = bundled.updateRepo ?? DEFAULT_UPDATE_REPO;
    if (updatesFrom !== repo) errors.push(`o app no DMG busca atualizações em ${updatesFrom}, mas a release vai para ${repo}`);
    if (!bundled.protonManifestSha || bundled.protonManifestSha !== bundled.protonSha) {
      errors.push('o proton-confgen do DMG não confere com o manifesto');
    }
  } else {
    errors.push('conteúdo do DMG não verificado');
  }
  return errors;
}

/** Corpo da criação da release. make_latest é sempre "false", qualquer que seja o canal. */
export function createPayload({ version, target, notes }) {
  return {
    tag_name: releaseTag(version),
    target_commitish: target,
    name: `GoLiveBypass macOS ${version}`,
    body: notes,
    draft: true,
    prerelease: isPrerelease(version),
    make_latest: 'false',
  };
}

export function publishPayload() {
  return { draft: false, make_latest: 'false' };
}

/** Confere a release publicada e a latest do repositório depois da publicação. */
export function postflightErrors({ version, release, latestTagBefore, latestTagAfter, dmgSha256 }) {
  const errors = [];
  const tag = releaseTag(version);
  if (latestTagAfter === tag) errors.push(`${tag} virou /releases/latest`);
  else if (latestTagAfter !== latestTagBefore) {
    errors.push(`/releases/latest mudou de ${latestTagBefore ?? 'nenhuma'} para ${latestTagAfter ?? 'nenhuma'}`);
  }
  if (!release) return [...errors, `release ${tag} não encontrada`];
  if (release.tag_name !== tag) errors.push(`tag publicada ${release.tag_name}, esperada ${tag}`);
  if (release.prerelease !== isPrerelease(version)) errors.push(`prerelease=${release.prerelease}, esperado ${isPrerelease(version)}`);
  const names = (release.assets ?? []).map(a => a.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedAssets(version))) {
    errors.push(`assets publicados ${names.join(', ') || '(nenhum)'}; esperados ${expectedAssets(version).join(', ')}`);
  }
  const dmg = (release.assets ?? []).find(a => a.name === dmgName(version));
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(dmg?.digest ?? '')?.[1]?.toLowerCase();
  if (digest && digest !== dmgSha256) errors.push('o digest do DMG publicado não confere com o arquivo local');
  return errors;
}
