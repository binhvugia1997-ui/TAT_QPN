@echo off
setlocal EnableExtensions EnableDelayedExpansion
REM ===========================================================================
REM  UPDATE_AND_BUILD_TNP.bat
REM
REM  A DEVELOPER CONVENIENCE for the build/test machine: bring the working copy
REM  up to date from GitHub, refresh dependencies and rebuild the Windows x64
REM  portable TEST runtime locally. It does NOT publish anything.
REM
REM  IMPORTANT: a production update on the Owner PC NEVER depends on GitHub. The
REM  Owner PC reads a runtime-only package from the LAN update folder. GitHub is
REM  only ever involved on this build machine.
REM
REM  WHAT THIS SCRIPT NEVER DOES
REM    - git reset --hard / stash / rebase / force-push / auto-merge
REM    - touch data\, backups\ or reports\
REM
REM  Usage:  UPDATE_AND_BUILD_TNP.bat
REM
REM  HOW THIS FILE MUST BE STORED: CRLF line endings, enforced for *.bat by
REM  .gitattributes, because cmd.exe reads labels and blocks by line.
REM ===========================================================================

set "EXPECTED_BRANCH=arena/36b4835b-tat-qpn"
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
cd /d "%REPO_ROOT%"
if errorlevel 1 (
  call :fail "The repository folder could not be opened."
  exit /b 1
)

echo ==== TNP source update and local build (development only) ====
echo repository: %REPO_ROOT%

where git >nul 2>&1
if errorlevel 1 (
  call :fail "git was not found on PATH."
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  call :fail "node was not found on PATH."
  exit /b 1
)

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%b"
echo branch    : %CURRENT_BRANCH%
if /i not "%CURRENT_BRANCH%"=="%EXPECTED_BRANCH%" (
  call :fail "This is branch '%CURRENT_BRANCH%'; expected '%EXPECTED_BRANCH%'."
  exit /b 1
)

REM Refuse to touch a working tree with uncommitted tracked changes.
set "DIRTY="
for /f "delims=" %%s in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  git status --short --untracked-files=no
  call :fail "There are uncommitted changes to tracked files. Deal with them deliberately first."
  exit /b 1
)

echo fetching origin...
git fetch --quiet origin "%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "git fetch failed."
  exit /b 1
)

git merge-base --is-ancestor HEAD "origin/%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "The branches have diverged. Resolve it manually - this script will not rebase, merge or reset."
  exit /b 1
)

REM --ff-only can only move the branch pointer forward; it cannot create a merge commit.
git merge --ff-only "origin/%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "The fast-forward was refused."
  exit /b 1
)
for /f "delims=" %%h in ('git rev-parse HEAD') do echo now at    : %%h

if not exist "%REPO_ROOT%\node_modules" (
  echo installing dependencies...
  call npm ci
  if errorlevel 1 (
    call :fail "npm ci failed."
    exit /b 1
  )
)

REM Each gate returns to this line, so `|| exit /b 1` is what stops the run. Without it a failed
REM build would be followed by the closing "Built:" banner, which would be a lie.
call :step "typecheck" "call npm run typecheck" || exit /b 1
call :step "tests" "call npm test" || exit /b 1
call :step "server tests" "call npm run test:server" || exit /b 1
call :step "portable tests" "call npm run test:portable" || exit /b 1
call :step "portable runtime tests" "call npm run test:portable-runtime" || exit /b 1
call :step "update tests" "call npm run test:update" || exit /b 1
call :step "portable build" "call npm run package:portable" || exit /b 1

echo.
echo Built: "%REPO_ROOT%\artifacts\TNP-Defect-Management-TEST-win-x64"
echo If that folder is not the one the packager printed as "Portable build ready", you built with
echo --folder-name, and BUILD_AND_PUBLISH_TNP_TEST.bat needs TNP_PORTABLE_DIR set to it.
echo To publish it to the LAN, run BUILD_AND_PUBLISH_TNP_TEST.bat instead.
endlocal
exit /b 0

REM ===========================================================================
:step
REM The command must contain no double quotes of its own: %~2 strips the outer pair and cmd has no
REM backslash escape, so an inner quote ends the argument there and silently truncates the command.
echo --- %~1 ---
%~2
set "STEP_STATUS=!errorlevel!"
if not "!STEP_STATUS!"=="0" (
  echo --- %~1: FAILED with exit code !STEP_STATUS! ---
  exit /b 1
)
echo --- %~1: OK ---
exit /b 0

:fail
REM Returns 1; the call site exits the script. See BUILD_AND_PUBLISH_TNP_TEST.bat for why.
echo.
echo FAILED: %~1
endlocal
exit /b 1
