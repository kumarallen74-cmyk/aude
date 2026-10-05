import { useQuery } from '@tanstack/react-query';
import { Linking, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Screen, Section } from '@/components/Screen';
import { Text } from '@/components/Text';
import { liveActivitiesAvailable } from '@/native/liveSession';
import { permissionStatus, registerForPush } from '@/native/notifications';
import { settingsStore, useSettings, type NotificationCategory } from '@/state/settings';

const CATS: NotificationCategory[] = ['charging', 'payments', 'reservations', 'account', 'promotions'];

/** Per-category notification settings (spec §6.10, §12.1); promotions are opt-in with separate consent. */
export default function NotificationSettings() {
  const { t, i18n } = useTranslation();
  const prefs = useSettings((s) => s.notifications);
  const perm = useQuery({ queryKey: ['pushPermission'], queryFn: permissionStatus });
  return (
    <Screen back title={t('settings.notifications')}>
      {Platform.OS === 'web' ? (
        <Banner tone="neutral" title={t('push.webUnsupported')} />
      ) : perm.data === 'denied' ? (
        <Banner tone="warning" icon="bell" title={t('push.deniedTitle')} body={t('push.deniedBody')} action={t('scan.openSettings')} onPress={() => void Linking.openSettings()} />
      ) : perm.data === 'undetermined' ? (
        <Button label={t('push.enable')} icon="bell" onPress={() => void registerForPush(i18n.language).then(() => perm.refetch())} />
      ) : null}
      <Section>
        <ListGroup>
          {CATS.map((k, i) => (
            <ListRow key={k} label={t(`push.cat.${k}`)} detail={t(`push.catDetail.${k}`)} toggle={prefs[k]} onToggle={(v) => settingsStore.set({ notifications: { ...prefs, [k]: v } })} last={i === CATS.length - 1} />
          ))}
        </ListGroup>
      </Section>
      <Text variant="footnote" tone="muted">
        {Platform.OS === 'ios' ? (liveActivitiesAvailable() ? t('push.liveActivityOn') : t('push.liveActivityOff')) : t('push.ongoingNote')}
      </Text>
    </Screen>
  );
}
