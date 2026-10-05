import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius, space, useTheme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface Choice {
  key: string;
  label: string;
  detail?: string;
  icon?: IconName;
  danger?: boolean;
}

/** A small bottom sheet of choices (directions app, confirm stop, …) that works the same on iOS, Android and web. */
export function ChoiceSheet({ visible, title, body, choices, onPick, onClose, cancelLabel }: { visible: boolean; title: string; body?: string; choices: Choice[]; onPick: (key: string) => void; onClose: () => void; cancelLabel: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]} onPress={onClose} accessibilityLabel={cancelLabel} />
      <View style={[styles.sheet, { backgroundColor: c.surface, paddingBottom: insets.bottom + space.lg, borderColor: c.line }]} accessibilityViewIsModal>
        <View style={[styles.handle, { backgroundColor: c.lineStrong }]} />
        <Text variant="title2" accessibilityRole="header">
          {title}
        </Text>
        {body ? <Text tone="muted">{body}</Text> : null}
        <View style={{ gap: space.sm, marginTop: space.sm }}>
          {choices.map((ch) =>
            ch.danger ? (
              <Button key={ch.key} label={ch.label} variant="danger" icon={ch.icon} onPress={() => onPick(ch.key)} testID={`choice-${ch.key}`} />
            ) : (
              <Pressable key={ch.key} testID={`choice-${ch.key}`} accessibilityRole="button" accessibilityLabel={ch.label} onPress={() => onPick(ch.key)} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.raised : c.bg, borderColor: c.line }]}>
                {ch.icon ? <Icon name={ch.icon} size={20} color={c.accent} /> : null}
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{ch.label}</Text>
                  {ch.detail ? <Text variant="footnote" tone="muted">{ch.detail}</Text> : null}
                </View>
                <Icon name="chevron" size={18} color={c.textFaint} />
              </Pressable>
            ),
          )}
          <Button label={cancelLabel} variant="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.xl, paddingTop: space.md, gap: space.sm, borderWidth: StyleSheet.hairlineWidth },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, marginBottom: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 56, paddingHorizontal: space.lg, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth * 2 },
});
