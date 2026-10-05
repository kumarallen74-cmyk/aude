import { useMutation, useQuery } from '@tanstack/react-query';
import * as Print from 'expo-print';
import { useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { Platform, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { HostedReceipt, RoamingReceipt } from '@/api/types';
import { Banner } from '@/components/Banner';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { Screen, Section } from '@/components/Screen';
import { SkeletonList } from '@/components/Skeleton';
import { ErrorState, useErrorText } from '@/components/StateView';
import { Text } from '@/components/Text';
import { formatDateTime, formatDuration, formatKwh } from '@/lib/format';
import { UnpaidPay, type UnpaidOptions } from '@/features/UnpaidPay';
import { formatMoney } from '@/lib/money';
import { receiptLineLabel } from '@/lib/receiptLines';
import { qk } from '@/state/queryClient';
import { space, useTheme } from '@/theme';

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <View style={styles.row} accessible accessibilityLabel={`${label}: ${value}`}>
      <Text variant={strong ? 'bodyStrong' : 'callout'} tone={muted ? 'muted' : 'default'} style={{ flex: 1 }}>
        {label}
      </Text>
      <Text variant={strong ? 'title3' : 'callout'} style={strong ? { fontFamily: 'Sora_700Bold' } : { fontFamily: 'PlusJakartaSans_600SemiBold' }}>
        {value}
      </Text>
    </View>
  );
}

/** Receipt with tax lines per country (PPN / PBJT-TL, GST, SST), PDF share (spec §6.8, MVP 12). */
export default function ReceiptScreen() {
  const { kind, id } = useLocalSearchParams<{ kind: 'charge' | 'roaming'; id: string }>();
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { c } = useTheme();
  const errText = useErrorText();
  const q = useQuery({
    queryKey: qk.receipt(kind!, id!),
    queryFn: (): Promise<HostedReceipt | RoamingReceipt> => (kind === 'roaming' ? api.roaming.receipt(id!) : api.charge.receipt(id!)),
  });

  const pdf = useMutation({
    mutationFn: async () => {
      const html = kind === 'roaming' ? roamingHtml(q.data as RoamingReceipt, lang) : await api.charge.receiptHtml(id!);
      if (Platform.OS === 'web') {
        const w = window.open('', '_blank');
        w?.document.write(html);
        w?.print();
        return;
      }
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: t('receipt.share') });
    },
  });

  if (q.isLoading) return <Screen back title={t('receipt.title')}><SkeletonList rows={4} /></Screen>;
  if (q.error || !q.data) return <Screen back title={t('receipt.title')}><ErrorState error={q.error} onRetry={() => void q.refetch()} /></Screen>;

  return (
    <Screen
      back
      title={t('receipt.title')}
      testID="receipt-screen"
      footer={
        <View style={{ gap: space.sm }}>
          {pdf.error ? <Banner tone="danger" title={errText(pdf.error).title} /> : null}
          <Button label={t('receipt.share')} icon="share" loading={pdf.isPending} onPress={() => pdf.mutate()} testID="share-pdf" />
        </View>
      }
    >
      {kind === 'roaming' ? <Roaming r={q.data as RoamingReceipt} lang={lang} /> : <Hosted r={q.data as HostedReceipt} lang={lang} />}
      <Text variant="caption" tone="faint" align="center">
        {t('receipt.keep')}
      </Text>
      <View style={{ height: 1, backgroundColor: c.line }} />
    </Screen>
  );
}

/** What this session still owes (an expired card hold, a failed post-pay charge) and how it can be paid. */
export function unpaidOf(r: HostedReceipt): { owedMinor: number; options: UnpaidOptions | null } | null {
  const s = r.settlement as {
    hold?: { expired?: boolean; unpaidMinor?: number; payOptions?: UnpaidOptions | null };
    postpay?: { unpaid?: boolean; chargedMinor?: number; payOptions?: UnpaidOptions | null };
  } | null;
  if (s?.hold?.expired && (s.hold.unpaidMinor ?? 0) > 0) return { owedMinor: s.hold.unpaidMinor!, options: s.hold.payOptions ?? null };
  if (s?.postpay?.unpaid && s.postpay.payOptions && (s.postpay.chargedMinor ?? 0) > 0) return { owedMinor: s.postpay.chargedMinor!, options: s.postpay.payOptions };
  return null;
}

function Hosted({ r, lang }: { r: HostedReceipt; lang: string }) {
  const { t } = useTranslation();
  const cur = r.currency;
  const m = (v: number | null | undefined) => formatMoney(v ?? 0, cur, lang);
  const refund = (r.settlement as { refundMinor?: number } | null)?.refundMinor;
  const due = unpaidOf(r);
  return (
    <>
      {due ? <UnpaidPay chargeId={r.chargeId} siteName={r.station.name} owedMinor={due.owedMinor} currency={cur} options={due.options} /> : null}
      <Card style={{ gap: space.xs }}>
        <Text variant="overline" tone="muted">
          {r.receiptNo}
        </Text>
        <Text variant="display">{r.tax ? m(r.tax.totalMinor) : '—'}</Text>
        <Text tone="muted">{formatDateTime(r.endedAt ?? r.startedAt, lang, { dateStyle: 'medium', timeStyle: 'short' } as Intl.DateTimeFormatOptions, r.timezone)}</Text>
        {!r.rated ? <Banner tone="info" title={t('receipt.pending')} /> : null}
      </Card>
      <Section title={t('receipt.session')}>
        <Card>
          <Row label={t('receipt.station')} value={r.station.name} />
          <Row label={t('receipt.operator')} value={r.station.operator} />
          <Row label={t('receipt.connector')} value={r.connector} />
          <Row label={t('receipt.energy')} value={formatKwh(r.energyKwh, lang)} />
          <Row label={t('receipt.duration')} value={formatDuration(r.durationMin, lang)} />
          {r.idleMinutes ? <Row label={t('receipt.idle')} value={formatDuration(r.idleMinutes, lang)} /> : null}
        </Card>
      </Section>
      <Section title={t('receipt.charges')}>
        <Card>
          {r.lines.map((l, i) => (
            <Row key={`${l.key ?? l.kind ?? l.label}-${i}`} label={receiptLineLabel(l, t)} value={m(l.amountMinor)} />
          ))}
          {r.tax ? (
            <>
              <View style={styles.sep} />
              <Row label={t('receipt.subtotal')} value={m(r.tax.subtotalMinor)} muted />
              {r.tax.localTaxMinor ? <Row label={t('receipt.localTax', { pct: r.tax.localTaxRateBps / 100 })} value={m(r.tax.localTaxMinor)} muted /> : null}
              {r.countryCode === 'ID' && r.tax.ppnEffectiveRateBps > 0 ? (
                <>
                  <Row label={t('receipt.dpp', { fraction: r.tax.dppFraction })} value={m(r.tax.taxBaseMinor)} muted />
                  <Row label={t('receipt.ppn', { pct: r.tax.ppnRateBps / 100 })} value={m(r.tax.taxMinor)} muted />
                </>
              ) : r.tax.taxMinor ? (
                <Row label={r.countryCode === 'SG' ? t('receipt.gst') : t('receipt.sst')} value={m(r.tax.taxMinor)} muted />
              ) : r.pricesIncludeTax ? (
                <Row label={t(r.countryCode === 'SG' ? 'price.tax.gst.incl' : 'price.tax.sst.incl')} value="✓" muted />
              ) : null}
              <View style={styles.sep} />
              <Row label={t('receipt.total')} value={m(r.tax.totalMinor)} strong />
            </>
          ) : null}
        </Card>
      </Section>
      {r.prepaidAmountMinor ? (
        <Section title={t('receipt.payment')}>
          <Card>
            <Row label={t('receipt.paid')} value={m(r.prepaidAmountMinor)} />
            {refund ? <Row label={t('receipt.refund')} value={m(refund)} /> : null}
          </Card>
        </Section>
      ) : null}
      {r.loyalty ? <Banner tone="success" icon="star" title={t('receipt.points', { points: r.loyalty.earnedPoints })} /> : null}
      <Card tone="sunken">
        {r.station.operatorNpwp ? <Row label="NPWP" value={r.station.operatorNpwp} muted /> : null}
        {r.station.taxRegistration ? <Row label={r.station.taxRegistration.label} value={r.station.taxRegistration.number} muted /> : null}
        {r.station.address ? <Text variant="caption" tone="faint">{r.station.address}</Text> : null}
      </Card>
    </>
  );
}

function Roaming({ r, lang }: { r: RoamingReceipt; lang: string }) {
  const { t } = useTranslation();
  const m = (v: number | null | undefined) => formatMoney(v ?? 0, r.currency, lang);
  return (
    <>
      <Card style={{ gap: space.xs }}>
        <Text variant="overline" tone="muted">
          {r.reference} · {r.party}
        </Text>
        <Text variant="display">{m(r.totalInclVatMinor ?? r.totalExclVatMinor)}</Text>
        <Text tone="muted">{formatDateTime(r.endedAt, lang)}</Text>
      </Card>
      <Section title={t('receipt.session')}>
        <Card>
          <Row label={t('receipt.station')} value={r.siteName} />
          <Row label={t('receipt.operator')} value={r.operator} />
          {r.evseId ? <Row label={t('receipt.connector')} value={r.evseId} /> : null}
          <Row label={t('receipt.energy')} value={formatKwh(r.energyKwh, lang)} />
          <Row label={t('receipt.duration')} value={formatDuration(r.durationMin, lang)} />
        </Card>
      </Section>
      <Section title={t('receipt.charges')}>
        <Card>
          {r.lines.map((l, i) => (
            <Row key={i} label={l.label} value={m(l.amountMinor)} />
          ))}
          <View style={styles.sep} />
          <Row label={t('receipt.exclVat')} value={m(r.totalExclVatMinor)} muted />
          <Row label={t('receipt.total')} value={m(r.totalInclVatMinor ?? r.totalExclVatMinor)} strong />
        </Card>
      </Section>
      {r.hold ? (
        <Section title={t('receipt.payment')}>
          <Card>
            <Row label={t('receipt.held')} value={formatMoney(r.hold.amountMinor, r.hold.currency, lang)} />
            {r.hold.capturedMinor != null ? <Row label={t('receipt.captured')} value={formatMoney(r.hold.capturedMinor, r.hold.currency, lang)} /> : null}
            {r.hold.shortfallMinor ? <Row label={t('receipt.shortfall')} value={formatMoney(r.hold.shortfallMinor, r.hold.currency, lang)} /> : null}
          </Card>
        </Section>
      ) : null}
      <Text variant="footnote" tone="muted">
        {t('receipt.partnerNote', { operator: r.operator })}
      </Text>
    </>
  );
}

function roamingHtml(r: RoamingReceipt, lang: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  const m = (v: number | null | undefined) => esc(formatMoney(v ?? 0, r.currency, lang));
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:-apple-system,Roboto,sans-serif;padding:32px;color:#12211f}td{padding:6px 0}td:last-child{text-align:right}h1{font-size:20px}</style></head><body>
<h1>${esc(r.operator)} — ${esc(r.siteName)}</h1><p>${esc(r.reference)} · ${esc(r.party)}<br>${esc(formatDateTime(r.startedAt, lang))} – ${esc(formatDateTime(r.endedAt, lang))}</p>
<table width="100%">${r.lines.map((l) => `<tr><td>${esc(l.label)}</td><td>${m(l.amountMinor)}</td></tr>`).join('')}
<tr><td>Excl. VAT</td><td>${m(r.totalExclVatMinor)}</td></tr><tr><td><b>Total</b></td><td><b>${m(r.totalInclVatMinor ?? r.totalExclVatMinor)}</b></td></tr></table>
<p>${esc(formatKwh(r.energyKwh, lang))} · ${esc(formatDuration(r.durationMin, lang))}</p></body></html>`;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.xs + 2 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: '#88888855', marginVertical: space.sm },
});
