Pod::Spec.new do |s|
  s.name           = 'PlugSureLiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'ActivityKit bridge for the PlugSure charging Live Activity'
  s.author         = 'PlugSure'
  s.homepage       = 'https://plugsure.asia'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '16.4' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
