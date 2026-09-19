import { Tabs } from 'expo-router';
import { Platform, StyleSheet } from 'react-native';

import { AlertsIcon, ChatsIcon, GamesIcon, NearbyIcon } from '@/components/signal/icons';
import { useAlerts } from '@/mesh/AlertContext';
import { useChat } from '@/mesh/ChatContext';
import { signal } from '@/theme/signal';

export default function TabsLayout() {
  const { totalUnread } = useChat();
  const { unreadCount } = useAlerts();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: signal.deep,
        tabBarInactiveTintColor: signal.slate,
        tabBarLabelStyle: styles.label,
        tabBarStyle: styles.bar,
        tabBarItemStyle: styles.item,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Nearby',
          tabBarIcon: ({ color }) => <NearbyIcon color={String(color)} size={24} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => <ChatsIcon color={String(color)} size={24} />,
          tabBarBadge:
            totalUnread > 0 ? (totalUnread > 99 ? '99+' : totalUnread) : undefined,
          tabBarBadgeStyle: styles.badge,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color }) => <AlertsIcon color={String(color)} size={22} />,
          tabBarBadge:
            unreadCount > 0 ? (unreadCount > 99 ? '99+' : unreadCount) : undefined,
          tabBarBadgeStyle: styles.badge,
        }}
      />
      <Tabs.Screen
        name="games"
        options={{
          title: 'Games',
          tabBarIcon: ({ color }) => <GamesIcon color={String(color)} size={22} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: signal.white,
    borderTopColor: signal.fog,
    borderTopWidth: 1,
    height: Platform.select({ ios: 84, default: 68 }),
    paddingBottom: Platform.select({ ios: 26, default: 8 }),
    paddingTop: 8,
  },
  item: {
    gap: 2,
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
  badge: {
    backgroundColor: signal.deep,
    color: signal.white,
    fontSize: 10,
    fontWeight: '800',
  },
});
