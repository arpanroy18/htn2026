import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { Text, View } from 'react-native';
import { meshTransport } from '@/transport';
import { MeshRouter } from './MeshRouter';
import { RouterStore } from './routerStore';
import { createPersistence, loadLegacyHistory } from './persistence';
import { importHistory } from './migration';

const Context = createContext<MeshRouter | null>(null);
let instance: Promise<MeshRouter> | undefined;
function initialize() {
  if (!instance) instance = (async () => {
    const store = new RouterStore(await createPersistence());
    await store.init();
    if (!store.data.imported) await importHistory(store, await loadLegacyHistory());
    return new MeshRouter(store, meshTransport);
  })().catch((error) => { instance = undefined; throw error; });
  return instance;
}
export function RouterProvider({ children }: { children: ReactNode }) {
  const [router, setRouter] = useState<MeshRouter>();
  const [error, setError] = useState<string>();
  useEffect(() => { if (error) SplashScreen.hide(); }, [error]);
  useEffect(() => {
    let cancelled = false;
    let current: MeshRouter | undefined;
    void initialize().then(async (value) => {
      if (cancelled) return;
      current = value;
      await value.start();
      if (!cancelled) setRouter(value);
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Storage failed.'));
    return () => { cancelled = true; current?.stop(); };
  }, []);
  if (!router) return <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}><Text>{error ? `Could not open message storage: ${error}` : 'Opening messages…'}</Text></View>;
  return <Context.Provider value={router}>{children}</Context.Provider>;
}
export function useRouterService() {
  const value = useContext(Context);
  if (!value) throw new Error('RouterProvider is required.');
  return value;
}
export function useRouterData() {
  const router = useRouterService();
  return useSyncExternalStore((callback) => router.store.subscribe(callback), () => router.store.data, () => router.store.data);
}
