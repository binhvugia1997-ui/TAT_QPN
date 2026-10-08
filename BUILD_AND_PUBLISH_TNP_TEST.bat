@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ===========================================================================
REM  BUILD_AND_PUBLISH_TNP_TEST.bat
REM
REM  One-click: validate Git, validate the branch, require a safe fast-forward,
REM  refuse a dirty source tree, run every gate, build the Windows x64 portable
REM  TEST runtime, package it, inspect it, hash it, and publish it to the LAN.
REM
REM  The manifest (version.json) is ALWAYS written last. A client can therefore
REM  never be pointed at a package that is not already fully present and verified.
REM
REM  WHAT THIS SCRIPT NEVER DOES
REM    - git reset --hard / stash / rebase / force-push / auto-merge
REM    - touch data\, backups\ or reports\ on any machine
REM    - publish to a production channel or a production manifest
REM
REM  Usage:  BUILD_AND_PUBLISH_TNP_TEST.bat ["\\SERVER\Share\TAT QPN\updates"]
REM         No argument publishes to the default test folder below. Always quote the path:
REM         the share folder contains a space, and an unquoted argument is split at it.
REM
REM  HOW THIS FILE MUST BE STORED: CRLF line endings. cmd.exe scans batch labels and
REM  parenthesised blocks line by line and its label lookup is unreliable when a script
REM  ends lines with LF only, and every stop in this file depends on `call :fail` and on
REM  blocks. .gitattributes enforces `eol=crlf` for *.bat so a Linux-authored checkout
REM  still produces a script cmd.exe parses the way it reads.
REM ===========================================================================

REM --- configuration -------------------------------------------------------
set "EXPECTED_BRANCH=arena/36b4835b-tat-qpn"
set "TNP_UPDATE_TARGET=%~1"
REM The test channel lives in the same spaced folder the clients read ("TAT QPN"), and an
REM unquoted spaced argument is split by cmd.exe at the space: the publish would then land in
REM ...\ReportExtractor_Update\TAT and every client would keep reading the old manifest.
if not defined TNP_UPDATE_TARGET set "TNP_UPDATE_TARGET=\\192.168.103.12\ReportExtractor_Update\TAT QPN\updates"
set "CHANNEL=test"
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

REM A second argument can only mean the path was split at a space before it reached the script,
REM so the target above holds just the part before that space. This is the general form of the
REM truncation check below: it catches a spaced path of any name, not only the default folder.
if "%~2" neq "" set "TNP_SPLIT_ARGUMENT=1"
if defined TNP_SPLIT_ARGUMENT (
  call :log "extra argument seen: %~2"
  call :fail "The update path was split at a space. Quote the whole path, including both quotes."
  exit /b 1
)

set "LOG_DIR=%REPO_ROOT%\artifacts"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1

REM If the quoting above ever regressed, the target holds only the part before the first space, so
REM it stops dead at the folder name that contains it. That is the symptom, and it is refused rather
REM than published to: a manifest in the wrong folder is read by every client as "update
REM available" pointing at a package that is not there. Substring comparison rather than
REM findstr, whose regex dialect backslash-escapes a literal - the kind of rule that reads fine at
REM review time and silently matches nothing at run time.
if "%TNP_UPDATE_TARGET:~-3%"=="TAT" (
  call :fail "The update target was truncated at a space. Quote the whole path when you pass it."
  exit /b 1
)
REM A leading "\\" means a network path, and node's startsWith is the same rule the app applies.
node -e "const t=String(process.argv[1]).trim();process.exit(t.startsWith(String.fromCharCode(92,92))?0:1)" "%TNP_UPDATE_TARGET%" >nul 2>&1 || ^
  call :log "WARNING: the target is not a UNC path, so only this PC can read the published update."
call :log "==== TNP TEST build and publish ===="
call :log "repository : %REPO_ROOT%"
call :log "target     : %TNP_UPDATE_TARGET%"
call :log "channel    : %CHANNEL%"

cd /d "%REPO_ROOT%"
if errorlevel 1 (
  call :fail "The repository folder could not be opened."
  exit /b 1
)

REM --- 1. Git must be present ---------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  call :fail "git was not found on PATH. Install Git for Windows, or build manually."
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  call :fail "node was not found on PATH. Install Node.js LTS on the BUILD machine only."
  exit /b 1
)
for /f "delims=" %%v in ('git --version') do call :log "%%v"
for /f "delims=" %%v in ('node --version') do call :log "node %%v"

REM Timestamp via node rather than wmic: wmic is removed on newer Windows, node is
REM required for the build anyway, and it is locale independent.
for /f "delims=" %%a in ('node -p "(()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`})()"') do set "STAMP=%%a"
if not defined STAMP (
  REM A timestamp the operator can still read beats a script that dies at the log-file line.
  set "STAMP=unknown"
  call :log "WARNING: the timestamp could not be taken from node; the log file name uses 'unknown'."
)
set "LOG_FILE=%LOG_DIR%\publish-%STAMP%.log"
call :log "log file   : %LOG_FILE%"

REM --- 2. This must be the expected branch --------------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%b"
call :log "branch     : %CURRENT_BRANCH%"
if /i not "%CURRENT_BRANCH%"=="%EXPECTED_BRANCH%" (
  call :fail "This is branch '%CURRENT_BRANCH%'. This script only builds and publishes '%EXPECTED_BRANCH%'."
  exit /b 1
)

REM --- 3. No uncommitted changes to tracked source ------------------------
set "DIRTY="
for /f "delims=" %%s in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  git status --short --untracked-files=no
  call :fail "There are uncommitted changes to tracked files. Commit or discard them deliberately, then run again."
  exit /b 1
)
call :log "working tree: clean for tracked files"

REM --- 4. Fetch and require a SAFE FAST-FORWARD ---------------------------
call :log "fetching origin..."
git fetch --quiet origin "%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "git fetch failed. Check the network and the GitHub connection."
  exit /b 1
)

set "LOCAL_HEAD="
set "REMOTE_HEAD="
for /f "delims=" %%h in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%h"
for /f "delims=" %%h in ('git rev-parse "origin/%EXPECTED_BRANCH%"') do set "REMOTE_HEAD=%%h"
call :log "local HEAD : %LOCAL_HEAD%"
call :log "remote HEAD: %REMOTE_HEAD%"

git merge-base --is-ancestor HEAD "origin/%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "The branches have diverged. A fast-forward is impossible. Resolve this manually - this script will not rebase, merge or reset."
  exit /b 1
)

if /i not "%LOCAL_HEAD%"=="%REMOTE_HEAD%" (
  call :log "remote is ahead; fast-forwarding the branch pointer only"
  REM --ff-only can only move the pointer forward. It cannot create a merge commit and it
  REM will refuse rather than reconcile histories.
  git merge --ff-only "origin/%EXPECTED_BRANCH%"
  if errorlevel 1 (
    call :fail "The fast-forward was refused. Stopping without changing anything."
    exit /b 1
  )
  for /f "delims=" %%h in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%h"
  call :log "now at     : %LOCAL_HEAD%"
)

REM --- 5. Dependencies ----------------------------------------------------
if not exist "%REPO_ROOT%\node_modules" (
  call :log "installing dependencies (npm ci)..."
  call npm ci
  if errorlevel 1 (
    call :fail "npm ci failed."
    exit /b 1
  )
)

REM --- 6. Every gate ------------------------------------------------------
REM `|| exit /b 1` is not decoration: `call :step` returns here, so without it a failed gate
REM would be followed by the next gate, then the build, then the publish. A TEST channel is not a
REM licence to publish code that failed typecheck, and `version.json` is written last, so stopping
REM now is what keeps the already-published build readable by every client.
call :step "typecheck" "call npm run typecheck" || exit /b 1
call :step "unit and business tests" "call npm test" || exit /b 1
call :step "server tests" "call npm run test:server" || exit /b 1
call :step "portable layout tests" "call npm run test:portable" || exit /b 1
call :step "portable runtime tests" "call npm run test:portable-runtime" || exit /b 1
call :step "update tests" "call npm run test:update" || exit /b 1
call :step "dependency audit" "call npm audit --audit-level=high" || exit /b 1

REM --- 7. Build the Windows x64 portable TEST runtime ---------------------
call :step "portable build" "call npm run package:portable" || exit /b 1

REM The folder is the packager's own default (scripts/package-portable.mjs, FOLDER_NAME). It is not
REM the product name: the FOLDER is hyphenated while only the launcher inside it carries spaces
REM ("TNP Defect Management TEST.exe"). A build made with --folder-name has to be pointed at here:
REM   set "TNP_PORTABLE_DIR=D:\TAT TNP\TAT_QPN-main\artifacts\my-folder"
set "PORTABLE_DIR=%TNP_PORTABLE_DIR%"
if not defined PORTABLE_DIR set "PORTABLE_DIR=%REPO_ROOT%\artifacts\TNP-Defect-Management-TEST-win-x64"
if not exist "%PORTABLE_DIR%\TNP Defect Management TEST.exe" (
  REM The packager prints "Portable build ready: <path>"; listing what is actually here turns a
  REM name-drift failure into something the operator can read off the screen instead of guess at.
  call :log "contents of %LOG_DIR% :"
  for /f "delims=" %%d in ('dir /b "%LOG_DIR%"') do call :log "  %%d"
  call :fail "The portable build did not produce its launcher at: %PORTABLE_DIR%"
  exit /b 1
)
call :log "portable   : %PORTABLE_DIR%"

REM --- 8. Pre-flight the update folder, then publish (manifest last) ------
REM Reachability is not the same as write permission, and fs.access(W_OK) reports "writable" on a
REM read-only SMB mount, so the publisher proves it by creating, reading and removing a probe file.
REM Better to learn that now than after the gates and the build have taken their time.
if not exist "%REPO_ROOT%\dist-desktop\desktop\update\publish.js" (
  call :fail "The publish tool is missing. Run npm run build:desktop before publishing."
  exit /b 1
)
REM Written out rather than passed through :step, because a :step argument is one quoted string and
REM cmd.exe ends that string at the first inner quote: the command would reach the routine truncated
REM to `call node` and every value after it would be lost. Plain quoting, as in step 9.
call :log "--- update folder pre-flight ---"
call node "%REPO_ROOT%\dist-desktop\desktop\update\publish.js" --target "%TNP_UPDATE_TARGET%" --channel %CHANNEL% --project "%REPO_ROOT%" --check-only
if errorlevel 1 (
  call :fail "The update folder pre-flight failed. Nothing was published."
  exit /b 1
)
call :log "--- update folder pre-flight: OK ---"

REM --- 9. Publish ----------------------------------------------------------
call :log "publishing to %TNP_UPDATE_TARGET% ..."
call node "%REPO_ROOT%\dist-desktop\desktop\update\publish.js" ^
  --source "%PORTABLE_DIR%" ^
  --target "%TNP_UPDATE_TARGET%" ^
  --channel %CHANNEL% ^
  --project "%REPO_ROOT%" ^
  --notes "TEST build published on %STAMP%"
if errorlevel 1 (
  call :fail "Publishing failed. The previously published version.json was NOT replaced."
  exit /b 1
)

call :log "==== PUBLISHED SUCCESSFULLY ===="
call :log "Order used: build -^> gates -^> pre-flight -^> package -^> inspect -^> sha256 -^> copy -^> verify -^> rename -^> manifest LAST"
call :log "The Owner PC will see the update at its next start."
echo.
echo Published. Log: %LOG_FILE%
endlocal
exit /b 0

REM ===========================================================================
:step
REM Runs one gate and reports it. The command arrives as a single quoted argument because cmd has no
REM other way to hand a compound command line to a routine, which means the command must not contain
REM double quotes of its own - anything that needs quoting is written out at the call site instead.
REM %~2 strips the outer quotes and is then parsed as an ordinary command line.
call :log "--- %~1 ---"
%~2
set "STEP_STATUS=!errorlevel!"
if not "!STEP_STATUS!"=="0" (
  call :log "FAILED: the step '%~1' did not complete with exit code !STEP_STATUS!. Nothing was published."
  exit /b 1
)
call :log "--- %~1: OK ---"
exit /b 0

:log
REM %~1 strips the surrounding quotes but also truncates an *unquoted* argument at its first space,
REM so the raw parameter is echoed with only the quotes removed. `echo(` makes an empty or
REM punctuation-only message safe.
echo(%~1
>>"%LOG_FILE%" echo [%DATE% %TIME%] %~1
goto :eof

:fail
REM Reports the failure and returns 1. It does NOT end the script on its own: `call :fail` returns to
REM its caller, so every call site is followed by `exit /b 1` in this file's own body, which is the
REM only place that can stop the run. A new check without that exit publishes anyway.
call :log "FAILED: %~1"
echo.
echo FAILED: %~1
echo See %LOG_FILE%
endlocal
exit /b 1
