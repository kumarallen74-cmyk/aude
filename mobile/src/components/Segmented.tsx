import { Pressable, StyleSheet, View } from 'react-native';
import { radius, space, touch, useTheme } from '@/theme';
import { haptic } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export function Segmented<T extends string>({ value, options, onChange, testID }: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (v: T) => void; testID?: string }) {
  const { c } = useTheme();
  return (
    <View testID={testID} accessibilityRole="tablist" style={[styles.wrap, { backgroundColor: c.raised, borderColor: c.line }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={o.label}
            onPress={() => {
              haptic('selection');
              onChange(o.value);
            }}
            style={[styles.item, on && { backgroundColor: c.surface, boxShadow: '0px 1px 4px rgba(0,0,0,0.15)' }]}
          >
            {o.icon ? <Icon name={o.icon} size={16} color={on ? c.accent : c.textMuted} /> : null}
            <Text variant="footnote" color={on ? c.text : c.textMuted} style={{ fontFamily: 'PlusJakartaSans_700Bold' }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', padding: 3, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth * 2 },
  item: { flex: 1, minHeight: touch.min - 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs + 2, borderRadius: radius.pill, paddingHorizontal: space.md },
});
