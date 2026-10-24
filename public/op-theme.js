// Wasteland Bounty Board. Shared Tailwind (Play CDN) theme; load right after the CDN script.
// Recolours every utility into the Tokyo Night palette: primary = tokyo blue, warning = tokyo yellow,
// danger = tokyo red, gray/zinc = night tints, purple = magenta, sky = cyan.
(function () {
  const night = {
    50: '#e8ecfa', 100: '#c0caf5', 200: '#a9b1d6', 300: '#9aa5ce', 400: '#7982a9', 500: '#565f89',
    600: '#414868', 700: '#2f3549', 800: '#24283b', 900: '#1a1b26', 950: '#13141c',
  };
  const magenta = { 200: '#d8caf9', 300: '#c8b3f7', 400: '#bb9af7', 500: '#9d7cd8', 600: '#7f5fbf', 700: '#5f4694' };
  const cyan = { 200: '#b6e4ff', 300: '#9ad8ff', 400: '#7dcfff', 500: '#2ac3de', 600: '#0db9d7', 700: '#0f7f99' };
  const green = { 300: '#b9f27c', 400: '#9ece6a', 500: '#85b85a', 600: '#73a84a', 700: '#4f7a33', 800: '#2f4a1f' };
  const orange = { 300: '#ffb98a', 400: '#ff9e64', 500: '#e68a52', 600: '#c47342' };
  const yellow = { 300: '#f0c98a', 400: '#e0af68', 500: '#d49a4c', 600: '#b8863d' };
  const red = { 300: '#ff9eb0', 400: '#f7768e', 500: '#e45f7a', 600: '#c94b66' };
  const blue = { 300: '#a6bfff', 400: '#7aa2f7', 500: '#6a8fe0', 600: '#5a7bc4' };
  const deep = '0 1px 0 rgba(192,202,245,.05) inset, 0 10px 26px rgba(0,0,0,.6)';
  const soft = '0 4px 12px rgba(0,0,0,.5)';
  window.tailwind = window.tailwind || {};
  tailwind.config = {
    darkMode: 'class',
    theme: {
      extend: {
        colors: {
          primary: '#7aa2f7', 'primary-dark': '#5a7bc4', 'background-dark': '#0b0b10',
          danger: '#f7768e', warning: '#e0af68', botched: '#414868',
          gray: night, zinc: night, purple: magenta, sky: cyan, green, orange, yellow, red, blue,
          night: '#1a1b26', magenta: '#bb9af7', cyan: '#7dcfff', tokyo: '#7aa2f7',
        },
        fontFamily: {
          display: ['Inter', '"Segoe UI"', 'system-ui', 'sans-serif'],
          hand: ['"Chakra Petch"', 'Inter', 'sans-serif'],
          mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        },
        boxShadow: {
          comic: deep, 'comic-hover': '0 0 0 1px rgba(122,162,247,.45), 0 14px 30px rgba(0,0,0,.65)', 'comic-sm': soft,
          hard: deep, 'hard-sm': soft, 'hard-lg': '0 14px 34px rgba(0,0,0,.65)', glow: '0 0 24px rgba(122,162,247,.35)',
          cel: deep, 'cel-sm': soft, 'cel-lg': '0 14px 34px rgba(0,0,0,.65)',
        },
      },
    },
  };
})();
