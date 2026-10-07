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
REM  Usage:  BUILD_AND_PUBLISH_TNP_TEST.bat ["\\BUILD-PC\TNP_Update\Test"]
REM ===========================================================================

REM --- configuration -------------------------------------------------------
set "EXPECTED_BRANCH=arena/36b4835b-tat-qpn"
set "TNP_UPDATE_TARGET=%~1"
if not defined TNP_UPDATE_TARGET set "TNP_UPDATE_TARGET=\\BUILD-PC\TNP_Update\Test"
set "CHANNEL=test"
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"

set "LOG_DIR=%REPO_ROOT%\artifacts"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
call :log "==== TNP TEST build and publish ===="
call :log "repository : %REPO_ROOT%"
call :log "target     : %TNP_UPDATE_TARGET%"
call :log "channel    : %CHANNEL%"

cd /d "%REPO_ROOT%" || (call :fail "The repository folder could not be opened.")

REM --- 1. Git must be present ---------------------------------------------
where git >nul 2>&1
if errorlevel 1 call :fail "git was not found on PATH. Install Git for Windows, or build manually."
where node >nul 2>&1
if errorlevel 1 call :fail "node was not found on PATH. Install Node.js LTS on the BUILD machine only."
for /f "delims=" %%v in ('git --version') do call :log "%%v"
for /f "delims=" %%v in ('node --version') do call :log "node %%v"

REM Timestamp via node rather than wmic: wmic is removed on newer Windows, node is
REM required for the build anyway, and it is locale independent.
for /f "delims=" %%a in ('node -p "(()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`})()"') do set "STAMP=%%a"
set "LOG_FILE=%LOG_DIR%\publish-%STAMP%.log"
call :log "log file   : %LOG_FILE%"

REM --- 2. This must be the expected branch --------------------------------
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%b"
call :log "branch     : %CURRENT_BRANCH%"
if /i not "%CURRENT_BRANCH%"=="%EXPECTED_BRANCH%" (
  call :fail "This is branch '%CURRENT_BRANCH%'. This script only builds and publishes '%EXPECTED_BRANCH%'."
)

REM --- 3. No uncommitted changes to tracked source ------------------------
set "DIRTY="
for /f "delims=" %%s in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  git status --short --untracked-files=no
  call :fail "There are uncommitted changes to tracked files. Commit or discard them deliberately, then run again."
)
call :log "working tree: clean for tracked files"

REM --- 4. Fetch and require a SAFE FAST-FORWARD ---------------------------
call :log "fetching origin..."
git fetch --quiet origin "%EXPECTED_BRANCH%"
if errorlevel 1 call :fail "git fetch failed. Check the network and the GitHub connection."

set "LOCAL_HEAD="
set "REMOTE_HEAD="
for /f "delims=" %%h in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%h"
for /f "delims=" %%h in ('git rev-parse "origin/%EXPECTED_BRANCH%"') do set "REMOTE_HEAD=%%h"
call :log "local HEAD : %LOCAL_HEAD%"
call :log "remote HEAD: %REMOTE_HEAD%"

git merge-base --is-ancestor HEAD "origin/%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "The branches have diverged. A fast-forward is impossible. Resolve this manually - this script will not rebase, merge or reset."
)

if /i not "%LOCAL_HEAD%"=="%REMOTE_HEAD%" (
  call :log "remote is ahead; fast-forwarding the branch pointer only"
  REM --ff-only can only move the pointer forward. It cannot create a merge commit and it
  REM will refuse rather than reconcile histories.
  git merge --ff-only "origin/%EXPECTED_BRANCH%"
  if errorlevel 1 call :fail "The fast-forward was refused. Stopping without changing anything."
  for /f "delims=" %%h in ('git rev-parse HEAD') do set "LOCAL_HEAD=%%h"
  call :log "now at     : %LOCAL_HEAD%"
)

REM --- 5. Dependencies ----------------------------------------------------
if not exist "%REPO_ROOT%\node_modules" (
  call :log "installing dependencies (npm ci)..."
  call npm ci
  if errorlevel 1 call :fail "npm ci failed."
)

REM --- 6. Every gate ------------------------------------------------------
call :step "typecheck" "call npm run typecheck"
call :step "unit and business tests" "call npm test"
call :step "server tests" "call npm run test:server"
call :step "portable layout tests" "call npm run test:portable"
call :step "portable runtime tests" "call npm run test:portable-runtime"
call :step "update tests" "call npm run test:update"
call :step "dependency audit" "call npm audit --audit-level=high"

REM --- 7. Build the Windows x64 portable TEST runtime ---------------------
call :step "portable build" "call npm run package:portable"

set "PORTABLE_DIR=%REPO_ROOT%\artifacts\TNP Defect Management System TEST"
if not exist "%PORTABLE_DIR%\TNP Defect Management TEST.exe" (
  call :fail "The portable build did not produce its launcher at: %PORTABLE_DIR%"
)
call :log "portable   : %PORTABLE_DIR%"

REM --- 8. Package, inspect, hash, publish (manifest last) -----------------
call :log "publishing to %TNP_UPDATE_TARGET% ..."
call node "%REPO_ROOT%\dist-desktop\desktop\update\publish.js" ^
  --source "%PORTABLE_DIR%" ^
  --target "%TNP_UPDATE_TARGET%" ^
  --channel %CHANNEL% ^
  --notes "TEST build published on %STAMP%"
if errorlevel 1 call :fail "Publishing failed. The previously published version.json was NOT replaced."

call :log "==== PUBLISHED SUCCESSFULLY ===="
call :log "Order used: build -^> gates -^> package -^> inspect -^> sha256 -^> copy -^> verify -^> rename -^> manifest LAST"
call :log "The Owner PC will see the update at its next start."
echo.
echo Published. Log: %LOG_FILE%
endlocal
exit /b 0

REM ===========================================================================
:step
call :log "--- %~1 ---"
%~2
if errorlevel 1 call :fail "The step '%~1' failed. Nothing was published."
call :log "--- %~1: OK ---"
goto :eof

:log
echo %~1
>>"%LOG_FILE%" echo [%DATE% %TIME%] %~1
goto :eof

:fail
call :log "FAILED: %~1"
echo.
echo FAILED: %~1
echo See %LOG_FILE%
endlocal
exit /b 1
