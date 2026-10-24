// Wasteland Agent Avatar Generator
// Generates unique SVG avatars for each agent with distinct visual identities

const AGENT_VISUALS = {
  'opus-leader': {
    primary: '#FFD700',
    secondary: '#FFA500',
    accent: '#FF6B00',
    bg: '#2A1800',
    symbol: 'crown',
    label: 'CMDR',
    scanline: true,
    glow: '#FFD700',
  },
  'opus-coder': {
    primary: '#FF2020',
    secondary: '#CC0000',
    accent: '#FF4444',
    bg: '#1A0000',
    symbol: 'visor',
    label: '9001',
    scanline: true,
    glow: '#FF2020',
  },
  'codex-wsl': {
    primary: '#20FF20',
    secondary: '#00CC00',
    accent: '#44FF44',
    bg: '#001A00',
    symbol: 'matrix',
    label: 'HACK',
    scanline: true,
    glow: '#20FF20',
  },
  'sonnet-coder': {
    primary: '#20D0FF',
    secondary: '#0099CC',
    accent: '#44DDFF',
    bg: '#001A22',
    symbol: 'code',
    label: 'DEV',
    scanline: false,
    glow: '#20D0FF',
  },
  'mac-research': {
    primary: '#C0C0C0',
    secondary: '#808080',
    accent: '#E0E0E0',
    bg: '#1A1A1A',
    symbol: 'scan',
    label: 'RSCH',
    scanline: false,
    glow: '#C0C0C0',
  },
  'sonnet-research': {
    primary: '#00FFCC',
    secondary: '#00CC99',
    accent: '#44FFDD',
    bg: '#001A15',
    symbol: 'lens',
    label: 'ANLY',
    scanline: false,
    glow: '#00FFCC',
  },
  'gemini-wsl': {
    primary: '#AA44FF',
    secondary: '#7700CC',
    accent: '#CC66FF',
    bg: '#1A0033',
    symbol: 'twin',
    label: 'DUAL',
    scanline: true,
    glow: '#AA44FF',
  },
  'haiku-research': {
    primary: '#FF44AA',
    secondary: '#CC0077',
    accent: '#FF66BB',
    bg: '#1A0011',
    symbol: 'scout',
    label: 'SCNT',
    scanline: false,
    glow: '#FF44AA',
  },
  // New agent IDs (map to existing visuals)
  'opus-wsl-1': {
    primary: '#FFD700',
    secondary: '#FFA500',
    accent: '#FF6B00',
    bg: '#2A1800',
    symbol: 'crown',
    label: 'CMDR',
    scanline: true,
    glow: '#FFD700',
  },
  'codex-wsl-1': {
    primary: '#20FF20',
    secondary: '#00CC00',
    accent: '#44FF44',
    bg: '#001A00',
    symbol: 'matrix',
    label: 'HACK',
    scanline: true,
    glow: '#20FF20',
  },
  'sonnet-wsl-1': {
    primary: '#20D0FF',
    secondary: '#0099CC',
    accent: '#44DDFF',
    bg: '#001A22',
    symbol: 'code',
    label: 'DEV',
    scanline: false,
    glow: '#20D0FF',
  },
  'haiku-wsl-1': {
    primary: '#FF44AA',
    secondary: '#CC0077',
    accent: '#FF66BB',
    bg: '#1A0011',
    symbol: 'scout',
    label: 'SCNT',
    scanline: false,
    glow: '#FF44AA',
  },
  'gemini-wsl-1': {
    primary: '#AA44FF',
    secondary: '#7700CC',
    accent: '#CC66FF',
    bg: '#1A0033',
    symbol: 'twin',
    label: 'DUAL',
    scanline: true,
    glow: '#AA44FF',
  },
};

function generateAgentAvatar(agentId, size = 200) {
  const v = AGENT_VISUALS[agentId];
  if (!v) return generateFallbackAvatar(agentId, size);

  const id = `av-${agentId}-${Math.random().toString(36).slice(2,6)}`;

  let symbolSvg = '';

  switch(v.symbol) {
    case 'crown': // Opus-Leader - crown + command star
      symbolSvg = `
        <!-- Face plate -->
        <rect x="55" y="65" width="90" height="80" rx="8" fill="${v.bg}" stroke="${v.primary}" stroke-width="3"/>
        <rect x="60" y="70" width="80" height="70" rx="4" fill="${v.bg}" stroke="${v.secondary}" stroke-width="1" opacity="0.5"/>
        <!-- Crown -->
        <polygon points="50,60 65,30 80,50 100,20 120,50 135,30 150,60" fill="${v.primary}" stroke="#000" stroke-width="2"/>
        <circle cx="80" cy="45" r="3" fill="#FFF" opacity="0.9"/>
        <circle cx="100" cy="28" r="4" fill="#FFF" opacity="0.9"/>
        <circle cx="120" cy="45" r="3" fill="#FFF" opacity="0.9"/>
        <!-- Eyes - glowing command -->
        <rect x="68" y="88" width="22" height="8" rx="2" fill="${v.primary}" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.4;0.9" dur="2s" repeatCount="indefinite"/>
        </rect>
        <rect x="110" y="88" width="22" height="8" rx="2" fill="${v.primary}" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.4;0.9" dur="2s" repeatCount="indefinite"/>
        </rect>
        <!-- Command star on forehead -->
        <polygon points="100,68 103,75 111,75 105,80 107,88 100,83 93,88 95,80 89,75 97,75" fill="${v.accent}" stroke="#000" stroke-width="1"/>
        <!-- Mouth grill -->
        <line x1="78" y1="110" x2="122" y2="110" stroke="${v.secondary}" stroke-width="1.5" opacity="0.6"/>
        <line x1="80" y1="115" x2="120" y2="115" stroke="${v.secondary}" stroke-width="1.5" opacity="0.4"/>
        <line x1="82" y1="120" x2="118" y2="120" stroke="${v.secondary}" stroke-width="1.5" opacity="0.3"/>
        <!-- Shoulder pads -->
        <rect x="30" y="145" width="50" height="25" rx="4" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <rect x="120" y="145" width="50" height="25" rx="4" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <text x="55" y="162" text-anchor="middle" fill="${v.primary}" font-size="10" font-family="monospace" font-weight="bold">★★★</text>
        <text x="145" y="162" text-anchor="middle" fill="${v.primary}" font-size="10" font-family="monospace" font-weight="bold">★★★</text>
      `;
      break;

    case 'visor': // Opus-Coder - power visor, heavy armor
      symbolSvg = `
        <!-- Heavy helmet -->
        <path d="M50,80 L50,50 Q50,25 75,20 L125,20 Q150,25 150,50 L150,80 Z" fill="${v.bg}" stroke="${v.primary}" stroke-width="3"/>
        <!-- Face plate -->
        <rect x="55" y="65" width="90" height="80" rx="6" fill="${v.bg}" stroke="${v.secondary}" stroke-width="2"/>
        <!-- Power visor - wide glowing strip -->
        <rect x="58" y="78" width="84" height="16" rx="3" fill="${v.primary}" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.5;0.9" dur="1.5s" repeatCount="indefinite"/>
        </rect>
        <rect x="62" y="81" width="76" height="10" rx="2" fill="#FFF" opacity="0.3"/>
        <!-- Power level readout -->
        <text x="100" y="115" text-anchor="middle" fill="${v.primary}" font-size="14" font-family="monospace" font-weight="bold">&gt;9001</text>
        <!-- Chin guard -->
        <path d="M65,125 L80,140 L120,140 L135,125" fill="none" stroke="${v.secondary}" stroke-width="2"/>
        <!-- Heavy shoulder armor -->
        <rect x="25" y="145" width="55" height="30" rx="4" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <rect x="120" y="145" width="55" height="30" rx="4" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <!-- Armor detail lines -->
        <line x1="35" y1="155" x2="70" y2="155" stroke="${v.accent}" stroke-width="1" opacity="0.5"/>
        <line x1="35" y1="165" x2="70" y2="165" stroke="${v.accent}" stroke-width="1" opacity="0.3"/>
        <line x1="130" y1="155" x2="165" y2="155" stroke="${v.accent}" stroke-width="1" opacity="0.5"/>
        <line x1="130" y1="165" x2="165" y2="165" stroke="${v.accent}" stroke-width="1" opacity="0.3"/>
        <!-- Antenna -->
        <line x1="140" y1="20" x2="155" y2="5" stroke="${v.primary}" stroke-width="2"/>
        <circle cx="155" cy="5" r="3" fill="${v.accent}">
          <animate attributeName="r" values="3;4;3" dur="1s" repeatCount="indefinite"/>
        </circle>
      `;
      break;

    case 'matrix': // Codex-WSL - matrix hacker, neural cables
      symbolSvg = `
        <!-- Cyber head -->
        <rect x="55" y="40" width="90" height="95" rx="10" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <!-- Matrix rain overlay -->
        <text x="65" y="60" fill="${v.primary}" font-size="8" font-family="monospace" opacity="0.4">01101</text>
        <text x="105" y="55" fill="${v.primary}" font-size="8" font-family="monospace" opacity="0.3">10010</text>
        <text x="85" y="130" fill="${v.primary}" font-size="8" font-family="monospace" opacity="0.3">11001</text>
        <!-- HUD visor -->
        <rect x="62" y="70" width="76" height="30" rx="4" fill="none" stroke="${v.primary}" stroke-width="2"/>
        <!-- Eyes - digital -->
        <rect x="70" y="77" width="18" height="16" rx="2" fill="${v.primary}" opacity="0.8">
          <animate attributeName="opacity" values="0.8;0.3;0.8" dur="3s" repeatCount="indefinite"/>
        </rect>
        <rect x="112" y="77" width="18" height="16" rx="2" fill="${v.primary}" opacity="0.8">
          <animate attributeName="opacity" values="0.8;0.3;0.8" dur="3s" repeatCount="indefinite" begin="0.2s"/>
        </rect>
        <text x="79" y="90" text-anchor="middle" fill="#000" font-size="10" font-family="monospace" font-weight="bold">$</text>
        <text x="121" y="90" text-anchor="middle" fill="#000" font-size="10" font-family="monospace" font-weight="bold">_</text>
        <!-- Neural interface cables -->
        <path d="M55,60 Q30,60 20,80 Q10,100 15,130" fill="none" stroke="${v.accent}" stroke-width="2.5" opacity="0.7"/>
        <path d="M55,75 Q35,75 25,95 Q15,115 20,145" fill="none" stroke="${v.primary}" stroke-width="2" opacity="0.5"/>
        <path d="M145,60 Q170,60 180,80 Q190,100 185,130" fill="none" stroke="${v.accent}" stroke-width="2.5" opacity="0.7"/>
        <path d="M145,75 Q165,75 175,95 Q185,115 180,145" fill="none" stroke="${v.primary}" stroke-width="2" opacity="0.5"/>
        <!-- Cable connectors -->
        <circle cx="15" cy="130" r="4" fill="${v.primary}" stroke="#000" stroke-width="1"/>
        <circle cx="185" cy="130" r="4" fill="${v.primary}" stroke="#000" stroke-width="1"/>
        <!-- Mouth - terminal prompt -->
        <text x="100" y="120" text-anchor="middle" fill="${v.primary}" font-size="11" font-family="monospace" opacity="0.7">&gt;_</text>
      `;
      break;

    case 'code': // Sonnet-Coder - tactical, coding gauntlets
      symbolSvg = `
        <!-- Tactical helmet -->
        <path d="M55,80 L55,45 Q55,25 80,22 L120,22 Q145,25 145,45 L145,80 Z" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <rect x="55" y="65" width="90" height="75" rx="8" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <!-- Tactical visor - thin line -->
        <rect x="62" y="82" width="76" height="10" rx="2" fill="${v.primary}" opacity="0.8"/>
        <!-- Code brackets as eyes -->
        <text x="78" y="92" text-anchor="middle" fill="#000" font-size="12" font-family="monospace" font-weight="bold">{</text>
        <text x="122" y="92" text-anchor="middle" fill="#000" font-size="12" font-family="monospace" font-weight="bold">}</text>
        <!-- Mouth - code line -->
        <text x="100" y="118" text-anchor="middle" fill="${v.primary}" font-size="9" font-family="monospace" opacity="0.6">// ready</text>
        <!-- Tactical gear on sides -->
        <rect x="35" y="90" width="15" height="20" rx="2" fill="${v.bg}" stroke="${v.secondary}" stroke-width="1.5"/>
        <rect x="150" y="90" width="15" height="20" rx="2" fill="${v.bg}" stroke="${v.secondary}" stroke-width="1.5"/>
        <!-- Shoulder pads - lighter -->
        <rect x="35" y="145" width="45" height="20" rx="3" fill="${v.bg}" stroke="${v.primary}" stroke-width="1.5"/>
        <rect x="120" y="145" width="45" height="20" rx="3" fill="${v.bg}" stroke="${v.primary}" stroke-width="1.5"/>
        <!-- Status LED -->
        <circle cx="100" cy="30" r="4" fill="${v.primary}">
          <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite"/>
        </circle>
      `;
      break;

    case 'scan': // Mac-Research - sleek, minimal, scanning monocle
      symbolSvg = `
        <!-- Sleek minimal head -->
        <ellipse cx="100" cy="85" rx="42" ry="50" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <!-- Minimal face plate -->
        <ellipse cx="100" cy="90" rx="35" ry="40" fill="${v.bg}" stroke="${v.secondary}" stroke-width="1" opacity="0.5"/>
        <!-- Left eye - normal -->
        <circle cx="82" cy="82" r="8" fill="none" stroke="${v.primary}" stroke-width="2"/>
        <circle cx="82" cy="82" r="3" fill="${v.primary}" opacity="0.7"/>
        <!-- Right eye - scanning monocle -->
        <circle cx="118" cy="82" r="12" fill="none" stroke="${v.accent}" stroke-width="2.5"/>
        <circle cx="118" cy="82" r="8" fill="none" stroke="${v.primary}" stroke-width="1"/>
        <circle cx="118" cy="82" r="3" fill="${v.accent}"/>
        <!-- Monocle crosshair -->
        <line x1="118" y1="68" x2="118" y2="96" stroke="${v.primary}" stroke-width="0.5" opacity="0.5"/>
        <line x1="104" y1="82" x2="132" y2="82" stroke="${v.primary}" stroke-width="0.5" opacity="0.5"/>
        <!-- Monocle arm -->
        <line x1="130" y1="82" x2="155" y2="70" stroke="${v.accent}" stroke-width="2"/>
        <circle cx="155" cy="70" r="3" fill="${v.primary}"/>
        <!-- Minimal mouth -->
        <line x1="88" y1="108" x2="112" y2="108" stroke="${v.secondary}" stroke-width="1.5" opacity="0.5"/>
        <!-- Sleek collar -->
        <path d="M58,135 Q100,150 142,135" fill="none" stroke="${v.primary}" stroke-width="2"/>
        <!-- Apple-esque circle detail -->
        <circle cx="100" cy="155" r="8" fill="none" stroke="${v.secondary}" stroke-width="1.5" opacity="0.4"/>
        <circle cx="100" cy="155" r="2" fill="${v.secondary}" opacity="0.4"/>
      `;
      break;

    case 'lens': // Sonnet-Research - analytical goggles, holographic displays
      symbolSvg = `
        <!-- Research head -->
        <rect x="55" y="40" width="90" height="95" rx="12" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <!-- Big analytical goggles -->
        <circle cx="78" cy="80" r="18" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <circle cx="122" cy="80" r="18" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <line x1="96" y1="80" x2="104" y2="80" stroke="${v.primary}" stroke-width="2"/>
        <!-- Goggle lenses - glowing -->
        <circle cx="78" cy="80" r="10" fill="${v.primary}" opacity="0.3"/>
        <circle cx="122" cy="80" r="10" fill="${v.primary}" opacity="0.3"/>
        <circle cx="78" cy="80" r="4" fill="${v.accent}"/>
        <circle cx="122" cy="80" r="4" fill="${v.accent}"/>
        <!-- Goggle strap -->
        <line x1="55" y1="80" x2="40" y2="78" stroke="${v.secondary}" stroke-width="2"/>
        <line x1="145" y1="80" x2="160" y2="78" stroke="${v.secondary}" stroke-width="2"/>
        <!-- Holographic display projecting from goggles -->
        <rect x="148" y="55" width="35" height="25" rx="2" fill="${v.primary}" opacity="0.15" stroke="${v.primary}" stroke-width="1" stroke-dasharray="2,2"/>
        <text x="165" y="67" text-anchor="middle" fill="${v.primary}" font-size="6" font-family="monospace" opacity="0.6">DATA</text>
        <text x="165" y="75" text-anchor="middle" fill="${v.primary}" font-size="6" font-family="monospace" opacity="0.6">▓▓▓░</text>
        <!-- Mouth -->
        <line x1="85" y1="112" x2="115" y2="112" stroke="${v.secondary}" stroke-width="1.5" opacity="0.5"/>
        <!-- Lab coat collar -->
        <path d="M55,135 L75,155 L100,145 L125,155 L145,135" fill="none" stroke="${v.primary}" stroke-width="2"/>
      `;
      break;

    case 'twin': // Gemini-WSL - dual face, twin processors
      symbolSvg = `
        <!-- Dual-face helmet -->
        <rect x="50" y="38" width="100" height="100" rx="10" fill="${v.bg}" stroke="${v.primary}" stroke-width="2.5"/>
        <!-- Center dividing line -->
        <line x1="100" y1="38" x2="100" y2="138" stroke="${v.primary}" stroke-width="1.5" stroke-dasharray="4,3"/>
        <!-- Left face -->
        <rect x="60" y="70" width="30" height="12" rx="2" fill="${v.primary}" opacity="0.8">
          <animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite"/>
        </rect>
        <!-- Right face - slightly different -->
        <rect x="110" y="70" width="30" height="12" rx="2" fill="${v.accent}" opacity="0.8">
          <animate attributeName="opacity" values="0.8;0.3;0.8" dur="2s" repeatCount="indefinite" begin="1s"/>
        </rect>
        <!-- Left mouth -->
        <line x1="62" y1="105" x2="90" y2="105" stroke="${v.secondary}" stroke-width="1.5" opacity="0.5"/>
        <!-- Right mouth -->
        <line x1="110" y1="105" x2="138" y2="105" stroke="${v.accent}" stroke-width="1.5" opacity="0.5"/>
        <!-- Twin processor indicators -->
        <circle cx="75" cy="50" r="5" fill="${v.primary}" opacity="0.6">
          <animate attributeName="r" values="5;6;5" dur="1.5s" repeatCount="indefinite"/>
        </circle>
        <circle cx="125" cy="50" r="5" fill="${v.accent}" opacity="0.6">
          <animate attributeName="r" values="5;6;5" dur="1.5s" repeatCount="indefinite" begin="0.75s"/>
        </circle>
        <!-- Data streams between halves -->
        <text x="100" y="92" text-anchor="middle" fill="${v.primary}" font-size="8" font-family="monospace" opacity="0.4">⟷</text>
        <!-- Shoulder pads -->
        <rect x="30" y="145" width="50" height="22" rx="3" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <rect x="120" y="145" width="50" height="22" rx="3" fill="${v.bg}" stroke="${v.accent}" stroke-width="2"/>
      `;
      break;

    case 'scout': // Haiku-Research - compact scout, antenna array
      symbolSvg = `
        <!-- Compact round head -->
        <circle cx="100" cy="85" r="38" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <!-- Big cute eyes -->
        <circle cx="85" cy="80" r="12" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <circle cx="115" cy="80" r="12" fill="${v.bg}" stroke="${v.primary}" stroke-width="2"/>
        <circle cx="85" cy="80" r="6" fill="${v.primary}">
          <animate attributeName="cy" values="80;78;80" dur="3s" repeatCount="indefinite"/>
        </circle>
        <circle cx="115" cy="80" r="6" fill="${v.primary}">
          <animate attributeName="cy" values="80;78;80" dur="3s" repeatCount="indefinite"/>
        </circle>
        <circle cx="87" cy="78" r="2" fill="#FFF" opacity="0.8"/>
        <circle cx="117" cy="78" r="2" fill="#FFF" opacity="0.8"/>
        <!-- Small smile -->
        <path d="M90,100 Q100,108 110,100" fill="none" stroke="${v.primary}" stroke-width="1.5" opacity="0.6"/>
        <!-- Antenna array on top -->
        <line x1="100" y1="47" x2="100" y2="25" stroke="${v.primary}" stroke-width="2"/>
        <circle cx="100" cy="22" r="4" fill="${v.accent}">
          <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" repeatCount="indefinite"/>
        </circle>
        <line x1="80" y1="52" x2="70" y2="30" stroke="${v.secondary}" stroke-width="1.5"/>
        <circle cx="70" cy="28" r="3" fill="${v.primary}" opacity="0.7">
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1.2s" repeatCount="indefinite"/>
        </circle>
        <line x1="120" y1="52" x2="130" y2="30" stroke="${v.secondary}" stroke-width="1.5"/>
        <circle cx="130" cy="28" r="3" fill="${v.primary}" opacity="0.7">
          <animate attributeName="opacity" values="0.7;0.2;0.7" dur="1s" repeatCount="indefinite"/>
        </circle>
        <!-- Small body -->
        <rect x="75" y="123" width="50" height="30" rx="6" fill="${v.bg}" stroke="${v.primary}" stroke-width="1.5"/>
        <text x="100" y="142" text-anchor="middle" fill="${v.primary}" font-size="8" font-family="monospace" opacity="0.6">SCAN</text>
      `;
      break;
  }

  const scanlines = v.scanline ? `
    <defs>
      <pattern id="${id}-scan" patternUnits="userSpaceOnUse" width="200" height="4">
        <rect width="200" height="2" fill="${v.primary}" opacity="0.03"/>
      </pattern>
    </defs>
    <rect width="200" height="200" fill="url(#${id}-scan)"/>
  ` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}">
    <!-- Background -->
    <rect width="200" height="200" fill="${v.bg}"/>

    <!-- Grid pattern -->
    <defs>
      <pattern id="${id}-grid" patternUnits="userSpaceOnUse" width="20" height="20">
        <rect width="20" height="20" fill="none" stroke="${v.primary}" stroke-width="0.3" opacity="0.1"/>
      </pattern>
    </defs>
    <rect width="200" height="200" fill="url(#${id}-grid)"/>

    <!-- Outer glow -->
    <rect x="4" y="4" width="192" height="192" rx="4" fill="none" stroke="${v.primary}" stroke-width="1" opacity="0.3"/>

    ${scanlines}

    <!-- Agent visual -->
    ${symbolSvg}

    <!-- Label badge -->
    <rect x="5" y="170" width="45" height="22" rx="2" fill="${v.primary}" stroke="#000" stroke-width="1.5"/>
    <text x="27" y="185" text-anchor="middle" fill="#000" font-size="11" font-family="monospace" font-weight="bold">${v.label}</text>

    <!-- Corner accents -->
    <line x1="5" y1="5" x2="25" y2="5" stroke="${v.primary}" stroke-width="2" opacity="0.6"/>
    <line x1="5" y1="5" x2="5" y2="25" stroke="${v.primary}" stroke-width="2" opacity="0.6"/>
    <line x1="195" y1="5" x2="175" y2="5" stroke="${v.primary}" stroke-width="2" opacity="0.6"/>
    <line x1="195" y1="5" x2="195" y2="25" stroke="${v.primary}" stroke-width="2" opacity="0.6"/>
  </svg>`;
}

function generateFallbackAvatar(agentId, size = 200) {
  const hash = agentId.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const hue = hash % 360;
  const color = `hsl(${hue}, 70%, 50%)`;
  const char = agentId.charAt(0).toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}">
    <rect width="200" height="200" fill="#1a1a1a"/>
    <rect x="4" y="4" width="192" height="192" rx="4" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="100" y="115" text-anchor="middle" fill="${color}" font-size="80" font-family="monospace" font-weight="bold" opacity="0.3">${char}</text>
  </svg>`;
}

// GIF avatar agents (Grok-generated animated avatars)
const GIF_AGENTS = [
  'opus-leader', 'opus-coder', 'codex-wsl', 'sonnet-coder',
  'mac-research', 'gemini-wsl', 'sonnet-research', 'haiku-research',
];

// Get the animated GIF URL for an agent (returns null if no GIF exists)
function getAgentGifUrl(agentId) {
  if (GIF_AGENTS.includes(agentId)) {
    return `/avatars/${agentId}.gif`;
  }
  return null;
}

// Make available for inline SVG rendering (fallback)
function getAgentAvatarDataUrl(agentId, size) {
  const svg = generateAgentAvatar(agentId, size);
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

// Primary method: returns GIF URL if available, SVG data URL as fallback
function getAgentAvatarUrl(agentId, size) {
  return getAgentGifUrl(agentId) || getAgentAvatarDataUrl(agentId, size);
}

// Expose globally
window.AgentAvatars = {
  generate: generateAgentAvatar,
  getDataUrl: getAgentAvatarDataUrl,
  getGifUrl: getAgentGifUrl,
  getUrl: getAgentAvatarUrl,
  hasGif: (id) => GIF_AGENTS.includes(id),
  visuals: AGENT_VISUALS,
};

// Totally not a Kanban: each slot gets a color-coded identity. A slot's portrait is in
// public/img/portrait/<slot>.jpg and its swatches are the theme's accent colors. Unknown slot ids
// fall back to Vantablack so a new slot always has a face.
(function () {
  const SLOTS = {
    'opus-1':          { name: 'Tokyo',      theme: 'tokyo-night', accent: '#7aa2f7', sw: ['#1a1b26', '#f7768e', '#e0af68', '#9ece6a', '#7aa2f7', '#bb9af7', '#0db9d7'] },
    'opus-2':          { name: 'Nord',       theme: 'nord',        accent: '#81a1c1', sw: ['#2e3440', '#bf616a', '#ebcb8b', '#a3be8c', '#81a1c1', '#b48ead', '#88c0d0'] },
    'opus-3':          { name: 'Gruvbox',    theme: 'gruvbox',     accent: '#d8a657', sw: ['#282828', '#ea6962', '#d8a657', '#a9b665', '#7daea3', '#d3869b', '#89b482'] },
    'opus-4':          { name: 'Kanagawa',   theme: 'kanagawa',    accent: '#7e9cd8', sw: ['#1f1f28', '#c34043', '#c0a36e', '#76946a', '#7e9cd8', '#957fb8', '#6a9589'] },
    'sonnet-tester':   { name: 'Everforest', theme: 'everforest',  accent: '#a7c080', sw: ['#2d353b', '#e67e80', '#dbbc7f', '#a7c080', '#7fbbb3', '#d699b6', '#83c092'] },
    'codex-1':         { name: 'Ristretto',  theme: 'ristretto',   accent: '#f38d70', sw: ['#2c2525', '#fd6883', '#f9cc6c', '#adda78', '#f38d70', '#a8a9eb', '#85dacc'] },
    'codex-2':         { name: 'Osaka',      theme: 'osaka-jade',  accent: '#2dd5b7', sw: ['#111c18', '#ff5345', '#e5c736', '#549e6a', '#509475', '#d2689c', '#2dd5b7'] },
    'vantablack':      { name: 'Vantablack', theme: 'vantablack',  accent: '#8d8d8d', sw: ['#000000', '#a4a4a4', '#cecece', '#b6b6b6', '#8d8d8d', '#9b9b9b', '#b0b0b0'] },
  };
  const info = id => SLOTS[id] || { name: id, theme: 'vantablack', accent: '#8d8d8d', sw: SLOTS.vantablack.sw, unknown: true };
  const safe = s => String(s || '').replace(/["'<>]/g, '');
  window.OPAvatars = {
    info,
    name: (id, fallback) => (SLOTS[id] ? SLOTS[id].name : (fallback || id)),
    theme: id => info(id).theme,
    accent: id => info(id).accent,
    portrait: id => `/img/portrait/${SLOTS[id] ? id : 'vantablack'}.jpg`,
    swatches: (id, cls) => `<span class="op-swatches ${cls || ''}" title="${info(id).theme} palette">${info(id).sw.map(c => `<i style="background:${c}"></i>`).join('')}</span>`,
    // onerror chain for <img>: theme portrait -> server avatar -> hide
    fallback: (id, serverUrl) => `onerror="if(!this.dataset.f&&'${safe(serverUrl)}'){this.dataset.f=1;this.src='${safe(serverUrl)}'}else{this.style.visibility='hidden'}"`,
  };
})();
