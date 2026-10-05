import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { radius, space, touch, useTheme } from '@/theme';
import { haptic } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export function ListGroup({ children }: { children: ReactNode }) {
  const { c } = useTheme();
  return <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.line }]}>{children}</View>;
}

export function ListRow({
  icon,
  label,
  detail,
  value,
  onPress,
  danger,
  toggle,
  onToggle,
  right,
  last,
  testID,
  external,
}: {
  icon?: IconName;
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  danger?: boolean;
  toggle?: boolean;
  onToggle?: (v: boolean) => void;
  right?: ReactNode;
  last?: boolean;
  testID?: string;
  external?: boolean;
}) {
  const { c } = useTheme();
  const color = danger ? c.danger : c.text;
  const body = (
    <View style={[styles.row, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line }]}>
      {icon ? (
        <View style={[styles.icon, { backgroundColor: danger ? c.dangerSoft : c.accentSoft }]}>
          <Icon name={icon} size={18} color={danger ? c.danger : c.accent} />
        </View>
      ) : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" color={color}>
          {label}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="muted">
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="callout" tone="muted" numberOfLines={1} style={{ maxWidth: '45%' }}>
          {value}
        </Text>
      ) : null}
      {right}
      {toggle !== undefined ? (
        <Switch
          value={toggle}
          onValueChange={(v) => {
            haptic('selection');
            onToggle?.(v);
          }}
          trackColor={{ true: c.fill, false: c.lineStrong }}
          thumbColor="#ffffff"
          accessibilityLabel={label}
        />
      ) : onPress ? (
        <Icon name={external ? 'external' : 'chevron'} size={18} color={c.textFaint} />
      ) : null}
    </View>
  );
  if (!onPress) return <View testID={testID}>{body}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={[label, value].filter(Boolean).join(', ')}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => ({ backgroundColor: pressed ? c.raised : 'transparent' })}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2, overflow: 'hidden' },
  row: { minHeight: touch.comfortable + 4, flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  icon: { width: 34, height: 34, borderRadius: radius.sm + 2, alignItems: 'center', justifyContent: 'center' },
});
