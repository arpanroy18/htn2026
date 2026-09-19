import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { MeshUiProvider } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

SplashScreen.preventAutoHideAsync();

const lightTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: signal.paper,
    card: signal.white,
    border: signal.fog,
    primary: signal.deep,
    text: signal.ink,
  },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={lightTheme}>
      <StatusBar style="dark" />
      <MeshUiProvider>
        <AnimatedSplashOverlay />
        <Stack
          screenOptions={{
            contentStyle: { backgroundColor: signal.paper },
            headerShadowVisible: false,
            headerTintColor: signal.deep,
            headerTitleStyle: { color: signal.ink, fontWeight: '600' },
            headerStyle: { backgroundColor: signal.paper },
          }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
          <Stack.Screen name="new-group" options={{ title: 'New group', presentation: 'modal' }} />
          <Stack.Screen name="compose-alert" options={{ title: 'Broadcast', presentation: 'modal' }} />
          <Stack.Screen name="settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="onboarding" options={{ title: 'Permissions' }} />
          <Stack.Screen name="game/[id]" options={{ title: 'Game' }} />
          <Stack.Screen name="invite" options={{ title: 'Invite to group', presentation: 'modal' }} />
        </Stack>
      </MeshUiProvider>
    </ThemeProvider>
  );
}
