/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        background: '#020617',
        foreground: '#f9fafb',
        card: '#020617',
        primary: {
          DEFAULT: '#7c5cff',
          foreground: '#f9fafb'
        },
        secondary: {
          DEFAULT: '#0f172a',
          foreground: '#e5e7eb'
        },
        border: '#1f2937',
        input: '#1f2937',
        ring: '#7c5cff'
      },
      borderRadius: {
        xl: '0.9rem',
        '2xl': '1.1rem'
      }
    }
  },
  plugins: []
};

