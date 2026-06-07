# Bot ANR WhatsApp

Responde con datos del padrón electoral ANR 2026 cuando detecta un mensaje con CI en grupos de WhatsApp.

**Trigger:** cualquier mensaje que contenga `ci: 1234567` o `CI 1234567` (insensible a mayúsculas, acepta puntos).

---

## Deploy en Railway — 5 pasos

### 1. Crear el proyecto en Railway

1. Entrá a [railway.app](https://railway.app) y creá un nuevo proyecto
2. Elegí **Deploy from GitHub repo** y conectá este repositorio
3. Railway detectará automáticamente el `package.json` y usará Node.js

### 2. Crear y montar un Volume para la sesión

1. En tu proyecto Railway, andá a **+ New > Volume**
2. Montalo en el path: `/app/auth_info`
3. Esto persiste la sesión de WhatsApp entre reinicios

### 3. Configurar variable de entorno

En Railway > tu servicio > **Variables**, agregá:

```
AUTH_DIR=/app/auth_info
```

### 4. Hacer el primer deploy y escanear el QR

1. Hacé deploy (o empujá a `main`)
2. Abrí **Railway > tu servicio > Logs**
3. Aparecerá un QR en la terminal — escanealo con WhatsApp desde tu celular:
   - WhatsApp > ⋮ > Dispositivos vinculados > Vincular dispositivo

La sesión queda guardada en el Volume. Los reinicios posteriores no piden QR.

### 5. Agregar el bot a un grupo

- Agregá el número de WhatsApp vinculado a cualquier grupo
- El bot responde automáticamente cuando alguien escribe `ci: 1234567` (o variantes)

---

## Uso

| Mensaje en el grupo | Respuesta |
|---|---|
| `ci: 1234567` | Datos del padrón ANR |
| `CI 1.234.567` | Ídem (ignora puntos) |
| `CI:1234567` | Ídem |

## Desarrollo local

```bash
npm install
cp .env.example .env
# Editá .env si querés cambiar AUTH_DIR
node index.js
```
