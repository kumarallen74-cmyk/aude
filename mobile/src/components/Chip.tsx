import { Pressable, StyleSheet } from 'react-native';
import { radius, space, touch, useTheme } from '@/theme';
import { haptic } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export function Chip({ label, selected, onPress, icon, count, testID, accessibilityLabel }: { label: string; selected?: boolean; onPress?: () => void; icon?: IconName; count?: number; testID?: string; accessibilityLabel?: string }) {
  const { c } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'togglebutton' : 'text'}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!selected, checked: !!selected }}
      onPress={() => {
        haptic('selection');
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? c.fill : c.surface,
          borderColor: selected ? c.fill : c.line,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      {icon ? <Icon name={icon} size={16} color={selected ? c.on : c.textMuted} /> : null}
      <Text variant="footnote" color={selected ? c.on : c.text} style={{ fontFamily: 'PlusJakartaSans_600SemiBold' }}>
        {label}
      </Text>
      {count ? (
        <Text variant="caption" color={selected ? c.on : c.accent}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { minHeight: touch.min - 6, flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingHorizontal: space.md + 2, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2 },
});
