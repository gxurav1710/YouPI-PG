# Deploying YOUPI PG V2 to Firebase

This guide outlines the deployment options for **YOUPI PG V2** on **Firebase & Google Cloud**.

---

## 1. Architectural Overview

YOUPI PG V2 is a sovereign payment gateway comprising:
- **Frontend / Client Apps**: Dynamic Checkout Portal (`/checkout/`), Universal Integration SDK (`/youpi.js`), Merchant Store Demo (`/store/`), Merchant Admin Hub (`/admin/`), and API specifications (`/openapi.yaml`).
- **Backend / Realtime Core**: Pure Node.js REST API (`/api/`), single-slot FIFO queue engine, SQLite WAL persistence, SSE real-time state streams, and observer mesh.

Because Firebase offers serverless static hosting (Firebase Hosting) and containerized microservices (Cloud Run), two primary deployment architectures exist:

| Strategy | Components on Firebase | Backend Location | Billing Requirement |
| :--- | :--- | :--- | :--- |
| **Strategy A: Firebase Hosting (Frontend + SDK + Storefront)** | Static web assets, Checkout Portal UI, Storefront, Admin Hub, SDK | Self-hosted VPS / Docker / Cloudflare Tunnel / Render | **Spark (Free Tier)** |
| **Strategy B: Firebase Hosting + Cloud Run (Full Production)** | Global CDN, domain routing, SSL termination | Multi-stage Docker container deployed to Cloud Run | **Blaze (Pay-As-You-Go)** |

---

## 2. Strategy A: Deploying Frontend to Firebase Hosting (Instant)

Firebase Hosting provides zero-cost global CDN caching, automatic SSL, and fast edge delivery for the checkout assets, store demo, and SDK distribution.

### Step 1: Build the Firebase Distribution
Run the build script to compile and package all public web assets into `dist/firebase-public`:
```bash
npm run build:firebase
```

### Step 2: Deploy to Firebase Hosting
Deploy using the Firebase CLI (configured for project `saca-a3ae1` in `.firebaserc`):
```bash
npm run deploy:firebase
# or directly:
firebase deploy --only hosting
```

Your deployment will be instantly accessible at:
- **Default Domain**: `https://saca-a3ae1.web.app`
- **Secondary Domain**: `https://saca-a3ae1.firebaseapp.com`

### Available Endpoints on Firebase Hosting:
- `/` — Official Gateway Launchpad & Portal Dashboard
- `/store/` — Coin Wallet Showcase Store
- `/checkout/` — Dynamic UPI QR Checkout Portal
- `/admin/` — Merchant & Supervisor Admin Hub
- `/youpi.js` — Universal SDK for merchant storefronts
- `/youpi-sms-gateway.apk` — Android SMS Observer APK download
- `/openapi.yaml` — REST API Specification

---

## 3. Strategy B: Deploying Full Stack (Backend + Observers) to Cloud Run

For a unified production setup where the payment API and database run on Google Cloud alongside Firebase Hosting:

### Step 1: Enable Cloud Run & Artifact Registry
Ensure your Firebase project is upgraded to the **Blaze** plan and the Cloud Run API is enabled:
```bash
gcloud config set project saca-a3ae1
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
```

### Step 2: Build and Deploy the Container
Deploy the root `Dockerfile` to Cloud Run:
```bash
gcloud run deploy youpi-pg-api \
  --source . \
  --platform managed \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars NODE_ENV=production,YOUPI_MODE=production,YOUPI_BIND_HOST=0.0.0.0
```

### Step 3: Connect Firebase Hosting to Cloud Run
Update `firebase.json` to route `/api/**` traffic to the Cloud Run service:
```json
{
  "hosting": {
    "public": "dist/firebase-public",
    "rewrites": [
      {
        "source": "/api/**",
        "run": {
          "serviceId": "youpi-pg-api",
          "region": "asia-south1"
        }
      },
      {
        "source": "**",
        "destination": "/index.html"
      }
    ]
  }
}
```

Then deploy the hosting configuration:
```bash
firebase deploy --only hosting
```

---

## 4. Production Checklist

- [ ] Confirm Firebase project ID matches in `.firebaserc`.
- [ ] Configure custom domain in Firebase Console under **Hosting > Custom domains**.
- [ ] Set `YOUPI_ALLOWED_ORIGINS` to allow your merchant storefront domains.
- [ ] Ensure `ENCRYPTION_MASTER_KEY` and `JWT_SECRET` are secured in Google Secret Manager or Cloud Run environment variables.

