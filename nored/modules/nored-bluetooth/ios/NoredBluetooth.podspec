Pod::Spec.new do |s|
  s.name           = 'NoredBluetooth'
  s.version        = '1.0.0'
  s.summary        = 'Offline BLE transport for Nored'
  s.description    = 'CoreBluetooth transport used by Nored development builds.'
  s.author         = 'Nored'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
