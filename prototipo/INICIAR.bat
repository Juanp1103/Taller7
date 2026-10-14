@echo off
setlocal
title SimClin - servidor del prototipo
cd /d "%~dp0"

:: Busca un Python DE VERDAD. Ojo: Windows trae un atajo llamado python.exe
:: que solo abre la Microsoft Store, por eso no basta con "where python".
set RUNTIME=
py -3 -c "print(1)" >nul 2>&1 && set RUNTIME=py -3
if not defined RUNTIME python -c "print(1)" >nul 2>&1 && set RUNTIME=python
if not defined RUNTIME python3 -c "print(1)" >nul 2>&1 && set RUNTIME=python3

if defined RUNTIME (
  echo Usando Python: %RUNTIME%
  start "" http://localhost:8080/facilitador
  %RUNTIME% servidor.py
  pause
  exit /b 0
)

:: Si no hay Python, se intenta con Node (hace exactamente lo mismo).
node -v >nul 2>&1 && (
  echo No hay Python. Usando Node.js.
  start "" http://localhost:8080/facilitador
  node servidor.js
  pause
  exit /b 0
)

echo.
echo ================================================================
echo  No se encontro ni Python ni Node.js en este computador.
echo ================================================================
echo.
echo  Opcion 1 (recomendada) - instalar Python:
echo    1. Entrar a  https://www.python.org/downloads/
echo    2. Descargar "Download Python" (boton amarillo) y abrirlo.
echo    3. IMPORTANTE: marcar la casilla "Add python.exe to PATH"
echo       antes de darle Install Now.
echo    4. Cerrar esta ventana y volver a abrir INICIAR.bat
echo.
echo  Opcion 2 - instalar Node.js:  https://nodejs.org  (version LTS)
echo.
echo  Si YA instalaste Python y sigue sin funcionar, es el atajo de la
echo  Microsoft Store: Configuracion ^> Aplicaciones ^> Configuracion
echo  avanzada de aplicaciones ^> Alias de ejecucion de aplicaciones,
echo  y apaga los dos que dicen python.exe y python3.exe
echo.
pause
