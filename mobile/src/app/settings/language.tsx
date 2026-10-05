import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { AppLocale } from '../../../brands/brand';
import { ListGroup, ListRow } from '@/components/ListRow';
import { Screen } from '@/components/Screen';
import { Text } from '@/components/Text';
import { SUPPORTED } from '@/i18n';
import { settingsStore, useSettings } from '@/state/settings';
import { useTheme } from '@/theme';
import { Icon } from '@/components/Icon';

const NAMES: Record<AppLocale, string> = { en: 'English', id: 'Bahasa Indonesia', ms: 'Bahasa Melayu', zh: '简体中文' };

export default function LanguageScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const lang = useSettings((s) => s.language);
  const options: ('system' | AppLocale)[] = ['system', ...SUPPORTED];
  return (
    <Screen back title={t('settings.language')}>
      <ListGroup>
        {options.map((o, i) => (
          <ListRow
            key={o}
            label={o === 'system' ? t('settings.system') : NAMES[o]}
            detail={o === 'ms' || o === 'zh' ? t('settings.preview') : undefined}
            right={lang === o ? <Icon name="check" color={c.accent} /> : undefined}
            onPress={() => {
              settingsStore.set({ language: o });
              router.back();
            }}
            last={i === options.length - 1}
          />
        ))}
      </ListGroup>
      <Text variant="footnote" tone="muted">
        {t('settings.languageNote')}
      </Text>
    </Screen>
  );
}
