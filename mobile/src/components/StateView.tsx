import { Linking, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/api/http';
import { brand } from '@/config';
import { space, useTheme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

/** Human sentence for any error: network vs server vs business (spec §6). The server's own sentence wins for business errors. */
export function useErrorText() {
  const { t } = useTranslation();
  return (e: unknown): { title: string; body: string; icon: IconName } => {
    if (e instanceof ApiError) {
      switch (e.kind) {
        case 'offline':
          return { title: t('error.offline.title'), body: t('error.offline.body'), icon: 'offline' };
        case 'timeout':
          return { title: t('error.timeout.title'), body: t('error.timeout.body'), icon: 'clock' };
        case 'server':
          return { title: t('error.server.title'), body: t('error.server.body'), icon: 'alert' };
        case 'rate_limited':
          return { title: t('error.rateLimited.title'), body: e.message || t('error.rateLimited.body'), icon: 'clock' };
        case 'not_found':
          return { title: t('error.notFound.title'), body: e.message && e.message !== 'not_found' ? e.message : t('error.notFound.body'), icon: 'search' };
        case 'auth':
          return { title: t('error.auth.title'), body: e.message || t('error.auth.body'), icon: 'lock' };
        default:
          return { title: t('error.business.title'), body: e.message || t('error.server.body'), icon: 'alert' };
      }
    }
    return { title: t('error.server.title'), body: t('error.server.body'), icon: 'alert' };
  };
}

export function ErrorState({ error, onRetry, compact, testID }: { error: unknown; onRetry?: () => void; compact?: boolean; testID?: string }) {
  const { c } = useTheme();
  const { t } = useTranslation();
  const text = useErrorText()(error);
  return (
    <View testID={testID ?? 'error-state'} accessibilityRole="alert" style={{ alignItems: 'center', gap: space.md, paddingVertical: compact ? space.lg : space.xxxl, paddingHorizontal: space.lg }}>
      <View style={{ width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: c.dangerSoft }}>
        <Icon name={text.icon} size={28} color={c.danger} />
      </View>
      <Text variant="title3" align="center">
        {text.title}
      </Text>
      <Text tone="muted" align="center">
        {text.body}
      </Text>
      <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
        {onRetry ? <Button label={t('common.retry')} icon="refresh" onPress={onRetry} size="md" full={false} /> : null}
        {!compact && brand.support.whatsapp ? (
          <Button label={t('common.contactSupport')} variant="ghost" size="md" full={false} onPress={() => void Linking.openURL(`https://wa.me/${brand.support.whatsapp!.replace(/\D/g, '')}`)} />
        ) : null}
      </View>
    </View>
  );
}

export function EmptyState({ icon = 'search', title, body, action, onAction, testID }: { icon?: IconName; title: string; body?: string; action?: string; onAction?: () => void; testID?: string }) {
  const { c } = useTheme();
  return (
    <View testID={testID} style={{ alignItems: 'center', gap: space.md, paddingVertical: space.xxl, paddingHorizontal: space.lg }}>
      <View style={{ width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: c.accentSoft }}>
        <Icon name={icon} size={30} color={c.accent} />
      </View>
      <Text variant="title3" align="center">
        {title}
      </Text>
      {body ? (
        <Text tone="muted" align="center">
          {body}
        </Text>
      ) : null}
      {action && onAction ? <Button label={action} onPress={onAction} variant="secondary" size="md" full={false} style={{ alignSelf: 'center' }} /> : null}
    </View>
  );
}
