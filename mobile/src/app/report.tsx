import { useMutation } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ProblemCategory } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Screen, Section } from '@/components/Screen';
import { EmptyState, useErrorText } from '@/components/StateView';
import { brand } from '@/config';
import { ensureDevice } from '@/state/auth';
import { radius, space, useTheme } from '@/theme';

const CATEGORIES: ProblemCategory[] = ['broken', 'blocked', 'payment', 'cable', 'other'];

/** Report a problem ([§14 G9]); when the server has no endpoint yet, hand off to the operator's WhatsApp. */
export default function ReportScreen() {
  const p = useLocalSearchParams<{ connectorId?: string; partnerRef?: string; chargeId?: string; site?: string }>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const errText = useErrorText();
  const [cat, setCat] = useState<ProblemCategory | null>(null);
  const [comment, setComment] = useState('');
  const m = useMutation({
    mutationFn: async () => {
      await ensureDevice();
      return api.feedback.report({ connectorId: p.connectorId || undefined, partnerRef: p.partnerRef || p.chargeId || undefined, category: cat!, comment: comment.trim() || undefined });
    },
  });
  if (m.data === 'sent') {
    return (
      <Screen back modal>
        <EmptyState icon="check" title={t('report.thanks')} body={t('report.thanksBody')} action={t('common.close')} onAction={() => router.back()} testID="report-sent" />
      </Screen>
    );
  }
  const waText = encodeURIComponent(`${t('report.title')}: ${p.site ?? ''} — ${cat ? t(`report.cat.${cat}`) : ''}. ${comment}`);
  return (
    <Screen back modal title={t('report.title')} subtitle={p.site ? decodeURIComponent(p.site) : undefined} testID="report-screen"
      footer={<Button label={t('report.send')} disabled={!cat} loading={m.isPending} onPress={() => m.mutate()} testID="report-send" />}
    >
      {m.data === 'unsupported' ? (
        <Banner tone="info" title={t('report.viaWhatsapp')} action="WhatsApp" onPress={() => brand.support.whatsapp && void Linking.openURL(`https://wa.me/${brand.support.whatsapp.replace(/\D/g, '')}?text=${waText}`)} />
      ) : null}
      {m.error ? <Banner tone="danger" title={errText(m.error).title} body={errText(m.error).body} /> : null}
      <Section title={t('report.what')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {CATEGORIES.map((k) => (
            <Chip key={k} label={t(`report.cat.${k}`)} selected={cat === k} onPress={() => setCat(k)} testID={`cat-${k}`} />
          ))}
        </View>
      </Section>
      <Section title={t('report.details')}>
        <TextInput value={comment} onChangeText={(v) => setComment(v.slice(0, 500))} multiline placeholder={t('report.placeholder')} placeholderTextColor={c.textFaint} style={[styles.area, { color: c.text, borderColor: c.line, backgroundColor: c.surface }]} accessibilityLabel={t('report.details')} />
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({ area: { minHeight: 120, borderWidth: 1.5, borderRadius: radius.md, padding: space.md, fontSize: 16, fontFamily: 'PlusJakartaSans_500Medium', textAlignVertical: 'top' } });
