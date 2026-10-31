@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\python3.exe" (
  SET "_prog=%dp0%\python3.exe"
) ELSE (
  SET "_prog=python3"
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\..\node_modules\py\bin\cli.py" %*
