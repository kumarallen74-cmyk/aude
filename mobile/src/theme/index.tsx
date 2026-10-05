import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { useSettings } from '@/state/settings';
import { colors, elevation, type Colors, type Scheme } from './tokens';

export * from './tokens';

interface Theme {
  c: Colors;
  scheme: Scheme;
  shadow: (level: 1 | 2 | 3) => ReturnType<typeof elevation>;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children, forced }: { children: ReactNode; forced?: Scheme }) {
  const system = useColorScheme();
  const pref = useSettings((s) => s.theme);
  const scheme: Scheme = forced ?? (pref === 'system' ? (system === 'light' ? 'light' : 'dark') : pref);
  const value = useMemo<Theme>(() => ({ c: colors[scheme], scheme, shadow: (l) => elevation(scheme, l) }), [scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const t = useContext(ThemeContext);
  if (t) return t;
  // Outside the provider (isolated component tests): dark theme.
  return { c: colors.dark, scheme: 'dark', shadow: (l) => elevation('dark', l) };
}
