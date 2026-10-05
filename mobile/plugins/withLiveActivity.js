/**
 * iOS Live Activity (ActivityKit) — config plugin.
 *
 *   - Info.plist: NSSupportsLiveActivities / NSSupportsLiveActivitiesFrequentUpdates;
 *   - entitlements: the App Group shared with the widget extension;
 *   - copies the widget extension sources (plugins/live-activity/*.swift + Info.plist) to ios/ChargingWidgets/;
 *   - registers the "ChargingWidgets" widget-extension TARGET in the Xcode project (withXcodeProject): the native
 *     target (com.apple.product-type.app-extension), its Sources / Frameworks (WidgetKit, SwiftUI) / Resources phases,
 *     build settings (bundle id `<app id>.ChargingWidgets`, iOS 16.2, Swift 5, Info.plist, entitlements, team),
 *     the "Embed Foundation Extensions" copy phase in the app target and the target dependency. Idempotent.
 *
 * The JS↔ActivityKit bridge is the local Expo module `modules/live-activity` (autolinked), used by
 * src/native/liveSession.ts. The content-state keys are the backend wire contract (version 2, §15.7).
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const TARGET = 'ChargingWidgets';
const SOURCES = ['ChargingAttributes.swift', 'ChargingLiveActivity.swift'];

/** Add the widget extension target to the Xcode project (no-op when it is already there). */
function addWidgetTarget(project, { bundleId, teamId, version, buildNumber, deploymentTarget = '16.2' }) {
  const targets = project.pbxNativeTargetSection();
  const exists = Object.values(targets).some((t) => t && typeof t === 'object' && String(t.name).replace(/"/g, '') === TARGET);
  if (exists) return false;

  // addTarget makes the app depend on the extension only when these sections exist (a fresh Expo project has none).
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
  const target = project.addTarget(TARGET, 'app_extension', TARGET, `${bundleId}.${TARGET}`);

  // Files: a group for the sources (paths relative to ios/).
  const group = project.addPbxGroup([...SOURCES, 'Info.plist', `${TARGET}.entitlements`], TARGET, TARGET);
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

  const configs = project.pbxXCBuildConfigurationSection();
  const listId = target.pbxNativeTarget.buildConfigurationList;
  const list = project.pbxXCConfigurationList()[listId];
  for (const ref of list.buildConfigurations) {
    const cfg = configs[ref.value];
    Object.assign(cfg.buildSettings, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      PRODUCT_BUNDLE_IDENTIFIER: `"${bundleId}.${TARGET}"`,
      PRODUCT_NAME: `"$(TARGET_NAME)"`,
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: '"1,2"',
      MARKETING_VERSION: version,
      CURRENT_PROJECT_VERSION: buildNumber,
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
  return true;
}

function withLiveActivity(config, props = {}) {
  if (props.enabled === false) return config;
  const appGroup = props.appGroup || `group.${config.ios && config.ios.bundleIdentifier}`;

  config = withInfoPlist(config, (c) => {
    c.modResults.NSSupportsLiveActivities = true;
    c.modResults.NSSupportsLiveActivitiesFrequentUpdates = true;
    return c;
  });

  config = withEntitlementsPlist(config, (c) => {
    const groups = new Set(c.modResults['com.apple.security.application-groups'] || []);
    groups.add(appGroup);
    c.modResults['com.apple.security.application-groups'] = [...groups];
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
      fs.writeFileSync(
        path.join(dest, `${TARGET}.entitlements`),
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>com.apple.security.application-groups</key>\n  <array><string>${appGroup}</string></array>\n</dict>\n</plist>\n`,
      );
      return c;
    },
  ]);

  if (props.registerTarget !== false) {
    config = withXcodeProject(config, (c) => {
      addWidgetTarget(c.modResults, {
        bundleId: c.ios && c.ios.bundleIdentifier,
        teamId: (c.ios && c.ios.appleTeamId) || props.teamId,
        version: c.version || '1.0.0',
        buildNumber: (c.ios && c.ios.buildNumber) || '1',
      });
      return c;
    });
  }
  return config;
}

module.exports = withLiveActivity;
module.exports.addWidgetTarget = addWidgetTarget;
