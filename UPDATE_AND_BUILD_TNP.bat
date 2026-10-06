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
REM ===========================================================================

set "EXPECTED_BRANCH=arena/36b4835b-tat-qpn"
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
cd /d "%REPO_ROOT%" || (call :fail "The repository folder could not be opened.")

echo ==== TNP source update and local build (development only) ====
echo repository: %REPO_ROOT%

where git >nul 2>&1
if errorlevel 1 call :fail "git was not found on PATH."
where node >nul 2>&1
if errorlevel 1 call :fail "node was not found on PATH."

for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "CURRENT_BRANCH=%%b"
echo branch    : %CURRENT_BRANCH%
if /i not "%CURRENT_BRANCH%"=="%EXPECTED_BRANCH%" (
  call :fail "This is branch '%CURRENT_BRANCH%'; expected '%EXPECTED_BRANCH%'."
)

REM Refuse to touch a working tree with uncommitted tracked changes.
set "DIRTY="
for /f "delims=" %%s in ('git status --porcelain --untracked-files^=no') do set "DIRTY=1"
if defined DIRTY (
  git status --short --untracked-files=no
  call :fail "There are uncommitted changes to tracked files. Deal with them deliberately first."
)

echo fetching origin...
git fetch --quiet origin "%EXPECTED_BRANCH%"
if errorlevel 1 call :fail "git fetch failed."

git merge-base --is-ancestor HEAD "origin/%EXPECTED_BRANCH%"
if errorlevel 1 (
  call :fail "The branches have diverged. Resolve it manually - this script will not rebase, merge or reset."
)

REM --ff-only can only move the branch pointer forward; it cannot create a merge commit.
git merge --ff-only "origin/%EXPECTED_BRANCH%"
if errorlevel 1 call :fail "The fast-forward was refused."
for /f "delims=" %%h in ('git rev-parse HEAD') do echo now at    : %%h

if not exist "%REPO_ROOT%\node_modules" (
  echo installing dependencies...
  call npm ci
  if errorlevel 1 call :fail "npm ci failed."
)

call :step "typecheck" "call npm run typecheck"
call :step "tests" "call npm test"
call :step "server tests" "call npm run test:server"
call :step "portable tests" "call npm run test:portable"
call :step "portable runtime tests" "call npm run test:portable-runtime"
call :step "update tests" "call npm run test:update"
call :step "portable build" "call npm run package:portable"

echo.
echo Built: "%REPO_ROOT%\artifacts\TNP Defect Management System TEST"
echo To publish it to the LAN, run BUILD_AND_PUBLISH_TNP_TEST.bat instead.
endlocal
exit /b 0

REM ===========================================================================
:step
echo --- %~1 ---
%~2
if errorlevel 1 call :fail "The step '%~1' failed."
goto :eof

:fail
echo.
echo FAILED: %~1
endlocal
exit /b 1
