import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PaymentSetup } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Icon } from '@/components/Icon';
import { useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { payUnpaidSession } from '@/features/checkoutFlow';
import { buildPicks, DEFAULT_METHOD } from '@/features/paymentPicks';
import { formatMoney } from '@/lib/money';
import { radius, space, useTheme } from '@/theme';

export type UnpaidOptions = Pick<PaymentSetup, 'paymentMethods' | 'savedCards' | 'linkedWallets'>;

/** The method choices for paying an unpaid session: a sale for what is owed (never a new hold, never post-pay). */
export function unpaidPicks(o: UnpaidOptions, t: (k: string, x?: Record<string, unknown>) => string) {
  return buildPicks(
    { ok: true, paymentMethods: o.paymentMethods ?? [], savedCards: o.savedCards ?? [], linkedWallets: (o.linkedWallets ?? []).filter((w) => !w.postpay), cardHolds: false, canSaveCard: false, postpayBlocked: null } as never,
    t,
  ).map((p) => ({ ...p, detail: p.channel === 'CARD' ? undefined : p.detail, pay: { ...p.pay, saveCard: undefined } }));
}

/** "Pay what this session cost": on the receipt of an unpaid session (spec §6.9, contract §15.8 blockers). */
export function UnpaidPay({ chargeId, siteName, owedMinor, currency, options }: { chargeId: string; siteName: string; owedMinor: number; currency: string; options: UnpaidOptions | null }) {
  const { t, i18n } = useTranslation();
  const { c } = useTheme();
  const errText = useErrorText();
  const picks = useMemo(() => unpaidPicks(options ?? { paymentMethods: [], savedCards: [], linkedWallets: [] }, t), [options, t]);
  const [key, setKey] = useState<string | null>(null);
  const pick = picks.find((p) => p.key === key) ?? picks.find((p) => p.channel === DEFAULT_METHOD[currency]) ?? picks[0] ?? null;
  const pay = useMutation({ mutationFn: () => payUnpaidSession({ chargeId, siteName, pay: pick?.pay ?? {} }) });
  const amount = formatMoney(owedMinor, currency, i18n.language);
  return (
    <Card style={{ gap: space.md }} testID="unpaid-pay">
      <Banner tone="warning" icon="receipt" title={t('unpaid.title', { amount })} body={t('unpaid.body')} />
      {picks.length > 1 ? (
        <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
          {picks.map((p) => {
            const on = p.key === pick?.key;
            return (
              <Pressable
                key={p.key}
                testID={`unpaid-method-${p.key}`}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={p.label}
                onPress={() => setKey(p.key)}
                style={[styles.method, { borderColor: on ? c.fill : c.line, backgroundColor: on ? c.accentSoft : c.surface }]}
              >
                <Icon name={p.icon} size={18} color={on ? c.accent : c.textMuted} />
                <Text variant="bodyStrong" style={{ flex: 1 }}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {pay.error ? <Banner tone="danger" title={errText(pay.error).title} body={errText(pay.error).body} /> : null}
      {pay.data === true ? <Banner tone="success" title={t('unpaid.paid')} /> : null}
      <Button label={t('unpaid.pay', { amount })} icon="card" loading={pay.isPending} disabled={!pick || pay.data === true} onPress={() => pay.mutate()} testID="unpaid-pay-button" />
    </Card>
  );
}

const styles = StyleSheet.create({
  method: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, minHeight: 52 },
});
