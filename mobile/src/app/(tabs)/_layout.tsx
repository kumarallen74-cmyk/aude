import { Redirect, Tabs } from 'expo-router';
import { TabBar } from '@/features/TabBar';
import { useSettings } from '@/state/settings';

export default function TabsLayout() {
  const onboarded = useSettings((s) => s.onboarded);
  if (!onboarded) return <Redirect href="/onboarding" />;
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="account" />
    </Tabs>
  );
}
