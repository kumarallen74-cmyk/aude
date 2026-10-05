import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Button, haptic, IconButton } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Text } from '@/components/Text';
import { extractChargerCode } from '@/lib/deeplink';
import { radius, space, touch, useTheme } from '@/theme';

/** Scanner: camera viewfinder, torch, manual code entry; any URL or raw code (spec §6.11). */
export default function ScanScreen() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [perm, requestPerm] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [manual, setManual] = useState(Platform.OS === 'web');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const open = (raw: string) => {
    const k = extractChargerCode(raw);
    if (!k) {
      setError(t('scan.invalid'));
      handled.current = false;
      return;
    }
    haptic('success');
    router.replace(`/c/${encodeURIComponent(k)}`);
  };

  const onScan = (r: BarcodeScanningResult) => {
    if (handled.current) return;
    handled.current = true;
    open(r.data);
  };

  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const granted = perm?.granted;

  return (
    <View style={[styles.root, { backgroundColor: '#05090a' }]} testID="scan-screen">
      {granted && !manual ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} accessibilityLabel={t('scan.cameraA11y')} />
      ) : null}
      <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
        <IconButton name="close" label={t('common.close')} onPress={close} tone="glass" testID="scan-close" />
        {granted && !manual ? <IconButton name="torch" label={torch ? t('scan.torchOff') : t('scan.torchOn')} onPress={() => setTorch(!torch)} tone={torch ? 'accent' : 'glass'} /> : null}
      </View>

      {!manual ? (
        <View style={styles.center} pointerEvents="box-none">
          {granted ? (
            <>
              <View style={[styles.frame, { borderColor: c.fill }]} />
              <Text variant="bodyStrong" color="#ffffff" align="center" style={{ marginTop: space.xl }}>
                {t('scan.hint')}
              </Text>
            </>
          ) : perm && !perm.canAskAgain ? (
            <View style={styles.permCard}>
              <Icon name="camera" size={36} color="#fff" />
              <Text variant="title3" color="#fff" align="center">
                {t('scan.deniedTitle')}
              </Text>
              <Text color="#c9d6d3" align="center">
                {t('scan.deniedBody')}
              </Text>
              <Button label={t('scan.openSettings')} onPress={() => void Linking.openSettings()} />
            </View>
          ) : (
            <View style={styles.permCard}>
              <Icon name="scan" size={40} color={c.fill} />
              <Text variant="title3" color="#fff" align="center">
                {t('scan.permTitle')}
              </Text>
              <Text color="#c9d6d3" align="center">
                {t('scan.permBody')}
              </Text>
              <Button label={t('scan.allowCamera')} icon="camera" onPress={() => void requestPerm()} testID="allow-camera" />
            </View>
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }} />
      )}

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
        {manual ? (
          <View style={[styles.manual, { backgroundColor: c.surface }]}>
            <Text variant="title2">{t('scan.enterCode')}</Text>
            <Text variant="footnote" tone="muted">
              {t('scan.enterCodeHint')}
            </Text>
            <TextInput
              value={code}
              onChangeText={(v) => {
                setCode(v);
                setError(null);
              }}
              placeholder="ABC-123:1"
              placeholderTextColor={c.textFaint}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              returnKeyType="go"
              onSubmitEditing={() => open(code)}
              style={[styles.input, { color: c.text, borderColor: error ? c.danger : c.line, backgroundColor: c.bg }]}
              accessibilityLabel={t('scan.enterCode')}
              testID="code-input"
            />
            {error ? (
              <Text variant="footnote" tone="danger" accessibilityRole="alert">
                {error}
              </Text>
            ) : null}
            <Button label={t('scan.findCharger')} icon="search" onPress={() => open(code)} disabled={!code.trim()} testID="code-submit" />
            {Platform.OS !== 'web' ? <Button label={t('scan.useCamera')} variant="ghost" size="md" onPress={() => setManual(false)} /> : null}
          </View>
        ) : (
          <Button label={t('scan.enterCode')} variant="secondary" icon="keyboard" onPress={() => setManual(true)} testID="manual-entry" />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: space.lg, zIndex: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  frame: { width: 250, height: 250, borderRadius: radius.xl, borderWidth: 4 },
  permCard: { alignItems: 'center', gap: space.md, maxWidth: 340, width: '100%' },
  bottom: { paddingHorizontal: space.lg },
  manual: { padding: space.xl, borderRadius: radius.xl, gap: space.md },
  input: { minHeight: touch.comfortable + 4, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.lg, fontSize: 20, fontFamily: 'Sora_600SemiBold', letterSpacing: 1 },
});
