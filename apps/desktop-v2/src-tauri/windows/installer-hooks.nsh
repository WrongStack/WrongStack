; The session host outlives the window and starts engines of its own. Current hosts run those
; engines from a private copy in the user's data folder, but hosts started by WrongStack Desktop
; 1.5.2 and earlier run the installed wrongstack-engine.exe directly, and Windows refuses to
; replace a running executable. Tauri only checks the main executable, so check the engine the
; same way: through Restart Manager, for this exact path, asking before closing it.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\wrongstack-engine.exe" "WrongStack engine"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "$INSTDIR\wrongstack-engine.exe" "WrongStack engine"
!macroend
