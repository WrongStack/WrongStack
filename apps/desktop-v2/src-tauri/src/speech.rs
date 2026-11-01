//! Dictation through the platform speech recognizer.
//!
//! Windows uses `Windows.Media.SpeechRecognition` continuous dictation. Each session runs on its
//! own multithreaded-apartment thread that owns the recognizer, so no WinRT object crosses a
//! thread. Recognized phrases and live hypotheses stream to the window through a channel; the
//! window inserts them into its draft. Other platforms report that dictation is unavailable
//! rather than showing a microphone that cannot work.

use crate::Result;
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex};
use tauri::ipc::Channel;

/// The stop signal of the session that is listening, if any. One session at a time.
static ACTIVE: Mutex<Option<mpsc::Sender<()>>> = Mutex::new(None);

#[cfg(windows)]
mod platform {
    use serde_json::{json, Value};
    use std::sync::mpsc;
    use tauri::ipc::Channel;
    use windows::{
        core::Ref,
        Foundation::TypedEventHandler,
        Media::SpeechRecognition::{
            SpeechContinuousRecognitionCompletedEventArgs,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
            SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
            SpeechRecognitionResultStatus, SpeechRecognizer,
        },
        Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
    };

    /// Windows reports this when "Online speech recognition" is off in privacy settings.
    const PRIVACY_POLICY_NOT_ACCEPTED: i32 = 0x8004_5509_u32 as i32;

    fn message(error: &windows::core::Error) -> String {
        if error.code().0 == PRIVACY_POLICY_NOT_ACCEPTED {
            "Dictation is turned off in Windows. Turn on Settings > Privacy & security > Speech > Online speech recognition, then try again.".into()
        } else {
            format!("Windows speech recognition failed: {}", error.message())
        }
    }

    fn status_text(status: SpeechRecognitionResultStatus) -> &'static str {
        match status {
            SpeechRecognitionResultStatus::Success => "success",
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => {
                "the dictation language is not installed"
            }
            SpeechRecognitionResultStatus::MicrophoneUnavailable => "no microphone is available",
            SpeechRecognitionResultStatus::NetworkFailure => "the speech service is unreachable",
            SpeechRecognitionResultStatus::TimeoutExceeded => "no speech was heard for a while",
            SpeechRecognitionResultStatus::PauseLimitExceeded => "the pause was too long",
            SpeechRecognitionResultStatus::AudioQualityFailure => "the audio was not clear enough",
            SpeechRecognitionResultStatus::UserCanceled => "listening was stopped",
            _ => "the recognizer stopped",
        }
    }

    /// A recognizer ready for dictation, and its language, on the current (MTA) thread.
    fn dictation() -> std::result::Result<(SpeechRecognizer, String), String> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.ok();
        let recognizer = SpeechRecognizer::new().map_err(|e| message(&e))?;
        let compiled = recognizer
            .CompileConstraintsAsync()
            .and_then(|operation| operation.join())
            .map_err(|e| message(&e))?;
        let status = compiled.Status().map_err(|e| message(&e))?;
        if status != SpeechRecognitionResultStatus::Success {
            return Err(format!(
                "Dictation is not available: {}.",
                status_text(status)
            ));
        }
        let language = recognizer
            .CurrentLanguage()
            .and_then(|language| language.DisplayName())
            .map(|name| name.to_string())
            .unwrap_or_default();
        Ok((recognizer, language))
    }

    pub fn status() -> Value {
        match std::thread::spawn(dictation).join() {
            Ok(Ok((_, language))) => json!({ "available": true, "language": language }),
            Ok(Err(reason)) => json!({ "available": false, "reason": reason }),
            Err(_) => json!({ "available": false, "reason": "The speech recognizer crashed." }),
        }
    }

    /// Listens until `stop` fires or the recognizer ends; every event goes to `channel`.
    pub fn listen(channel: Channel<Value>, stop: mpsc::Receiver<()>) {
        let (recognizer, language) = match dictation() {
            Ok(ready) => ready,
            Err(reason) => {
                let _ = channel.send(json!({ "kind": "error", "message": reason }));
                return;
            }
        };
        let session: SpeechContinuousRecognitionSession =
            match recognizer.ContinuousRecognitionSession() {
                Ok(session) => session,
                Err(error) => {
                    let _ = channel.send(json!({ "kind": "error", "message": message(&error) }));
                    return;
                }
            };
        let (ended_tx, ended_rx) = mpsc::channel::<String>();
        let hypotheses = channel.clone();
        let results = channel.clone();
        let wired = recognizer
            .HypothesisGenerated(&TypedEventHandler::new(
                move |_, args: Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                    if let Some(args) = args.as_ref() {
                        let text = args.Hypothesis()?.Text()?.to_string();
                        let _ = hypotheses.send(json!({ "kind": "hypothesis", "text": text }));
                    }
                    Ok(())
                },
            ))
            .and_then(|_| {
                session.ResultGenerated(&TypedEventHandler::new(
                    move |_, args: Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                        if let Some(args) = args.as_ref() {
                            let result = args.Result()?;
                            if result.Status()? == SpeechRecognitionResultStatus::Success {
                                let text = result.Text()?.to_string();
                                if !text.trim().is_empty() {
                                    let _ = results.send(json!({ "kind": "result", "text": text }));
                                }
                            }
                        }
                        Ok(())
                    },
                ))
            })
            .and_then(|_| {
                session.Completed(&TypedEventHandler::new(
                    move |_, args: Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
                        let reason = args
                            .as_ref()
                            .and_then(|args| args.Status().ok())
                            .map(status_text)
                            .unwrap_or("the recognizer stopped");
                        let _ = ended_tx.send(reason.to_string());
                        Ok(())
                    },
                ))
            })
            .and_then(|_| session.StartAsync()?.join());
        if let Err(error) = wired {
            let _ = channel.send(json!({ "kind": "error", "message": message(&error) }));
            return;
        }
        let _ = channel.send(json!({ "kind": "listening", "language": language }));
        // Wake regularly to notice either a stop request or the recognizer ending on its own.
        let reason = loop {
            if stop.try_recv().is_ok() {
                let _ = session.StopAsync().and_then(|operation| operation.join());
                break "listening was stopped".to_string();
            }
            if let Ok(reason) = ended_rx.recv_timeout(std::time::Duration::from_millis(100)) {
                break reason;
            }
        };
        let _ = channel.send(json!({ "kind": "ended", "reason": reason }));
    }
}

#[cfg(not(windows))]
mod platform {
    use serde_json::{json, Value};
    use std::sync::mpsc;
    use tauri::ipc::Channel;

    pub fn status() -> Value {
        json!({ "available": false, "reason": "Dictation is supported on Windows only." })
    }
    pub fn listen(channel: Channel<Value>, _stop: mpsc::Receiver<()>) {
        let _ = channel
            .send(json!({ "kind": "error", "message": "Dictation is supported on Windows only." }));
    }
}

/// Whether dictation can start: the platform recognizer, its language and the privacy setting.
pub fn status() -> Value {
    platform::status()
}

/// Starts dictation, replacing a session that is still listening.
pub fn start(channel: Channel<Value>) -> Result<()> {
    let (stop_tx, stop_rx) = mpsc::channel();
    if let Some(previous) = ACTIVE.lock().map_err(crate::err)?.replace(stop_tx) {
        let _ = previous.send(());
    }
    std::thread::spawn(move || platform::listen(channel, stop_rx));
    Ok(())
}

/// Stops the session that is listening, if any.
pub fn stop() -> Result<Value> {
    let active = ACTIVE.lock().map_err(crate::err)?.take();
    Ok(json!({ "stopped": active.map(|stop| stop.send(()).is_ok()).unwrap_or(false) }))
}
