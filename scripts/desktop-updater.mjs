import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = {
  'windows-x64': ['windows-x86_64', '-setup.exe', 'nsis', /-setup\.exe$/],
  'windows-arm64': ['windows-aarch64', '-setup.exe', 'nsis', /-setup\.exe$/],
  'macos-x64': ['darwin-x86_64', '.app.tar.gz', 'macos', /\.app\.tar\.gz$/],
  'macos-arm64': ['darwin-aarch64', '.app.tar.gz', 'macos', /\.app\.tar\.gz$/],
};

function stableVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Expected a stable major.minor.patch version');
  }
  return version;
}

/** Copy Tauri's signed updater payload without changing the bytes it signed. */
export function collectUpdaterArtifacts(bundle, output, label, version) {
  stableVersion(version);
  if (label === 'linux-x64' || label === 'linux-arm64') return [];
  const target = targets[label];
  if (!target) throw new Error(`Unsupported desktop target: ${label}`);
  const [, suffix, format, pattern] = target;
  const directory = join(bundle, format);
  const names = readdirSync(directory).filter((name) => pattern.test(name));
  if (names.length !== 1) throw new Error(`Expected one signed updater payload for ${label}`);
  const name = names[0];
  const destination = `wrongstack-desktop-${version}-${label}${suffix}`;
  // Read both inputs before copying anything: unsigned builds must not look complete.
  readFileSync(join(directory, `${name}.sig`));
  copyFileSync(join(directory, name), join(output, destination));
  copyFileSync(join(directory, `${name}.sig`), join(output, `${destination}.sig`));
  return [destination, `${destination}.sig`];
}

/** Verify Tauri's Minisign envelope, including its authenticated version comment. */
export function verifyUpdaterSignature(payload, encodedSignature, encodedPublicKey, version) {
  stableVersion(version);
  const publicLines = Buffer.from(encodedPublicKey.trim(), 'base64')
    .toString('utf8')
    .trim()
    .split(/\r?\n/);
  const key = Buffer.from(publicLines[1] ?? '', 'base64');
  const lines = Buffer.from(encodedSignature.trim(), 'base64')
    .toString('utf8')
    .trim()
    .split(/\r?\n/);
  const signature = Buffer.from(lines[1] ?? '', 'base64');
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
  if (
    key.length !== 42 ||
    key.subarray(0, 2).toString() !== 'Ed' ||
    lines.length !== 4 ||
    !lines[2].startsWith('trusted comment: ') ||
    signature.length !== 74 ||
    signature.subarray(0, 2).toString() !== 'ED' ||
    globalSignature.length !== 64 ||
    !signature.subarray(2, 10).equals(key.subarray(2, 10))
  )
    throw new Error('Invalid updater signature or public key');
  const comment = lines[2].slice('trusted comment: '.length);
  const signedVersions = comment.split('\t').filter((part) => part.startsWith('version:'));
  if (signedVersions.length !== 1 || signedVersions[0] !== `version:${version}`) {
    throw new Error('Updater signature does not bind the announced version');
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der',
    type: 'spki',
  });
  const rawSignature = signature.subarray(10);
  if (
    !verify(null, createHash('blake2b512').update(payload).digest(), publicKey, rawSignature) ||
    !verify(null, Buffer.concat([rawSignature, Buffer.from(comment)]), publicKey, globalSignature)
  )
    throw new Error('Updater signature verification failed');
}

/** Publish only a complete four-platform update whose exact payloads verify. */
export function createUpdaterManifest(directory, version, repository, publicKey, date) {
  stableVersion(version);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  const platforms = {};
  for (const [label, [platform, suffix]] of Object.entries(targets)) {
    const name = `wrongstack-desktop-${version}-${label}${suffix}`;
    const signature = readFileSync(join(directory, `${name}.sig`), 'utf8').trim();
    verifyUpdaterSignature(readFileSync(join(directory, name)), signature, publicKey, version);
    platforms[platform] = {
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
      signature,
    };
  }
  return {
    version,
    notes: `https://github.com/${repository}/releases/tag/v${version}`,
    ...(date ? { pub_date: new Date(date).toISOString() } : {}),
    platforms,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, directory, outputOrVersion, labelOrRepository, version] = process.argv.slice(2);
  if (command === 'collect') {
    collectUpdaterArtifacts(directory, outputOrVersion, labelOrRepository, version);
  } else if (command === 'manifest') {
    const config = JSON.parse(
      readFileSync(
        new URL('../apps/desktop-v2/src-tauri/tauri.conf.json', import.meta.url),
        'utf8',
      ),
    );
    const manifest = createUpdaterManifest(
      directory,
      outputOrVersion,
      labelOrRepository,
      config.plugins.updater.pubkey,
    );
    writeFileSync(join(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log('Verified four signed desktop updater payloads; wrote latest.json.');
  } else {
    throw new Error(
      'Usage: desktop-updater.mjs collect <bundle> <output> <label> <version> | manifest <directory> <version> <owner/repo>',
    );
  }
}
