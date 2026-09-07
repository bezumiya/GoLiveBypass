type FlagRenderer = () => string;

const rect = (attrs: string) => `<rect ${attrs}/>`;

function horizontal(...colors: string[]): string {
  const height = 16 / colors.length;
  return colors.map((color, index) => rect(`x="0" y="${index * height}" width="24" height="${height}" fill="${color}"`)).join('');
}

function vertical(...colors: string[]): string {
  const width = 24 / colors.length;
  return colors.map((color, index) => rect(`x="${index * width}" y="0" width="${width}" height="16" fill="${color}"`)).join('');
}

function cross(background: string, crossColor: string, verticalWidth = 3, horizontalHeight = 3): string {
  return `${rect(`width="24" height="16" fill="${background}"`)}${rect(`x="${(24 - verticalWidth) / 2}" width="${verticalWidth}" height="16" fill="${crossColor}"`)}${rect(`y="${(16 - horizontalHeight) / 2}" width="24" height="${horizontalHeight}" fill="${crossColor}"`)}`;
}

function unionJack(width = 24, height = 16): string {
  const scaleX = width / 24;
  const scaleY = height / 16;
  return `<g transform="scale(${scaleX} ${scaleY})">${rect('width="24" height="16" fill="#012169"')}
    ${rect('x="10" width="4" height="16" fill="#FFFFFF"')}
    ${rect('y="6" width="24" height="4" fill="#FFFFFF"')}
    <path d="M0 0 2.6 0 24 13.4V16h-2.6L0 2.6Z M24 0h-2.6L0 13.4V16h2.6L24 2.6Z" fill="#FFFFFF"/>
    ${rect('x="10.8" width="2.4" height="16" fill="#C8102E"')}
    ${rect('y="6.8" width="24" height="2.4" fill="#C8102E"')}</g>`;
}

function fallback(country: string): string {
  const first = country.charCodeAt(0) || 0;
  const second = country.charCodeAt(1) || 0;
  const palettes = [
    ['#315A7D', '#E7E1D6'],
    ['#456B55', '#E5C07B'],
    ['#7A4E5C', '#D7E4E8'],
    ['#5C5C82', '#E5B96B'],
  ];
  const [primary, secondary] = palettes[(first + second) % palettes.length];
  const safeCountry = country.replace(/[^A-Z]/g, '').slice(0, 2) || '—';
  return `${horizontal(primary, secondary, primary)}<text x="12" y="11" fill="#FFFFFF" font-family="Arial,sans-serif" font-size="5.5" font-weight="700" text-anchor="middle" letter-spacing=".3">${safeCountry}</text>`;
}

const flagRenderers: Record<string, FlagRenderer> = {
  // América do Sul e Central
  AR: () => `${horizontal('#74ACDF', '#FFFFFF', '#74ACDF')}<circle cx="12" cy="8" r="2" fill="#F6B40E"/>`,
  BO: () => horizontal('#D52B1E', '#F9E300', '#007934'),
  BR: () => `${rect('width="24" height="16" fill="#009B3A"')}<path d="M12 1.4 22 8 12 14.6 2 8Z" fill="#FFDF00"/><circle cx="12" cy="8" r="3.8" fill="#002776"/><path d="M8.5 7.1c2.5-1.1 5.3-.8 7.2.5" fill="none" stroke="#FFFFFF" stroke-width=".55"/>`,
  CL: () => `${horizontal('#FFFFFF', '#D52B1E')}<rect width="10" height="8" fill="#0039A6"/><path d="m5 1.3.55 1.7h1.8L5.9 4l.55 1.7L5 4.65 3.55 5.7 4.1 4 2.65 3h1.8Z" fill="#FFFFFF"/>`,
  CO: () => `${rect('width="24" height="8" fill="#FCD116"')}${rect('y="8" width="24" height="4" fill="#003893"')}${rect('y="12" width="24" height="4" fill="#CE1126"')}`,
  CR: () => horizontal('#002B7F', '#FFFFFF', '#CE1126', '#FFFFFF', '#002B7F'),
  EC: () => `${rect('width="24" height="8" fill="#FCD116"')}${rect('y="8" width="24" height="4" fill="#034EA2"')}${rect('y="12" width="24" height="4" fill="#ED1C24"')}<circle cx="12" cy="8" r="1.2" fill="#8A1538"/>`,
  MX: () => `${vertical('#006847', '#FFFFFF', '#CE1126')}<circle cx="12" cy="8" r="1.9" fill="#8A1538"/><path d="M10.8 8.4c.8-1.3 1.9-1.2 2.4-.2-.9-.1-1.5.5-1.9 1.2Z" fill="#7B5427"/>`,
  PA: () => `${rect('width="12" height="8" fill="#FFFFFF"')}${rect('x="12" width="12" height="8" fill="#D21034"')}${rect('y="8" width="12" height="8" fill="#005293"')}${rect('x="12" y="8" width="12" height="8" fill="#FFFFFF"')}<path d="m6 2 0.55 1.6h1.7L6.9 4.6l.5 1.5L6 5.2l-1.4.9.5-1.5L3.8 3.6h1.7Z" fill="#005293"/>`,
  PE: () => vertical('#D91023', '#FFFFFF', '#D91023'),
  PY: () => horizontal('#D52B1E', '#FFFFFF', '#0038A8'),
  SV: () => horizontal('#0F47AF', '#FFFFFF', '#0F47AF'),
  UY: () => `${horizontal('#FFFFFF', '#6CCFF6', '#FFFFFF', '#6CCFF6', '#FFFFFF', '#6CCFF6', '#FFFFFF', '#6CCFF6', '#FFFFFF')}<rect width="10" height="8" fill="#FFFFFF"/><circle cx="5" cy="4" r="1.8" fill="#FCD116"/>`,
  VE: () => `${horizontal('#FCD116', '#003893', '#CF142B')}<circle cx="12" cy="8" r=".55" fill="#FFFFFF"/><circle cx="10.2" cy="7.4" r=".55" fill="#FFFFFF"/><circle cx="13.8" cy="7.4" r=".55" fill="#FFFFFF"/><circle cx="10.8" cy="9.1" r=".55" fill="#FFFFFF"/><circle cx="13.2" cy="9.1" r=".55" fill="#FFFFFF"/>`,

  // América do Norte
  CA: () => `${vertical('#D80621', '#FFFFFF', '#D80621')}<path d="m12 3.1.75 2.2 1.9-.7-.8 2.1 1.8.8-2 .6.35 2.4L12 9.2l-2 1.3.35-2.4-2-.6 1.8-.8-.8-2.1 1.9.7Z" fill="#D80621"/>`,
  US: () => `${horizontal('#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234', '#FFFFFF', '#B22234')}<rect width="10.5" height="8.6" fill="#3C3B6E"/><g fill="#FFFFFF"><circle cx="2" cy="2" r=".45"/><circle cx="4.2" cy="2" r=".45"/><circle cx="6.4" cy="2" r=".45"/><circle cx="8.6" cy="2" r=".45"/><circle cx="3.1" cy="3.8" r=".45"/><circle cx="5.3" cy="3.8" r=".45"/><circle cx="7.5" cy="3.8" r=".45"/><circle cx="2" cy="5.6" r=".45"/><circle cx="4.2" cy="5.6" r=".45"/><circle cx="6.4" cy="5.6" r=".45"/><circle cx="8.6" cy="5.6" r=".45"/></g>`,

  // Europa
  AT: () => horizontal('#ED2939', '#FFFFFF', '#ED2939'),
  BE: () => vertical('#000000', '#FDE000', '#EF3340'),
  BG: () => horizontal('#FFFFFF', '#00966E', '#D62612'),
  CH: () => `${rect('width="24" height="16" fill="#D52B1E"')}${rect('x="10" y="3" width="4" height="10" fill="#FFFFFF"')}${rect('x="7" y="6" width="10" height="4" fill="#FFFFFF"')}`,
  CZ: () => `${horizontal('#FFFFFF', '#D7141A')}<path d="M0 0h10.5L0 8Z" fill="#11457E"/>`,
  DE: () => horizontal('#000000', '#DD0000', '#FFCE00'),
  DK: () => cross('#C8102E', '#FFFFFF', 3, 3),
  ES: () => horizontal('#AA151B', '#F1BF00', '#AA151B'),
  FI: () => cross('#FFFFFF', '#003580', 3, 4),
  FR: () => vertical('#0055A4', '#FFFFFF', '#EF4135'),
  GB: unionJack,
  GR: () => `${horizontal('#0D5EAF', '#FFFFFF', '#0D5EAF', '#FFFFFF', '#0D5EAF', '#FFFFFF', '#0D5EAF', '#FFFFFF', '#0D5EAF')}<rect width="10" height="8" fill="#0D5EAF"/><path d="M4 0h2v8H4ZM0 3h10v2H0Z" fill="#FFFFFF"/>`,
  HR: () => horizontal('#FF0000', '#FFFFFF', '#171796'),
  HU: () => horizontal('#CE2939', '#FFFFFF', '#477050'),
  IE: () => vertical('#169B62', '#FFFFFF', '#FF883E'),
  IS: () => `${cross('#02529C', '#FFFFFF', 5, 5)}${rect('x="10.5" width="3" height="16" fill="#DC1E35"')}${rect('y="6.5" width="24" height="3" fill="#DC1E35"')}`,
  IT: () => vertical('#009246', '#FFFFFF', '#CE2B37'),
  LU: () => horizontal('#EF3340', '#FFFFFF', '#00A3E0'),
  NL: () => horizontal('#AE1C28', '#FFFFFF', '#21468B'),
  NO: () => `${cross('#BA0C2F', '#FFFFFF', 5, 5)}${rect('x="10.5" width="3" height="16" fill="#00205B"')}${rect('y="6.5" width="24" height="3" fill="#00205B"')}`,
  PL: () => horizontal('#FFFFFF', '#DC143C'),
  PT: () => `${vertical('#046A38', '#FF0000')}<circle cx="9" cy="8" r="2.2" fill="#F9D616"/><circle cx="9" cy="8" r="1.2" fill="#FFFFFF"/>`,
  RO: () => vertical('#002B7F', '#FCD116', '#CE1126'),
  RS: () => horizontal('#C6363C', '#0C4076', '#FFFFFF'),
  SE: () => cross('#006AA7', '#FECC00', 3, 3),
  SI: () => horizontal('#FFFFFF', '#005DA4', '#EF3340'),
  SK: () => horizontal('#FFFFFF', '#0B4EA2', '#EE1C25'),
  TR: () => `${rect('width="24" height="16" fill="#E30A17"')}<circle cx="10" cy="8" r="3" fill="#FFFFFF"/><circle cx="11.2" cy="8" r="2.4" fill="#E30A17"/><path d="m14.7 5.3.75 2.1 2.2.05-1.75 1.3.65 2.1-1.85-1.2-1.8 1.2.6-2.1-1.7-1.3 2.15-.05Z" fill="#FFFFFF"/>`,
  UA: () => horizontal('#0057B7', '#FFD700'),

  // Ásia e Oceania
  AU: () => `${rect('width="24" height="16" fill="#012169"')}${unionJack(12, 8)}<circle cx="18.5" cy="12" r="1" fill="#FFFFFF"/><circle cx="20.8" cy="9.5" r=".65" fill="#FFFFFF"/><circle cx="16.7" cy="9.4" r=".65" fill="#FFFFFF"/><circle cx="19" cy="6.5" r=".65" fill="#FFFFFF"/>`,
  CN: () => `${rect('width="24" height="16" fill="#DE2910"')}<path d="m4 2 .6 1.8h1.9L5 4.9l.6 1.8L4 5.6 2.4 6.7 3 4.9 2.4 3.8h1.9Z" fill="#FFDE00"/>`,
  HK: () => `${rect('width="24" height="16" fill="#DE2910"')}<circle cx="12" cy="8" r="3.1" fill="#FFFFFF"/><circle cx="12" cy="5.9" r=".65" fill="#DE2910"/><circle cx="14" cy="7" r=".65" fill="#DE2910"/><circle cx="14" cy="9.2" r=".65" fill="#DE2910"/><circle cx="10" cy="9.2" r=".65" fill="#DE2910"/><circle cx="10" cy="7" r=".65" fill="#DE2910"/>`,
  ID: () => horizontal('#CE1126', '#FFFFFF'),
  IN: () => `${horizontal('#FF9933', '#FFFFFF', '#128807')}<circle cx="12" cy="8" r="1.8" fill="none" stroke="#000080" stroke-width=".55"/><circle cx="12" cy="8" r=".35" fill="#000080"/>`,
  JP: () => `${rect('width="24" height="16" fill="#FFFFFF"')}<circle cx="12" cy="8" r="4" fill="#BC002D"/>`,
  KR: () => `${rect('width="24" height="16" fill="#FFFFFF"')}<circle cx="12" cy="8" r="3" fill="#CD2E3A"/><path d="M12 8a3 3 0 0 1 0-3 3 3 0 0 0 0 6 3 3 0 0 1 0-3Z" fill="#0047A0"/>`,
  MY: () => `${horizontal('#CC0001', '#FFFFFF', '#CC0001', '#FFFFFF', '#CC0001', '#FFFFFF', '#CC0001', '#FFFFFF', '#CC0001', '#FFFFFF', '#CC0001', '#FFFFFF', '#CC0001')}<rect width="11" height="8.7" fill="#010066"/><circle cx="4.3" cy="4.4" r="2.1" fill="#FFCC00"/>`,
  NZ: () => `${rect('width="24" height="16" fill="#00247D"')}${unionJack(12, 8)}<circle cx="18" cy="11" r="1" fill="#CC142B" stroke="#FFFFFF" stroke-width=".35"/><circle cx="20.7" cy="8.8" r=".8" fill="#CC142B" stroke="#FFFFFF" stroke-width=".35"/>`,
  PH: () => `${rect('width="24" height="8" fill="#0038A8"')}${rect('y="8" width="24" height="8" fill="#CE1126"')}<path d="M0 0v16l11-8Z" fill="#FFFFFF"/><circle cx="3.2" cy="8" r="1.2" fill="#FCD116"/>`,
  RU: () => horizontal('#FFFFFF', '#0039A6', '#D52B1E'),
  SG: () => `${horizontal('#EF3340', '#FFFFFF')}<circle cx="5" cy="4" r="2.3" fill="#FFFFFF"/><circle cx="5.8" cy="4" r="1.9" fill="#EF3340"/><circle cx="8" cy="2.7" r=".35" fill="#FFFFFF"/><circle cx="9" cy="3.7" r=".35" fill="#FFFFFF"/><circle cx="9" cy="4.8" r=".35" fill="#FFFFFF"/>`,
  TH: () => horizontal('#A51931', '#FFFFFF', '#2D2A4A', '#FFFFFF', '#A51931'),
  TW: () => `${rect('width="24" height="16" fill="#FE0000"')}${rect('width="10.5" height="8" fill="#000095"')}<circle cx="5.2" cy="4" r="2" fill="#FFFFFF"/>`,
  VN: () => `${rect('width="24" height="16" fill="#DA251D"')}<path d="m12 3 .9 3 3.1.1-2.5 1.8.9 3-2.4-1.8-2.5 1.8.9-3L8 6.1l3.1-.1Z" fill="#FFFF00"/>`,

  // África e Oriente Médio
  AE: () => `${rect('width="6" height="16" fill="#FF0000"')}${rect('x="6" width="18" height="5.33" fill="#00732F"')}${rect('x="6" y="5.33" width="18" height="5.34" fill="#FFFFFF"')}${rect('x="6" y="10.67" width="18" height="5.33" fill="#000000"')}`,
  EG: () => `${horizontal('#CE1126', '#FFFFFF', '#000000')}<circle cx="12" cy="8" r="1.2" fill="#C09300"/>`,
  IL: () => `${rect('width="24" height="16" fill="#FFFFFF"')}${rect('y="2" width="24" height="2" fill="#0038B8"')}${rect('y="12" width="24" height="2" fill="#0038B8"')}<path d="m12 4.6 2.4 4.1-2.4 4.1-2.4-4.1Z" fill="none" stroke="#0038B8" stroke-width=".7"/>`,
  MA: () => `${rect('width="24" height="16" fill="#C1272D"')}<path d="m12 4.2 1 2.8h3l-2.4 1.7.9 2.8-2.5-1.7-2.5 1.7.9-2.8L8 7h3Z" fill="none" stroke="#006233" stroke-width=".75"/>`,
  ZA: () => `${rect('width="24" height="16" fill="#DE3831"')}${rect('y="8" width="24" height="8" fill="#002395"')}<path d="M0 0 12 8 0 16Z" fill="#000000"/><path d="M0 1.8 9.2 8 0 14.2Z" fill="#FFB81C"/><path d="M0 3.6 6.5 8 0 12.4Z" fill="#007A4D"/>`,
};

export function renderProtonCountryFlag(country?: string): string {
  const code = typeof country === 'string' ? country.trim().toUpperCase().slice(0, 2) : '';
  const content = flagRenderers[code]?.() ?? fallback(code);
  return `<svg class="proton-country-flag-svg" viewBox="0 0 24 16" preserveAspectRatio="none" aria-hidden="true" focusable="false">${content}</svg>`;
}
