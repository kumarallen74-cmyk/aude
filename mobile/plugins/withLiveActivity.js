/**
 * iOS Live Activity (ActivityKit) — config plugin.
 *
 *   - Info.plist: NSSupportsLiveActivities / NSSupportsLiveActivitiesFrequentUpdates;
 *   - copies the widget extension sources (plugins/live-activity/*.swift + Info.plist) to ios/ChargingWidgets/;
 *   - registers the "ChargingWidgets" widget-extension TARGET in the Xcode project (withXcodeProject): the native
 *     target (com.apple.product-type.app-extension), its Sources / Frameworks (WidgetKit, SwiftUI) / Resources phases,
 *     build settings (bundle id `<app id>.ChargingWidgets`, iOS 16.4, Swift 5, Info.plist, team, the app's version and
 *     build number), the "Embed Foundation Extensions" copy phase in the app target and the target dependency;
 *   - declares the extension to EAS (`extra.eas.build.experimental.ios.appExtensions`) so EAS Build creates its
 *     provisioning profile and syncs its version / build number with the app's (remote app versions).
 *
 * No App Group: nothing reads shared storage (the widget renders only the ActivityKit content state), so neither
 * target carries com.apple.security.application-groups (one fewer identifier to register per white-label brand).
 *
 * The JS↔ActivityKit bridge is the local Expo module `modules/live-activity` (autolinked), used by
 * src/native/liveSession.ts. The content-state keys are the backend wire contract (version 2, §15.7).
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'ChargingWidgets';
const SOURCES = ['ChargingAttributes.swift', 'ChargingLiveActivity.swift'];
/** Expo SDK 57 minimum (ExpoModulesCore.podspec); app.config.ts ios.deploymentTarget overrides it when higher. */
const MIN_DEPLOYMENT_TARGET = '16.4';

const unquote = (v) => (typeof v === 'string' ? v.replace(/^"(.*)"$/, '$1') : v);
const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;

function findTarget(project) {
  const targets = project.pbxNativeTargetSection();
  for (const [uuid, t] of Object.entries(targets)) {
    if (!uuid.endsWith('_comment') && t && typeof t === 'object' && unquote(t.name) === TARGET) return { uuid, pbxNativeTarget: t };
  }
  return null;
}

/**
 * Add the widget extension target to the Xcode project (once), then (always) apply its build settings.
 * Returns true when the target was created.
 */
function addWidgetTarget(project, { bundleId, teamId, version, buildNumber, deploymentTarget = MIN_DEPLOYMENT_TARGET, deviceFamily = '1' }) {
  let target = findTarget(project);
  const created = !target;
  if (!target) {
    // addTarget makes the app depend on the extension only when these sections exist (a fresh Expo project has none).
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
    target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.${TARGET}`);

    // Files: a group for the sources (paths relative to ios/).
    const group = project.addPbxGroup([...SOURCES, 'Info.plist'], TARGET, TARGET);
    const mainGroup = project.getFirstProject().firstProject.mainGroup;
    project.addToPbxGroup(group.uuid, mainGroup);

    project.addBuildPhase(SOURCES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase(['WidgetKit.framework', 'SwiftUI.framework'], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);

    // The copy phase addTarget created in the app target embeds the .appex into PlugIns (dstSubfolderSpec 13).
    const copyPhases = project.hash.project.objects.PBXCopyFilesBuildPhase || {};
    for (const [key, phase] of Object.entries(copyPhases)) {
      if (key.endsWith('_comment') || !phase || phase.name !== '"Copy Files"') continue;
      phase.name = '"Embed Foundation Extensions"';
      phase.dstSubfolderSpec = 13;
      copyPhases[`${key}_comment`] = 'Embed Foundation Extensions';
      for (const t of Object.values(project.pbxNativeTargetSection())) {
        for (const ref of (t && t.buildPhases) || []) if (ref.value === key) ref.comment = 'Embed Foundation Extensions';
      }
    }
  }

  const configs = project.pbxXCBuildConfigurationSection();
  const list = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList];
  for (const ref of list.buildConfigurations) {
    const cfg = configs[ref.value];
    delete cfg.buildSettings.CODE_SIGN_ENTITLEMENTS; // no entitlements (no App Group)
    Object.assign(cfg.buildSettings, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      PRODUCT_BUNDLE_IDENTIFIER: quote(`${bundleId}.${TARGET}`),
      PRODUCT_NAME: '"$(TARGET_NAME)"',
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: quote(deviceFamily),
      // The embedded extension must carry the app's CFBundleShortVersionString / CFBundleVersion (ITMS-90473). Its
      // Info.plist reads these settings; EAS Build (remote app versions) rewrites both Info.plists with the same values
      // because the extension is declared in extra.eas…appExtensions.
      MARKETING_VERSION: quote(version),
      CURRENT_PROJECT_VERSION: quote(buildNumber),
      GENERATE_INFOPLIST_FILE: 'NO',
      SKIP_INSTALL: 'YES',
      CODE_SIGN_STYLE: 'Automatic',
      ASSETCATALOG_COMPILER_WIDGET_BACKGROUND_COLOR_NAME: 'WidgetBackground',
      SWIFT_EMIT_LOC_STRINGS: 'YES',
      LD_RUNPATH_SEARCH_PATHS: '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"',
      ...(teamId ? { DEVELOPMENT_TEAM: teamId } : {}),
    });
  }
  // addTarget already made the app target depend on the extension (built first).
  return created;
}

/** Declare the extension to EAS Build (credentials / provisioning profile, version sync). Idempotent. */
function withEasAppExtension(config) {
  const bundleId = config.ios && config.ios.bundleIdentifier;
  if (!bundleId) return config;
  const extra = config.extra || {};
  const eas = extra.eas || {};
  const build = eas.build || {};
  const experimental = build.experimental || {};
  const ios = experimental.ios || {};
  const others = (ios.appExtensions || []).filter((e) => e && e.targetName !== TARGET);
  config.extra = {
    ...extra,
    eas: {
      ...eas,
      build: {
        ...build,
        experimental: {
          ...experimental,
          ios: {
            ...ios,
            appExtensions: [...others, { targetName: TARGET, bundleIdentifier: `${bundleId}.${TARGET}`, entitlements: {} }],
          },
        },
      },
    },
  };
  return config;
}

const versionAtLeast = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
};

function withLiveActivity(config, props = {}) {
  if (props.enabled === false) return config;

  config = withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    c.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return c;
  });

  config = withDangerousMod(config, [
    'ios',
    async (c) => {
      const src = path.join(c.modRequest.projectRoot, 'plugins', 'live-activity');
      const dest = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        if (/\.(swift|plist)$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
      }
      return c;
    },
  ]);

  if (props.registerTarget !== false) {
    config = withEasAppExtension(config);
    config = withXcodeProject(config, (c) => {
      const appTarget = (c.ios && c.ios.deploymentTarget) || MIN_DEPLOYMENT_TARGET;
      addWidgetTarget(c.modResults, {
        bundleId: c.ios && c.ios.bundleIdentifier,
        teamId: (c.ios && c.ios.appleTeamId) || props.teamId,
        version: c.version || '1.0.0',
        // Same source as the app's CFBundleVersion (expo's ios.buildNumber mod; default '1').
        buildNumber: (c.ios && c.ios.buildNumber) || '1',
        deploymentTarget: versionAtLeast(appTarget, MIN_DEPLOYMENT_TARGET) ? appTarget : MIN_DEPLOYMENT_TARGET,
        deviceFamily: c.ios && c.ios.supportsTablet ? '1,2' : '1',
      });
      return c;
    });
  }
  return config;
}

module.exports = withLiveActivity;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.withEasAppExtension = withEasAppExtension;
module.exports.MIN_DEPLOYMENT_TARGET = MIN_DEPLOYMENT_TARGET;
