/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/renderer/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0a0a',
        surface: '#141417',
        panel: '#1e1e22',
        border: 'rgba(255,255,255,0.08)',
        muted: '#71717a',
        violet: '#8b5cf6',
        violetSoft: '#a78bfa',
        cyan: '#8b5cf6',
        purple: '#8b5cf6',
        green: '#22c55e',
        red: '#ef4444',
        gold: '#facc15',
        zinc: '#18181b'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Rajdhani', 'sans-serif']
      },
      borderRadius: {
        app: '16px'
      }
    }
  },
  plugins: []
}
