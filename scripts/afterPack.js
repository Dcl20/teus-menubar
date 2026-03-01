const { execSync } = require('child_process');
const path = require('path');

exports.default = async function(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`Cleaning xattrs for codesign: ${appPath}`);

  // Remove AppleDouble resource fork files
  execSync(`find "${appPath}" -name "._*" -delete 2>/dev/null || true`);
  execSync(`dot_clean "${appPath}" 2>/dev/null || true`);

  // Nuclear: recursively clear ALL extended attributes from the entire .app bundle
  execSync(`xattr -cr "${appPath}" 2>/dev/null || true`);

  // Second pass: target frameworks specifically
  const frameworksPath = path.join(appPath, 'Contents', 'Frameworks');
  execSync(`xattr -cr "${frameworksPath}" 2>/dev/null || true`);
  execSync(`find "${frameworksPath}" -name "._*" -delete 2>/dev/null || true`);
  execSync(`dot_clean "${frameworksPath}" 2>/dev/null || true`);

  // Third pass: individually clear xattrs on each file in frameworks
  execSync(`find "${frameworksPath}" -type f -exec xattr -c {} \\; 2>/dev/null || true`);

  // Fourth pass: specifically target the GPU helper that commonly fails
  const helpers = [
    'TEUS Quick Helper (GPU).app',
    'TEUS Quick Helper (Renderer).app',
    'TEUS Quick Helper (Plugin).app',
    'TEUS Quick Helper.app',
  ];
  for (const helper of helpers) {
    const helperPath = path.join(frameworksPath, helper);
    execSync(`xattr -cr "${helperPath}" 2>/dev/null || true`);
    execSync(`find "${helperPath}" -name "._*" -delete 2>/dev/null || true`);
  }

  // Verify
  const result = execSync(`xattr -lr "${frameworksPath}" 2>&1 | grep -v "com.apple.cs" | head -10 || true`).toString().trim();
  console.log('Non-codesign xattrs remaining:', result || 'NONE (clean)');
};
