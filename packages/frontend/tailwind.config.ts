import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#1e3a5f',
          light: '#2a5298',
          dark: '#152d4a',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
