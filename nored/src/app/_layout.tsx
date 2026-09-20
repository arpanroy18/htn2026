import { Buffer } from 'buffer';

import { setAudioModeAsync } from 'expo-audio';
import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AlertBanner } from '@/components/alert-banner';
import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { GameProvider } from '@/games/GameContext';
import { GameInvitePrompt } from '@/games/GameInvitePrompt';
import { AlertProvider } from '@/mesh/AlertContext';
import { RouterProvider } from '@/mesh/RouterContext';
import { ChatProvider } from '@/mesh/ChatContext';
import { MeshUiProvider } from '@/mesh/MeshUiContext';
import { signal } from '@/theme/signal';

// whisper.rn pulls in safe-buffer, which expects Node's Buffer global.
const globalScope = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
globalScope.Buffer = globalScope.Buffer ?? Buffer;

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
  // Without this, a received voice note plays silently whenever the iOS ringer
  // switch is off — the default session category respects the silent switch.
  useEffect(() => {
    void setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: 'mixWithOthers',
    }).catch(() => undefined);
  }, []);

  return (
    <ThemeProvider value={lightTheme}>
      <StatusBar style="dark" />
      <MeshUiProvider>
        <RouterProvider>
        <AlertProvider>
          <GameProvider>
            <ChatProvider>
              <AnimatedSplashOverlay />
              <GameInvitePrompt />
              <Stack
              screenOptions={{
                contentStyle: { backgroundColor: signal.paper },
                headerBackButtonDisplayMode: 'minimal',
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
              <AlertBanner />
            </ChatProvider>
          </GameProvider>
        </AlertProvider>
        </RouterProvider>
      </MeshUiProvider>
    </ThemeProvider>
  );
}
