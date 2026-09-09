# Site GoLiveBypass

Frontend Nuxt 3 do GoLiveBypass. O site apresenta a GUI v2, explica a arquitetura
WireGuard por aplicativo e distribui sempre a release estável mais recente.

## Desenvolvimento local

```sh
npm install
npm run dev
```

Abra `http://localhost:3000`.

## Validação estática

```sh
npm run typecheck
npm run generate
npm run preview
```

A saída estática fica em `.output/public`.

## Downloads dinâmicos

O site consulta no navegador `GET https://api.skyplaceia.com/bugs/v1/releases/latest`.
O catálogo Go consulta o GitHub, rejeita prereleases e mantém cache por cinco
minutos. Os botões usam os aliases `/v1/releases/latest/download/windows`,
`linux`, `mac-dmg`, `mac-zip`, `plugin` e `standalone`, então uma nova release
estável não exige edição ou rebuild do site.

`data/release.ts` contém somente o contrato e o fallback de emergência. Para
desenvolvimento local, sobrescreva a API com:

```sh
NUXT_PUBLIC_RELEASE_API_BASE_URL=http://localhost:8080 npm run dev
```

O fallback atual é a stable `2.0.4` e os links diretos do GitHub nele servem
apenas para renderização inicial ou indisponibilidade da API. A CORS da API deve
conter o domínio publicado em `WEBSITE_ORIGINS`.

A hospedagem e o deploy ainda não fazem parte deste projeto.
