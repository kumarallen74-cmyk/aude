import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { type, useTheme } from '@/theme';

export type TextVariant = keyof typeof type;
type Tone = 'default' | 'muted' | 'faint' | 'accent' | 'danger' | 'warning' | 'success' | 'on' | 'info';

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: Tone;
  align?: TextStyle['textAlign'];
  color?: string;
}

/**
 * Text with the app's type scale. Font scaling is ON (Dynamic Type / Android font size); `maxFontSizeMultiplier`
 * caps at 2× (spec §7 "up to 200 %"), large display numbers at 1.6× so prices never truncate.
 */
export function Text({ variant = 'body', tone = 'default', align, color, style, maxFontSizeMultiplier, ...rest }: AppTextProps) {
  const { c } = useTheme();
  const toneColor: Record<Tone, string> = {
    default: c.text, muted: c.textMuted, faint: c.textFaint, accent: c.accent, danger: c.danger, warning: c.warning, success: c.success, on: c.on, info: c.info,
  };
  const big = variant === 'hero' || variant === 'display';
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? (big ? 1.6 : 2)}
      style={[type[variant] as TextStyle, { color: color ?? toneColor[tone] }, align ? { textAlign: align } : null, style]}
    />
  );
}
