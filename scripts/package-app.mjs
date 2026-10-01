import { packager } from "@electron/packager";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");

export async function packageNoktus() {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const productName = packageJson.productName;
  const product = packageJson.noktus;
  if (
    typeof productName !== "string" ||
    !productName ||
    typeof product?.appId !== "string" ||
    typeof product?.executableName !== "string" ||
    typeof product?.category !== "string"
  ) {
    throw new Error("package.json is missing the Noktus product identity");
  }
  const electronVersion = packageJson.devDependencies?.electron;
  if (typeof electronVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
    throw new Error("package.json must pin an exact Electron version");
  }
  if (Object.keys(packageJson.dependencies || {}).length > 0) {
    throw new Error(
      "Runtime dependencies require an explicit packaged node_modules policy",
    );
  }
  if (Object.keys(packageJson.optionalDependencies || {}).length > 0) {
    throw new Error(
      "Optional dependencies require an explicit packaged node_modules policy",
    );
  }
  const iconDirectory = path.join(projectRoot, "resources", "icons");
  const iconPath =
    process.platform === "win32"
      ? path.join(iconDirectory, "noktus.ico")
      : process.platform === "darwin"
        ? path.join(iconDirectory, "noktus.icns")
        : undefined;

  return packager({
    dir: projectRoot,
    name: productName,
    executableName: product.executableName,
    appBundleId: product.appId,
    helperBundleId: `${product.appId}.helper`,
    appCategoryType: product.category,
    appCopyright: `Copyright (c) ${new Date().getUTCFullYear()} Noktus contributors`,
    icon: iconPath,
    win32metadata: {
      CompanyName: "Noktus contributors",
      FileDescription: productName,
      InternalName: product.executableName,
      OriginalFilename: `${product.executableName}.exe`,
      ProductName: productName,
    },
    out: path.join(projectRoot, "out"),
    overwrite: true,
    asar: true,
    prune: true,
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    // Re-sign after Packager changes the Electron bundle. Ad-hoc signing needs
    // no certificate, provisioning profile, hardened runtime, or timestamp.
    osxSign:
      process.platform === "darwin"
        ? {
            identity: "-",
            identityValidation: false,
            preAutoEntitlements: false,
            preEmbedProvisioningProfile: false,
            continueOnError: false,
            optionsForFile: () => ({
              hardenedRuntime: false,
              timestamp: "none",
            }),
          }
        : undefined,
    extraResource: [
      path.join(projectRoot, "resources", "icons"),
      path.join(projectRoot, "resources", "mpv"),
      path.join(projectRoot, "LICENSE"),
    ],
    // Electron Packager copies from the repository root. Keep this list
    // explicit for local-only material: .gitignore is not consulted here.
    ignore: [
      /[\\/]\.git(?:[\\/]|$)/,
      /[\\/]\.agents(?:[\\/]|$)/,
      /[\\/]\.github(?:[\\/]|$)/,
      /[\\/]\.uv-cache(?:[\\/]|$)/,
      /[\\/]\.vscode(?:[\\/]|$)/,
      /[\\/]\.venv(?:[\\/]|$)/,
      /[\\/]scraps(?:[\\/]|$)/,
      /[\\/]out(?:[\\/]|$)/,
      /[\\/]coverage(?:[\\/]|$)/,
      /[\\/]\.cache(?:[\\/]|$)/,
      /[\\/]__pycache__(?:[\\/]|$)/,
      /[\\/]node_modules(?:[\\/]|$)/,
      /[\\/]docs(?:[\\/]|$)/,
      /[\\/]scripts(?:[\\/]|$)/,
      /[\\/]test(?:[\\/]|$)/,
      /[\\/]resources(?:[\\/]|$)/,
      /[\\/]src[\\/](?:main|preload|shared)(?:[\\/]|$)/,
      /[\\/]build[\\/]preload(?:[\\/]|$)/,
      /\.map$/,
      /[\\/]\.env(?:\.[^\\/]+)?$/,
      /[\\/]\.npmrc$/,
      /[\\/](?:CHANGELOG\.md|LICENSE|README\.md|package-lock\.json|tsconfig\.json|\.gitignore|\.prettierignore|\.prettierrc)$/,
    ],
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const paths = await packageNoktus();
  for (const outputPath of paths) console.log(outputPath);
}
