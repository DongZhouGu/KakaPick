const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

function deletePlistKey(plistPath, key) {
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath]);
  } catch {
    // Electron templates vary by version; missing optional keys are fine.
  }
}

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const plistPath = join(appPath, "Contents", "Info.plist");
  for (const key of [
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSAppTransportSecurity:NSAllowsArbitraryLoads",
  ]) {
    deletePlistKey(plistPath, key);
  }
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
