@echo off
setlocal
title SimClin - punto de acceso para el celular
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0red\punto_de_acceso.ps1" 8080
if errorlevel 1 goto manual
goto fin

:manual
echo.
echo  No se pudo ejecutar el ayudante de PowerShell.
echo  Hay que prender el punto de acceso a mano:
echo.
echo    Configuracion ^> Red e Internet ^> Zona con cobertura inalambrica movil
echo    (en ingles: Mobile hotspot) ^> Activado
echo.
echo  Despues, conecten el celular a esa red y en el panel del facilitador
echo  escojan la direccion que empieza por 192.168.137.
echo.
start "" ms-settings:network-mobilehotspot

:fin
echo.
pause
