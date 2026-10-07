# SimClin - prende el punto de acceso movil de Windows para que el celular
# pueda llegar al servidor cuando el wifi de la universidad los aisla.
# No necesita internet: el celular solo necesita VER al computador.

$ErrorActionPreference = "Stop"
$PUERTO = 8080
if ($args.Count -ge 1) { $PUERTO = [int]$args[0] }

function Titulo($t) { Write-Host ""; Write-Host "  $t" -ForegroundColor Cyan }
function Ok($t)     { Write-Host "  $t" -ForegroundColor Green }
function Aviso($t)  { Write-Host "  $t" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ===========================================================" -ForegroundColor Cyan
Write-Host "   SIMCLIN - PUNTO DE ACCESO PARA EL CELULAR" -ForegroundColor Cyan
Write-Host "  ===========================================================" -ForegroundColor Cyan

# ---------------------------------------------------------------- 1. hotspot
$prendido = $false
$ssid = $null
$clave = $null

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null

  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq "AsTask" -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
    })[0]
  if (-not $asTask) { throw "Esta version de Windows no expone la API de punto de acceso." }

  $perfil = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]::GetInternetConnectionProfile()
  if (-not $perfil) {
    throw "Windows no ve ninguna conexion activa para compartir (conecten el computador al wifi o al cable primero)."
  }

  $gestor = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]::CreateFromConnectionProfile($perfil)

  try {
    $cfg = $gestor.GetCurrentAccessPointConfiguration()
    $ssid = $cfg.Ssid
    $clave = $cfg.Passphrase
  } catch { }

  if ("$($gestor.TetheringOperationalState)" -eq "On") {
    Ok "El punto de acceso ya estaba prendido."
    $prendido = $true
  } else {
    Write-Host "  Prendiendo el punto de acceso..."
    $op = $gestor.StartTetheringAsync()
    $tipo = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]
    $tarea = $asTask.MakeGenericMethod($tipo).Invoke($null, @($op))
    if (-not $tarea.Wait(25000)) { throw "Windows se quedo colgado al prenderlo." }
    $r = $tarea.Result
    if ("$($r.Status)" -eq "Success") {
      Ok "Listo: el punto de acceso quedo prendido."
      $prendido = $true
    } else {
      throw "Windows respondio: $($r.Status) $($r.AdditionalErrorMessage)"
    }
  }
} catch {
  Aviso "No se pudo prenderlo automaticamente."
  Write-Host "  Motivo: $($_.Exception.Message)" -ForegroundColor DarkYellow
  Write-Host ""
  Write-Host "  Se va a abrir la ventana de Windows para prenderlo a mano."
  Write-Host "  Busquen 'Zona con cobertura inalambrica movil' / 'Mobile hotspot'"
  Write-Host "  y pongan el interruptor en Activado."
  try { Start-Process "ms-settings:network-mobilehotspot" } catch { }
}

if ($ssid) {
  Titulo "DATOS DE LA RED (para conectar el celular)"
  Write-Host "    Nombre de la red (SSID): " -NoNewline; Write-Host $ssid -ForegroundColor White
  if ($clave) { Write-Host "    Contrasena:              " -NoNewline; Write-Host $clave -ForegroundColor White }
  Write-Host ""
  Write-Host "    Si la contrasena es muy larga, se puede cambiar en la misma"
  Write-Host "    ventana de Windows (Editar / Edit)."
}

# --------------------------------------------------------------- 2. firewall
Titulo "PERMISO DEL FIREWALL (puerto $PUERTO)"
$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($esAdmin) {
  try {
    netsh advfirewall firewall delete rule name="SimClin $PUERTO" 2>$null | Out-Null
    netsh advfirewall firewall add rule name="SimClin $PUERTO" dir=in action=allow protocol=TCP localport=$PUERTO profile=any 2>$null | Out-Null
    Ok "Regla de firewall creada: el celular ya puede entrar por el puerto $PUERTO."
  } catch {
    Aviso "No se pudo crear la regla de firewall."
  }
} else {
  Aviso "Esta ventana no es de administrador, asi que no se pudo crear la regla."
  Write-Host "    No es grave: cuando arranquen INICIAR.bat, Windows va a preguntar"
  Write-Host "    por el firewall. Marquen 'Redes privadas' Y 'Redes publicas'."
  Write-Host "    Si quieren crearla igual, clic derecho en PUNTO_DE_ACCESO.bat >"
  Write-Host "    'Ejecutar como administrador'."
}

# ------------------------------------------------------------------ 3. las IP
Titulo "DIRECCIONES DE ESTE COMPUTADOR"
$direcciones = @()
try {
  $direcciones = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -ne "127.0.0.1" -and -not $_.IPAddress.StartsWith("169.254.") } |
    Select-Object -ExpandProperty IPAddress)
} catch {
  try {
    $direcciones = ([System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq "InterNetwork" } |
      ForEach-Object { $_.IPAddressToString }) |
      Where-Object { $_ -ne "127.0.0.1" -and -not $_.StartsWith("169.254.") }
  } catch { }
}

$buena = $direcciones | Where-Object { $_.StartsWith("192.168.137.") } | Select-Object -First 1

if ($direcciones.Count -eq 0) {
  Aviso "No se pudieron leer las direcciones. Mirenlas en la ventana negra de INICIAR.bat."
} else {
  foreach ($ip in $direcciones) {
    $etiqueta = ""
    if ($ip.StartsWith("192.168.137.")) { $etiqueta = "  <-- ESTA es la del punto de acceso" }
    elseif ($ip.StartsWith("10."))      { $etiqueta = "      (red institucional: casi siempre bloquea el celular)" }
    elseif ($ip.StartsWith("172."))     { $etiqueta = "      (red institucional o virtual)" }
    Write-Host "    http://$($ip):$PUERTO/control$etiqueta"
  }
}

Titulo "QUE SIGUE"
if ($buena) {
  Write-Host "    1. Conecten el celular al wifi '$ssid'."
  Write-Host "    2. Abran (o dejen abierto) INICIAR.bat."
  Write-Host "    3. En el panel del facilitador, en 'Direccion para el celular',"
  Write-Host "       escojan  http://$($buena):$PUERTO/control"
  Write-Host "       El codigo QR del televisor cambia solo a esa direccion."
  Write-Host "    4. Escaneen el QR con el celular."
} else {
  Write-Host "    1. Prendan el punto de acceso en la ventana de Windows que se abrio."
  Write-Host "    2. Vuelvan a abrir PUNTO_DE_ACCESO.bat para ver la direccion nueva"
  Write-Host "       (va a empezar por 192.168.137.)."
  Write-Host "    3. Conecten el celular a esa red y escaneen el QR del televisor."
  Write-Host ""
  Write-Host "    Si este computador no deja prender el punto de acceso, el plan B es"
  Write-Host "    al reves: prendan el punto de acceso de UN CELULAR (compartir datos)"
  Write-Host "    y conecten ahi el computador y el celular del control. No gasta datos:"
  Write-Host "    el trafico es entre los dos aparatos."
}
Write-Host ""
