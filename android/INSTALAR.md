# Flash Signals en Android — instalar y actualizar

La app **Flash Signals** (APK propio) es un asistente: comprueba sola qué falta y muestra **un único botón dorado** con el siguiente paso. Los pasos ya hechos aparecen con ✓.

## En el PC (una vez por versión)

```powershell
.\android\release-android.ps1
```

Hace todo: build de Angular, paquete (`out\flash-android.tar.gz` + `VERSION`), APK con el paquete dentro (si hay Android SDK) y, si el teléfono está conectado por adb (USB o depuración inalámbrica), lo instala y abre la app.

Detén antes la API (`run-api.ps1`) para que los `.sqlite` queden consistentes.

## Primera instalación en el teléfono

1. Instala `out\FlashSignals.apk` (por adb lo instala el script; si no, cópialo y permite «instalar apps desconocidas»).
2. Abre **Flash Signals** y pulsa el botón dorado tantas veces como te lo pida:
   1. **Instalar Termux**: desde F-Droid o GitHub, *no* desde Play Store (la app avisa si detecta la de Play Store). Ábrelo una vez.
   2. **Permitir usar Termux**: acepta el permiso de Android.
   3. **Copiar comando y abrir Termux**: en Termux mantén pulsado → Pegar → Enter. Vuelve a la app (se comprueba sola).
   4. **Instalar Flash Signals vX**: el paquete pasa directo del APK a Termux (sin Download ni permiso de almacenamiento) y se instala en Termux (20–40 min la primera vez, con Wi-Fi). Al terminar, vuelve a la app.
3. La app arranca el servidor y abre la interfaz sola. Si falla, muestra las últimas líneas del registro y un botón **Reintentar**.
4. Recomendado: botón **Quitar restricción de batería a Termux** → Batería → Sin restricciones.

Atajo: `.\android\setup-phone-adb.ps1 -Device IP:PUERTO` hace los pasos 2.1–2.3 y la batería por adb.

## Actualizar

- **Con APK nuevo** (`release-android.ps1`): al abrir la app aparece **Actualizar a vX**. Un toque.
- **Sin APK nuevo, por Wi-Fi** (más rápido):

  ```powershell
  .\android\release-android.ps1 -NoApk -Serve
  ```

  En la app: **Actualizar desde el PC (Wi-Fi)** → escribe la dirección que muestra el PC (si el teléfono estaba por adb, ya viene rellenada) → **Instalar desde el PC**. Desde ahí también puedes bajar el APK nuevo.

Actualizar conserva el historial (`data/`) y `live/`. Las dependencias (apt, pip, npm) solo se reinstalan si cambiaron, así que una actualización normal tarda pocos minutos.

## Si algo falla

- **«Termux no respondió»**: cierra Termux por completo (Exit en su notificación), ábrelo y vuelve a la app.
- **Instalación fallida**: la app muestra el paso y el final de `~/flash-install.log`; pulsa **Reintentar instalación**.
- **El servidor se cierra solo** (Android 12+): batería sin restricciones para Termux o `setup-phone-adb.ps1` (quita el límite de procesos).
- **El teléfono no ve el PC** con `-Serve`: misma Wi-Fi y abre el puerto 8848 en el firewall (el script muestra el comando).
- Manual en Termux: `BUNDLE_URL=http://IP-PC:8848/flash-android.tar.gz bash termux-install.sh` (o `--fresh` para reinstalar desde cero).
