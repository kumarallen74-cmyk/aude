import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { space, useTheme } from '@/theme';
import { IconButton } from './Button';
import { Text } from './Text';

/** A screen: safe areas, themed background, optional large title and back button, scroll + pull to refresh. */
export function Screen({
  title,
  subtitle,
  back,
  right,
  children,
  scroll = true,
  refreshing,
  onRefresh,
  footer,
  contentStyle,
  testID,
  modal,
}: {
  title?: string;
  subtitle?: string;
  back?: boolean | (() => void);
  right?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  modal?: boolean;
}) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const goBack = typeof back === 'function' ? back : () => (router.canGoBack() ? router.back() : router.replace('/'));
  const header =
    title || back || right ? (
      <View style={[styles.header, { paddingTop: modal ? space.lg : insets.top + space.sm }]}>
        <View style={styles.headerRow}>
          {back ? <IconButton name={modal ? 'close' : 'back'} label={modal ? t('common.close') : t('common.back')} onPress={goBack} tone="raised" testID="header-back" /> : <View />}
          <View style={{ flexDirection: 'row', gap: space.sm }}>{right}</View>
        </View>
        {title ? (
          <View style={{ marginTop: back || right ? space.md : 0, gap: 2 }}>
            <Text variant="title1" accessibilityRole="header">
              {title}
            </Text>
            {subtitle ? <Text tone="muted" variant="callout">{subtitle}</Text> : null}
          </View>
        ) : null}
      </View>
    ) : (
      <View style={{ height: insets.top }} />
    );
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.content, { paddingBottom: (footer ? space.lg : insets.bottom + space.xxxl) }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.accent} colors={[c.accent]} /> : undefined}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
  );
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]} testID={testID}>
      {header}
      {body}
      {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + space.md, borderTopColor: c.line, backgroundColor: c.bg }]}>{footer}</View> : null}
    </View>
  );
}

export function Section({ title, action, children, style }: { title?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: space.md }, style]}>
      {title || action ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          {title ? (
            <Text variant="overline" tone="muted" accessibilityRole="header">
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: space.lg, paddingBottom: space.md },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  content: { paddingHorizontal: space.lg, gap: space.xl, paddingTop: space.sm },
  footer: { paddingHorizontal: space.lg, paddingTop: space.md, borderTopWidth: StyleSheet.hairlineWidth, gap: space.sm },
});
