import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/StateView';

export default function NotFound() {
  const { t } = useTranslation();
  return (
    <Screen back>
      <EmptyState icon="pin" title={t('notFound.title')} body={t('notFound.body')} action={t('notFound.action')} onAction={() => router.replace('/')} />
    </Screen>
  );
}
