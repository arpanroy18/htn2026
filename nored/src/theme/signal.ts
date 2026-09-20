export const signal = {
  blue: '#2c6bed',
  deep: '#2942ff',
  sky: '#9dbbf8',
  mist: '#a5cad5',
  amber: '#ffe08a',
  ink: '#1b1b1b',
  slate: '#404654',
  twilight: '#3c3744',
  fog: '#e9e9e9',
  paper: '#f6f6f6',
  white: '#ffffff',
  yellow: '#f5c518',
  orange: '#f57c00',
  red: '#e53935',
  shadow: 'rgba(0, 0, 0, 0.12) 0px 4px 12px 0px, rgba(0, 0, 0, 0.08) 0px 0px 2px 0px',
} as const;

export const type = {
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  subheading: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const },
  headingSm: { fontSize: 28, lineHeight: 38, fontWeight: '800' as const },
  heading: { fontSize: 40, lineHeight: 46, fontWeight: '800' as const },
};
