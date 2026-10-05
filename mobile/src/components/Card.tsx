import { Pressable, StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';
import { radius, space, useTheme } from '@/theme';
import { haptic } from './Button';

export function Card({ style, children, onPress, tone = 'surface', padded = true, accessibilityLabel, accessibilityHint, testID, ...rest }: ViewProps & { onPress?: () => void; tone?: 'surface' | 'raised' | 'accent' | 'sunken'; padded?: boolean; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const bg = tone === 'raised' ? c.raised : tone === 'accent' ? c.accentSoft : tone === 'sunken' ? c.sunken : c.surface;
  const base: StyleProp<ViewStyle> = [styles.card, { backgroundColor: bg, borderColor: tone === 'accent' ? c.accentSoft : c.line }, padded && styles.pad, style];
  if (!onPress)
    return (
      <View style={base} testID={testID} accessibilityLabel={accessibilityLabel} {...rest}>
        {children}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [base, pressed && { opacity: 0.85, transform: [{ scale: 0.995 }] }]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
  pad: { padding: space.lg },
});
