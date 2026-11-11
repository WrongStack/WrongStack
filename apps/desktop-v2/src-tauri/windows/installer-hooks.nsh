; The session host outlives the window and starts engines of its own. Current hosts run those
; engines from a private copy in the user's data folder, but hosts started by WrongStack Desktop
; 1.5.2 and earlier run the installed wrongstack-engine.exe directly, and Windows refuses to
; replace a running executable. Tauri only checks the main executable, so check the engine the
; same way: through Restart Manager, for this exact path, asking before closing it.
; Restart Manager can finish its first shutdown while a daemon started by that engine still
; holds the same image. Do not let NSIS silently skip the locked sidecar and report success.
; Recheck the exact installed path, preserving Tauri's interactive consent on every shutdown.
; Budgets: $4 counts shutdown rounds (5), $6 counts probes inside a round (10 x 100 ms),
; $8 records the last probe outcome (0 = still held, 1 = readable but not replaceable).
; Keep these in the hook so the installer and uninstaller share the same language catalog.
LangString WrongStackEngineUnwritable 1033 "The installed WrongStack engine cannot be replaced. Run this installer with the same rights that installed it."
LangString WrongStackEngineUnwritable 1055 "Kurulu WrongStack motoru değiştirilemiyor. Bu yükleyiciyi, motoru kurarken kullanılan yetkilerle çalıştırın."
LangString WrongStackEngineUnwritable 1031 "Die installierte WrongStack-Engine kann nicht ersetzt werden. Führen Sie dieses Installationsprogramm mit denselben Rechten wie bei der Installation aus."
LangString WrongStackEngineUnwritable 1036 "Le moteur WrongStack installé ne peut pas être remplacé. Exécutez ce programme d'installation avec les mêmes droits que lors de l'installation."
LangString WrongStackEngineUnwritable 1040 "Il motore WrongStack installato non può essere sostituito. Esegui questo programma di installazione con gli stessi permessi usati per installarlo."
LangString WrongStackEngineUnwritable 1034 "No se puede reemplazar el motor de WrongStack instalado. Ejecuta este instalador con los mismos permisos usados durante la instalación."
LangString WrongStackEngineUnwritable 1046 "Não é possível substituir o mecanismo do WrongStack instalado. Execute este instalador com as mesmas permissões usadas na instalação."
LangString WrongStackEngineHeld 1033 "The WrongStack engine is still running and could not be closed. Close it and run the installer again."
LangString WrongStackEngineHeld 1055 "WrongStack motoru hâlâ çalışıyor ve kapatılamadı. Motoru kapatıp yükleyiciyi yeniden çalıştırın."
LangString WrongStackEngineHeld 1031 "Die WrongStack-Engine läuft noch und konnte nicht beendet werden. Beenden Sie sie und starten Sie das Installationsprogramm erneut."
LangString WrongStackEngineHeld 1036 "Le moteur WrongStack est toujours en cours d'exécution et n'a pas pu être fermé. Fermez-le, puis relancez le programme d'installation."
LangString WrongStackEngineHeld 1040 "Il motore WrongStack è ancora in esecuzione e non è stato possibile chiuderlo. Chiudilo ed esegui di nuovo il programma di installazione."
LangString WrongStackEngineHeld 1034 "El motor de WrongStack sigue en ejecución y no se pudo cerrar. Ciérralo y vuelve a ejecutar el instalador."
LangString WrongStackEngineHeld 1046 "O mecanismo do WrongStack ainda está em execução e não pôde ser encerrado. Encerre-o e execute o instalador novamente."

; The suffix keeps the labels unique: NSIS expands macros textually, and Tauri's installer
; script inserts this body twice (once for the install section, once for the uninstall
; section), so bare labels would be defined twice and makensis would fail to build.
!macro WrongStack_CheckEngineReleased suffix
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  StrCpy $4 0
  wrongstack_engine_retry_${suffix}:
  !insertmacro CheckIfAppIsRunning "$INSTDIR\wrongstack-engine.exe" "WrongStack engine"
  ; Give a successfully stopped process time to release its image before requesting another
  ; shutdown. Restart Manager can still list that exiting process during this interval.
  StrCpy $6 0
  StrCpy $8 0
  wrongstack_engine_probe_${suffix}:
  IfFileExists "$INSTDIR\wrongstack-engine.exe" 0 wrongstack_engine_released_${suffix}
  ; OPEN_EXISTING with write access and no sharing checks replaceability without changing bytes.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\wrongstack-engine.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p.r5'
  IntCmp $5 -1 wrongstack_engine_probe_readable_${suffix}
  System::Call 'kernel32::CloseHandle(p r5)'
  Goto wrongstack_engine_released_${suffix}
  wrongstack_engine_probe_readable_${suffix}:
  ; The exclusive open failed. A read that tolerates a shared reader tells the two causes
  ; apart: a mapped image or an open handle blocks it too, a file that only denies writing
  ; does not. GetLastError cannot be used here: the System plugin clears the thread error.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\wrongstack-engine.exe", i 0x80000000, i 1, p 0, i 3, i 0, p 0) p.r5'
  IntCmp $5 -1 wrongstack_engine_held_${suffix}
  System::Call 'kernel32::CloseHandle(p r5)'
  ; Readable but not replaceable: this installer may not write the installed file.
  StrCpy $8 1
  wrongstack_engine_held_${suffix}:
    IntOp $6 $6 + 1
    IntCmp $6 10 wrongstack_engine_recheck_${suffix} wrongstack_engine_wait_${suffix} wrongstack_engine_recheck_${suffix}
  wrongstack_engine_wait_${suffix}:
    Sleep 100
    Goto wrongstack_engine_probe_${suffix}
  wrongstack_engine_recheck_${suffix}:
    IntOp $4 $4 + 1
    IntCmp $4 5 wrongstack_engine_failed_${suffix} wrongstack_engine_retry_${suffix} wrongstack_engine_failed_${suffix}
  wrongstack_engine_failed_${suffix}:
    ; Name the reason the install was refused. $R3 only holds a message when
    ; CheckIfAppIsRunning itself failed, so it is never used for this abort.
    ; Select the failure while $8 still holds the probe outcome, then restore caller registers.
    SetErrorLevel 2
    IntCmp $8 1 wrongstack_engine_refused_unwritable_${suffix} wrongstack_engine_refused_locked_${suffix}
    wrongstack_engine_refused_unwritable_${suffix}:
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Abort "$(WrongStackEngineUnwritable)"
    wrongstack_engine_refused_locked_${suffix}:
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
    Abort "$(WrongStackEngineHeld)"
  wrongstack_engine_released_${suffix}:
    Pop $8
    Pop $7
    Pop $6
    Pop $5
    Pop $4
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WrongStack_CheckEngineReleased preinstall
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro WrongStack_CheckEngineReleased preuninstall
!macroend
