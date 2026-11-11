import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Execute the production NSIS hook on real Windows files. Record the actual Abort argument;
// its selection and the caller-register restore must stay in the production code path.
// This fixture has no registry writes, shortcuts, provider or running application engines.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = resolve(root, 'apps/desktop-v2');
const work = resolve(root, '.temp_files/desktop-v2-native', `installer-messages-${Date.now()}`);
const nsis = join(process.env.LOCALAPPDATA, 'tauri/NSIS');
const input =
  process.env.WRONGSTACK_DESKTOP_TEST_HOOK ?? join(app, 'src-tauri/windows/installer-hooks.nsh');
const original = await readFile(input, 'utf8');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const sourceHash = hash(original);
const hasCatalog = original.includes('LangString WrongStackEngineUnwritable');
const locales = [
  {
    code: 'en',
    id: 1033,
    file: 'English',
    text: 'The installed WrongStack engine cannot be replaced. Run this installer with the same rights that installed it.',
    held: 'still running',
  },
  {
    code: 'tr',
    id: 1055,
    file: 'Turkish',
    text: 'Kurulu WrongStack motoru değiştirilemiyor. Bu yükleyiciyi, motoru kurarken kullanılan yetkilerle çalıştırın.',
    held: 'hâlâ çalışıyor',
  },
  {
    code: 'de',
    id: 1031,
    file: 'German',
    text: 'Die installierte WrongStack-Engine kann nicht ersetzt werden. Führen Sie dieses Installationsprogramm mit denselben Rechten wie bei der Installation aus.',
    held: 'läuft noch',
  },
  {
    code: 'fr',
    id: 1036,
    file: 'French',
    text: "Le moteur WrongStack installé ne peut pas être remplacé. Exécutez ce programme d'installation avec les mêmes droits que lors de l'installation.",
    held: "en cours d'exécution",
  },
  {
    code: 'it',
    id: 1040,
    file: 'Italian',
    text: 'Il motore WrongStack installato non può essere sostituito. Esegui questo programma di installazione con gli stessi permessi usati per installarlo.',
    held: 'ancora in esecuzione',
  },
  {
    code: 'es',
    id: 1034,
    file: 'Spanish',
    text: 'No se puede reemplazar el motor de WrongStack instalado. Ejecuta este instalador con los mismos permisos usados durante la instalación.',
    held: 'sigue en ejecución',
  },
  {
    code: 'pt-BR',
    id: 1046,
    file: 'PortugueseBR',
    text: 'Não é possível substituir o mecanismo do WrongStack instalado. Execute este instalador com as mesmas permissões usadas na instalação.',
    held: 'ainda está em execução',
  },
];
await mkdir(join(work, 'fixture'), { recursive: true });
const hook = join(work, 'observed-hooks.nsh');
await writeFile(
  hook,
  original.replace(
    /^(\s*)Abort ("[^\r\n]*")\r?$/gm,
    (line, indent, argument) =>
      `${indent}FileOpen $9 "$EXEDIR\\message.txt" w\n${indent}FileWriteUTF16LE $9 ${argument}\n${indent}FileClose $9\n${line}`,
  ),
);
const languageFiles = locales
  .map((locale) => `LoadLanguageFile "${join(nsis, `Contrib/Language files/${locale.file}.nlf`)}"`)
  .join('\n');
const markers = locales
  .map((locale) => `LangString FixtureLocale ${locale.id} "${locale.code}"`)
  .join('\n');
const results = [];
const target = join(work, 'fixture/wrongstack-engine.exe');
const fixtureBytes = Buffer.from('An existing engine file that the installer may replace.\n');
const cases = [
  { ...locales[0], seed: 1 },
  { ...locales[0], seed: 0 },
  { ...locales[0], seed: -7 },
  ...locales.slice(1).map((locale) => ({ ...locale, seed: 0 })),
];
const context = (prefix) => `Function ${prefix}WriteContext
  FileOpen $9 "$EXEDIR\\registers.txt" w
  FileWriteUTF16LE $9 "$4,$5,$6,$7,$8"
  FileClose $9
  FileOpen $9 "$EXEDIR\\locale.txt" w
  FileWriteUTF16LE $9 "$(FixtureLocale)"
  FileClose $9
  ${
    hasCatalog
      ? `FileOpen $9 "$EXEDIR\\held.txt" w
  FileWriteUTF16LE $9 "$(WrongStackEngineHeld)"
  FileClose $9
  FileOpen $9 "$EXEDIR\\unwritable.txt" w
  FileWriteUTF16LE $9 "$(WrongStackEngineUnwritable)"
  FileClose $9`
      : ''
  }
FunctionEnd
`;
const registers = (seed) => `  StrCpy $INSTDIR "$EXEDIR\\fixture"
  StrCpy $4 404
  StrCpy $5 505
  StrCpy $6 606
  StrCpy $7 707
  StrCpy $8 ${seed}`;
const run = async (entry, uninstall, refused) => {
  const exe = uninstall ? entry.uninstaller : entry.installer;
  const result = spawnSync(exe, ['/S', ...(uninstall ? [`_?=${work}`] : [])], {
    windowsHide: true,
    timeout: 30000,
    encoding: 'utf8',
  });
  assert.equal(result.status, refused ? 2 : 0, result.error?.message);
  assert.equal(
    await readFile(join(work, 'registers.txt'), 'utf16le'),
    `404,505,606,707,${entry.seed}`,
  );
  assert.equal(await readFile(join(work, 'locale.txt'), 'utf16le'), entry.code);
  if (hasCatalog) {
    assert.equal(await readFile(join(work, 'unwritable.txt'), 'utf16le'), entry.text);
    assert.ok((await readFile(join(work, 'held.txt'), 'utf16le')).includes(entry.held));
  }
  if (refused) {
    const actual = await readFile(join(work, 'message.txt'), 'utf16le');
    assert.equal(actual, entry.text, `${entry.code}, caller $8=${entry.seed}: actual refusal text`);
    assert.deepEqual(await readFile(target), fixtureBytes, 'Refusal preserves the existing bytes');
  }
  const name = `${uninstall ? 'uninstall' : 'install'} ${entry.code} caller=${entry.seed} ${refused ? 'refusal' : 'control'}`;
  results.push({ result: 'PASS', name });
  console.log(`PASS: ${name}`);
};

try {
  for (const entry of cases) {
    entry.installer = join(work, `install-${entry.code}-${entry.seed}.exe`);
    entry.uninstaller = join(work, `uninstall-${entry.code}-${entry.seed}.exe`);
    const script = join(work, `case-${entry.code}-${entry.seed}.nsi`);
    await writeFile(
      script,
      `\uFEFFUnicode true
Name "WrongStack installer message acceptance"
RequestExecutionLevel user
SetCompress off
!include "LogicLib.nsh"
!include "Win\\RestartManager.nsh"
!include "${join(app, 'src-tauri/target/release/nsis/x64/utils.nsh')}"
!include "${hook}"
!addplugindir "${join(nsis, 'Plugins/x86-unicode/additional')}"
${languageFiles}
${markers}
Var PassiveMode
LangString appRunning 1033 "Engine is running"
LangString appRunningOkKill 1033 "Close engine"
LangString failedToKillApp 1033 "Failed to close engine"
OutFile "${entry.installer}"
Function .onInit
  StrCpy $LANGUAGE ${entry.id}
FunctionEnd
Function un.onInit
  StrCpy $LANGUAGE ${entry.id}
FunctionEnd
${context('')}
${context('un.')}
Function .onInstFailed
  Call WriteContext
FunctionEnd
Function .onInstSuccess
  Call WriteContext
FunctionEnd
Function un.onUninstFailed
  Call un.WriteContext
FunctionEnd
Function un.onUninstSuccess
  Call un.WriteContext
FunctionEnd
Section Install
  WriteUninstaller "${entry.uninstaller}"
${registers(entry.seed)}
  !insertmacro NSIS_HOOK_PREINSTALL
SectionEnd
Section Uninstall
${registers(entry.seed)}
  !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
`,
    );
    const build = spawnSync(join(nsis, 'makensis.exe'), ['/V2', script], {
      windowsHide: true,
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, build.stdout + build.stderr);
  }
  // First install has no old image; neither hook may change caller state.
  await run(cases[1], false, false);
  await run(cases[1], true, false);
  await writeFile(target, fixtureBytes);
  for (const entry of cases) {
    await run(entry, false, false);
    await run(entry, true, false);
  }
  await chmod(target, 0o444);
  for (const entry of cases) await run(entry, false, true);
  for (const code of ['en', 'tr']) {
    await run(
      cases.find((entry) => entry.code === code && entry.seed === 0),
      true,
      true,
    );
  }
  assert.ok(hasCatalog, 'Both failure reasons must have a native localization catalog');
  console.log(`FIX VERIFIED: ${results.length} native message and caller-state cases`);
} catch (error) {
  results.push({ result: 'FAIL', message: String(error.stack ?? error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await chmod(target, 0o666).catch(() => {});
  assert.equal(
    hash(await readFile(input, 'utf8')),
    sourceHash,
    'The input hook changed during acceptance',
  );
  await writeFile(
    join(work, 'results.json'),
    JSON.stringify({ sourceHash, input, results }, null, 2),
  );
  console.log(`Artifacts: ${work}`);
}
process.exit(process.exitCode ?? 0);
