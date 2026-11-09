import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Manual acoustic acceptance. Observes actual native callbacks and never synthesizes speech. */
export async function exerciseNativeLiveDictation({ page, artifactDir, speech }) {
  assert.equal(speech.available, true, `Real dictation unavailable: ${speech.reason ?? 'unknown'}`);
  const artifact = join(artifactDir, 'dictation-live.json');
  const phrase = 'microphone test complete';
  const input = page.getByRole('textbox', { name: 'Message WrongStack', exact: true });
  const original = await input.inputValue();
  const prefix = 'Existing draft stays. ';
  const userMessages = await page.locator('.chat-message.user').count();
  const save = (value) => writeFile(artifact, JSON.stringify(value, null, 2) + '\n');
  await page.evaluate(() => {
    const ipc = window.__TAURI_INTERNALS__;
    const originalInvoke = ipc.invoke;
    const evidence = { starts: 0, results: 0, phraseMatched: false, errorSeen: false };
    const restoreChannels = [];
    const observedInvoke = (command, args, ...rest) => {
      if (command === 'speech_start' && args?.channel) {
        evidence.starts += 1;
        const channel = args.channel;
        const originalHandler = channel.onmessage;
        channel.onmessage = (event) => {
          if (event.kind === 'result') {
            evidence.results += 1;
            evidence.phraseMatched ||= /microphone\s+test\s+complete/i.test(
              String(event.text ?? ''),
            );
          }
          if (event.kind === 'error') evidence.errorSeen = true;
          originalHandler.call(channel, event);
        };
        restoreChannels.push(() => {
          channel.onmessage = originalHandler;
        });
      }
      return originalInvoke.call(ipc, command, args, ...rest);
    };
    ipc.invoke = observedInvoke;
    if (ipc.invoke !== observedInvoke) throw Error('Cannot observe real native speech callbacks');
    window.__nativeDictationEvidence = evidence;
    window.__restoreNativeDictationObserver = () => {
      ipc.invoke = originalInvoke;
      for (const restore of restoreChannels) restore();
      delete window.__nativeDictationEvidence;
      delete window.__restoreNativeDictationObserver;
    };
  });
  await input.fill(prefix);
  await save({ phase: 'waiting-for-user-click', phrase, language: speech.language });
  console.log(
    `MICROPHONE_READY ${JSON.stringify({ artifact, phrase, session: 'Native plan templates' })}`,
  );
  try {
    // Only the user's Dictate click starts speech_start. Typing the phrase cannot pass.
    await page.waitForFunction(() => window.__nativeDictationEvidence.starts > 0, undefined, {
      timeout: 300000,
    });
    await page.waitForFunction(
      () => {
        const evidence = window.__nativeDictationEvidence;
        return evidence.phraseMatched || evidence.errorSeen;
      },
      undefined,
      { timeout: 120000 },
    );
    const evidence = await page.evaluate(() => ({ ...window.__nativeDictationEvidence }));
    assert.equal(
      evidence.errorSeen,
      false,
      'The real platform recognizer must not report an error',
    );
    assert.ok(
      evidence.results > 0 && evidence.phraseMatched,
      'The phrase must arrive through the actual native result channel',
    );
    assert.match(await input.inputValue(), /microphone\s+test\s+complete/i);
    assert.ok(
      (await input.inputValue()).startsWith(prefix),
      'Speech appends without replacing the existing draft',
    );
    assert.equal(
      await page.locator('.chat-message.user').count(),
      userMessages,
      'Dictation does not send a message',
    );
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('speech_stop'));
    await page
      .getByRole('button', { name: 'Stop dictation', exact: true })
      .waitFor({ state: 'detached', timeout: 10000 });
    await input.fill(original);
    await save({
      phase: 'PASS',
      liveMicrophone: true,
      nativeResultObserved: true,
      phraseMatched: true,
      existingDraftPreserved: true,
      noMessageSent: true,
      recordingStopped: true,
      language: speech.language,
    });
    console.log(
      'PASS: actual microphone result appends to the native draft without sending or replacing it, then stops',
    );
  } catch (error) {
    const evidence = await page
      .evaluate(() => ({ ...window.__nativeDictationEvidence }))
      .catch(() => ({}));
    await save({
      phase: 'not-completed',
      manualAcousticScenario: true,
      userStartObserved: evidence.starts > 0,
      nativeResultObserved: evidence.results > 0,
      phraseMatched: evidence.phraseMatched === true,
      errorType: error?.name ?? 'unknown',
    });
    throw error;
  } finally {
    await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('speech_stop')).catch(() => {});
    await page.evaluate(() => window.__restoreNativeDictationObserver?.()).catch(() => {});
    await input.fill(original).catch(() => {});
  }
}
