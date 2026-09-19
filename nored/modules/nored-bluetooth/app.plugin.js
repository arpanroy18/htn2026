const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const permission = (name, attributes = {}) => ({
  $: { 'android:name': name, ...attributes },
});

function upsertPermission(manifest, value) {
  const permissions = manifest['uses-permission'] ?? [];
  const name = value.$['android:name'];
  manifest['uses-permission'] = [
    ...permissions.filter((item) => item.$?.['android:name'] !== name),
    value,
  ];
}

const withNoredBluetooth = (config) => {
  config = withInfoPlist(config, (result) => {
    result.modResults.NSBluetoothAlwaysUsageDescription =
      'Nored uses Bluetooth to discover nearby Nored users and exchange offline messages.';
    return result;
  });

  return withAndroidManifest(config, (result) => {
    const manifest = result.modResults.manifest;
    manifest.$ = { ...(manifest.$ ?? {}), 'xmlns:tools': 'http://schemas.android.com/tools' };
    upsertPermission(
      manifest,
      permission('android.permission.BLUETOOTH', { 'android:maxSdkVersion': '30' }),
    );
    upsertPermission(
      manifest,
      permission('android.permission.BLUETOOTH_ADMIN', { 'android:maxSdkVersion': '30' }),
    );
    upsertPermission(
      manifest,
      permission('android.permission.ACCESS_FINE_LOCATION', { 'android:maxSdkVersion': '30' }),
    );
    upsertPermission(
      manifest,
      permission('android.permission.BLUETOOTH_SCAN', {
        'android:usesPermissionFlags': 'neverForLocation',
      }),
    );
    upsertPermission(manifest, permission('android.permission.BLUETOOTH_CONNECT'));

    const features = manifest['uses-feature'] ?? [];
    manifest['uses-feature'] = [
      ...features.filter(
        (item) => item.$?.['android:name'] !== 'android.hardware.bluetooth_le',
      ),
      {
        $: {
          'android:name': 'android.hardware.bluetooth_le',
          'android:required': 'true',
        },
      },
    ];
    return result;
  });
};

module.exports = withNoredBluetooth;
