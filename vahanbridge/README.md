# VahanBridge — Full Stack Setup Guide

## Project Structure

```
vahanbridge/
├── frontend/          ← Deploy to Netlify
│   ├── index.html
│   ├── hsrp_portal.html
│   ├── noc_transfer.html
│   ├── puc_portal.html
│   ├── tax_refund.html
│   ├── bh_series_portal.html
│   └── netlify.toml
│
└── backend/           ← Deploy to Render
    ├── src/
    │   ├── server.js       ← Entry point
    │   ├── db/index.js     ← MySQL pool + schema
    │   ├── routes/hsrp.js  ← HSRP API routes
    │   └── controllers/hsrpController.js
    ├── package.json
    ├── render.yaml
    └── .env.example
```

---

## Step 1 — Local Development Setup

### Backend

```bash
cd backend
npm install

# Copy env template and fill in your MySQL credentials
cp .env.example .env
# Edit .env with your local MySQL details

npm run dev   # starts on http://localhost:5000
```

Test it's working:
```
GET http://localhost:5000/health
```

### Frontend

Just open `frontend/index.html` in a browser (or use VS Code Live Server on port 5500).

The `API_BASE` in `hsrp_portal.html` auto-detects localhost vs production.

---

## Step 2 — Deploy Backend to Render

1. Push the `backend/` folder to a **GitHub repo** (e.g. `vahanbridge-backend`)

2. Go to [render.com](https://render.com) → New → Web Service

3. Connect your GitHub repo

4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Region:** Singapore (closest to India)
   - **Plan:** Free

5. Add a **MySQL Database** on Render:
   - New → PostgreSQL... wait — Render's free DB is PostgreSQL.
   - **For MySQL:** use [Railway](https://railway.app) (free MySQL) or [PlanetScale](https://planetscale.com) (free MySQL).
   - Copy the connection string into Render's Environment Variables.

6. Set Environment Variables in Render dashboard:
   ```
   DB_HOST=     (from Railway/PlanetScale)
   DB_PORT=     3306
   DB_USER=     your_db_user
   DB_PASSWORD= your_db_password
   DB_NAME=     vahanbridge
   NODE_ENV=    production
   FRONTEND_URL= https://your-site.netlify.app  ← set after Step 3
   ```

7. Deploy. Your API URL will be:
   `https://vahanbridge-api.onrender.com`

---

## Step 3 — Deploy Frontend to Netlify

1. Push the `frontend/` folder to a **GitHub repo** (e.g. `vahanbridge-frontend`)

2. Go to [netlify.com](https://netlify.com) → Add new site → Import from Git

3. Settings:
   - **Publish directory:** `.` (root, since all HTML files are at the top level)
   - **Build command:** leave empty

4. Deploy. You'll get a URL like `https://vahanbridge.netlify.app`

5. **Update the API URL** in `hsrp_portal.html`:
   ```js
   // Find this line and update the Render URL:
   : 'https://vahanbridge-api.onrender.com';
   ```
   Then push again to trigger a redeploy.

6. Go back to **Render → Environment Variables** and set:
   ```
   FRONTEND_URL=https://vahanbridge.netlify.app
   ```

---

## Step 4 — Recommended: Use Railway for MySQL (Free)

Railway gives you a free MySQL database that works great with Render.

1. Go to [railway.app](https://railway.app) → New Project → Database → MySQL
2. Click the MySQL service → Variables tab
3. Copy: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
4. Paste these into your Render environment variables

---

## API Endpoints (HSRP)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/health` | Server health check |
| `POST` | `/api/hsrp/apply` | Submit HSRP application |
| `GET`  | `/api/hsrp/status/:bookingRef` | Track application status |
| `GET`  | `/api/hsrp/check-vehicle/:regNo` | Check existing application |
| `GET`  | `/api/hsrp/check-slot?date=&centre=` | Available time slots |
| `POST` | `/api/hsrp/upload-docs/:applicationId` | Upload documents |

---

## API Endpoints (NOC)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/noc/apply` | Submit NOC application |
| `GET`  | `/api/noc/status/:nocRef` | Track application status |
| `GET`  | `/api/noc/check/:regNo` | Check for existing application |
| `POST` | `/api/noc/upload-docs/:applicationId` | Upload home/new state documents |

---

## API Endpoints (Tax Refund)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/tax/calculate` | Calculate pro-rata refund (no DB write) |
| `POST` | `/api/tax/apply` | File full refund application + optional receipt upload |
| `GET`  | `/api/tax/status/:taxRef` | Track refund application status |

---

## Database Tables Created Automatically

- `users` — vehicle owners
- `vehicles` — vehicle details
- `hsrp_applications` — HSRP booking records
- `application_documents` — uploaded document references

Tables are created automatically on first server start via `initSchema()`.

---

## Next Portals (do one by one)

- [x] NOC Transfer — `noc_transfer.html` + `/api/noc`
- [x] Tax Refund — `tax_refund.html` + `/api/tax`
- [ ] BH Series — `bh_series_portal.html` + `/api/bh`
- [ ] PUC Portal — `puc_portal.html` + `/api/puc`
