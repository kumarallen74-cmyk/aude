import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, touch, useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';

export function haptic(kind: 'light' | 'medium' | 'success' | 'warning' | 'selection' = 'light') {
  if (Platform.OS === 'web') return;
  if (kind === 'selection') void Haptics.selectionAsync().catch(() => {});
  else if (kind === 'success' || kind === 'warning')
    void Haptics.notificationAsync(kind === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
  else void Haptics.impactAsync(kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg' | 'sm';
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
  testID?: string;
  full?: boolean;
}

export function Button({ label, onPress, variant = 'primary', icon, iconRight, loading, disabled, size = 'lg', style, accessibilityHint, testID, full = true }: ButtonProps) {
  const { c } = useTheme();
  const bg: Record<ButtonVariant, string> = { primary: c.fill, secondary: c.raised, ghost: 'transparent', danger: c.danger, quiet: c.accentSoft };
  const fg: Record<ButtonVariant, string> = { primary: c.on, secondary: c.text, ghost: c.accent, danger: c.scheme === 'dark' ? '#1a0606' : '#ffffff', quiet: c.accent };
  const h = size === 'lg' ? touch.comfortable + 4 : size === 'md' ? touch.comfortable - 4 : touch.min;
  const off = disabled || loading;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      disabled={off}
      onPress={() => {
        haptic(variant === 'danger' ? 'medium' : 'light');
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: h,
          backgroundColor: bg[variant],
          borderColor: variant === 'secondary' ? c.line : variant === 'ghost' ? c.line : 'transparent',
          borderWidth: variant === 'secondary' || variant === 'ghost' ? StyleSheet.hairlineWidth * 2 : 0,
          opacity: off && !loading ? 0.45 : pressed ? 0.86 : 1,
          transform: [{ scale: pressed ? 0.985 : 1 }],
          alignSelf: full ? 'stretch' : 'flex-start',
          paddingHorizontal: size === 'sm' ? space.md : space.xl,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg[variant]} />
      ) : (
        <View style={styles.row}>
          {icon ? <Icon name={icon} size={size === 'sm' ? 18 : 20} color={fg[variant]} /> : null}
          <Text variant="button" color={fg[variant]} numberOfLines={2} align="center" style={size === 'sm' ? { fontSize: 14 } : null}>
            {label}
          </Text>
          {iconRight ? <Icon name={iconRight} size={18} color={fg[variant]} /> : null}
        </View>
      )}
    </Pressable>
  );
}

export function IconButton({ name, label, onPress, tone = 'raised', size = 44, color, badge, testID }: { name: IconName; label: string; onPress?: () => void; tone?: 'raised' | 'plain' | 'accent' | 'glass'; size?: number; color?: string; badge?: number; testID?: string }) {
  const { c, shadow } = useTheme();
  const bg = tone === 'raised' ? c.surface : tone === 'accent' ? c.fill : tone === 'glass' ? (c.scheme === 'dark' ? 'rgba(15,30,34,0.92)' : 'rgba(255,255,255,0.94)') : 'transparent';
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => {
        haptic('selection');
        onPress?.();
      }}
      style={({ pressed }) => [
        { width: Math.max(size, touch.min), height: Math.max(size, touch.min), borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: bg, opacity: pressed ? 0.75 : 1 },
        tone === 'glass' || tone === 'raised' ? [shadow(1), { borderWidth: StyleSheet.hairlineWidth, borderColor: c.line }] : null,
      ]}
    >
      <Icon name={name} size={20} color={color ?? (tone === 'accent' ? c.on : c.text)} />
      {badge ? (
        <View style={[styles.badge, { backgroundColor: c.fill, borderColor: c.bg }]}>
          <Text variant="caption" color={c.on} style={{ fontSize: 10, lineHeight: 12 }}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm, justifyContent: 'center', flexShrink: 1 },
  badge: { position: 'absolute', top: 2, right: 2, minWidth: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', borderWidth: 2, paddingHorizontal: 3 },
});
