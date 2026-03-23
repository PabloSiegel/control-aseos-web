# Control de Aseos — Agrosuper

Web app para registro de aseos de equipos. Backend Node.js/Express + Google Sheets como base de datos. Deploy en Render.com desde GitHub.

---

## Estructura del proyecto

```
control-aseos-web/
├── server.js          ← Backend (Express + Google Sheets API)
├── package.json
├── .env.example       ← Plantilla de variables de entorno
├── .gitignore
└── public/
    └── index.html     ← Frontend (SPA, toda la lógica del app)
```

---

## Paso 1 — Crear la Service Account en Google Cloud

1. Ve a [console.cloud.google.com](https://console.cloud.google.com)
2. Crea un proyecto nuevo (o usa uno existente)
3. Activa la **Google Sheets API**: *APIs y Servicios → Biblioteca → "Google Sheets API" → Activar*
4. Ve a *APIs y Servicios → Credenciales → Crear credenciales → Cuenta de servicio*
5. Ponle cualquier nombre (ej. `control-aseos`) y haz clic en **Crear y continuar**
6. En el paso "Conceder acceso", selecciona el rol **Editor** → Continuar → Listo
7. Haz clic en la cuenta de servicio recién creada → pestaña **Claves** → *Agregar clave → JSON*
8. Se descargará un archivo `.json` — **guárdalo bien, lo necesitarás en Render**

### Dar acceso al Google Sheet

1. Abre el `.json` descargado y copia el valor de `"client_email"` (algo como `control-aseos@mi-proyecto.iam.gserviceaccount.com`)
2. Abre tu Google Sheet: [https://docs.google.com/spreadsheets/d/1Kf1mEOQ1sQUUD1N6pOlexz0mqBecIuo2aVUyllT9nrU](https://docs.google.com/spreadsheets/d/1Kf1mEOQ1sQUUD1N6pOlexz0mqBecIuo2aVUyllT9nrU)
3. Haz clic en **Compartir** → pega el `client_email` → rol **Editor** → Compartir

---

## Paso 2 — Subir a GitHub

1. Crea un repositorio nuevo en GitHub (ej. `control-aseos-agrosuper`) — puede ser privado
2. Sube todos los archivos de esta carpeta al repo (arrastra y suelta, o usa git):
   ```bash
   git init
   git add .
   git commit -m "initial commit"
   git remote add origin https://github.com/TU_USUARIO/control-aseos-agrosuper.git
   git push -u origin main
   ```

---

## Paso 3 — Deploy en Render.com

1. Ve a [render.com](https://render.com) → **New → Web Service**
2. Conecta tu cuenta de GitHub y selecciona el repositorio
3. Configuración del servicio:
   - **Name**: `control-aseos` (o el que quieras)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free (gratis)
4. En la sección **Environment Variables**, agrega:

   | Key | Value |
   |-----|-------|
   | `SHEET_ID` | `1Kf1mEOQ1sQUUD1N6pOlexz0mqBecIuo2aVUyllT9nrU` |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | *(pega aquí el contenido completo del archivo .json descargado en el Paso 1)* |

5. Haz clic en **Create Web Service**

Render construirá y desplegará la app. En 2-3 minutos tendrás una URL pública como:
`https://control-aseos.onrender.com`

---

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/api/dashboard` | KPIs del día actual desde Google Sheets |
| `POST` | `/api/registros` | Guarda un nuevo registro en Google Sheets |

---

## Desarrollo local

```bash
# 1. Instalar dependencias
npm install

# 2. Crear .env con tus credenciales (ver .env.example)
cp .env.example .env
# edita .env con tus valores reales

# 3. Correr el servidor
npm start
# → http://localhost:3000
```
