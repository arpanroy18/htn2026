import * as ImagePicker from 'expo-image-picker';
import { Alert, Linking, Platform } from 'react-native';

export type PickedPhoto = { uri: string; width: number; height: number };

/**
 * iOS needs an explicit photo-library grant before the picker opens. Android's
 * photo picker asks for nothing — requesting there only invents a denial that
 * blocks a picker which would have worked.
 */
async function ensureIosPhotoAccess() {
  if (Platform.OS !== 'ios') return true;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (permission.granted || permission.accessPrivileges === 'limited') return true;
  Alert.alert(
    'Photos permission needed',
    'Allow photo access so Nored can send a picture over Bluetooth.',
    permission.canAskAgain
      ? undefined
      : [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open Settings', onPress: () => void Linking.openSettings() },
        ],
  );
  return false;
}

/** Resolves to `null` when the picker was dismissed or access was refused. */
export async function pickPhotoAsync(): Promise<PickedPhoto | null> {
  if (!(await ensureIosPhotoAccess())) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 1,
    selectionLimit: 1,
    exif: false,
    // HEIC/Live Photos have to be transcoded before the manipulator can read them.
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  });

  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new Error('That photo could not be read from your library.');
  return { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 };
}
