import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Screen } from '@/components/Screen';
import { settingsStore, useSettings, type ThemePref } from '@/state/settings';
import { useTheme } from '@/theme';

export default function AppearanceScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const theme = useSettings((s) => s.theme);
  const opts: ThemePref[] = ['system', 'light', 'dark'];
  return (
    <Screen back title={t('settings.appearance')}>
      <ListGroup>
        {opts.map((o, i) => (
          <ListRow key={o} icon={o === 'light' ? 'sun' : o === 'dark' ? 'moon' : 'settings'} label={t(`settings.theme.${o}`)} right={theme === o ? <Icon name="check" color={c.accent} /> : undefined} onPress={() => settingsStore.set({ theme: o })} last={i === opts.length - 1} />
        ))}
      </ListGroup>
    </Screen>
  );
}
