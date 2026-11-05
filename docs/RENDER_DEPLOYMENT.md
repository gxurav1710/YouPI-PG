# Deploying YOUPI PG Backend to Render (Free 24/7 Cloud Hosting)

This guide walks you through deploying your **YOUPI PG V2** backend to Render so your payment gateway runs 24/7 online for free, connected with your Firebase frontend (`https://saca-a3ae1.web.app`).

---

## Step 1: Push Code to Your Own GitHub

Since you cloned the upstream repository, you need to push this project to your own GitHub account so Render can access it.

1. Create a new repository on GitHub: [github.com/new](https://github.com/new) (e.g., `my-youpi-pg`).
2. Run in your terminal:
   ```bash
   git remote set-url origin https://github.com/<YOUR_GITHUB_USERNAME>/<YOUR_REPO_NAME>.git
   git push -u origin feature/firebase-deployment
   ```

---

## Step 2: Deploy on Render via Blueprint (Automatic)

Render has native Blueprint support and will automatically read the included [`render.yaml`](../render.yaml):

1. Go to [dashboard.render.com](https://dashboard.render.com) and log in (or sign up with GitHub).
2. Click **New +** in the top right, and select **Blueprint**.
3. Connect your GitHub account and select your repository (`my-youpi-pg`).
4. Select the branch `feature/firebase-deployment` (or `main` after merging).
5. Render will automatically detect `render.yaml` and configure:
   - **Service Name**: `youpi-pg`
   - **Environment**: Node.js
   - **Build Command**: `npm ci`
   - **Start Command**: `node scripts/start-render.js`
   - **Health Check**: `/health`
   - **Environment Variables**: Automatic cryptographic secrets generation (`ENCRYPTION_MASTER_KEY`, `JWT_SECRET`).
6. Click **Apply**. Render will build and deploy your payment gateway.

---

## Step 3: Your Live Endpoints on Render

Once deployed, Render gives you a public URL (e.g. `https://youpi-pg-xxxx.onrender.com`):

- **Health Ping**: `https://<YOUR_RENDER_URL>/health`
- **REST Payment API**: `https://<YOUR_RENDER_URL>/api/v1/...`
- **Admin Dashboard**: `https://<YOUR_RENDER_URL>/admin`
- **Checkout Portal**: `https://<YOUR_RENDER_URL>/checkout/...`
- **Store Demo**: `https://<YOUR_RENDER_URL>/store`

---

## Step 4: Connect Firebase Frontend with Render Backend

In your [`firebase.json`](../firebase.json), you can route `/api/**` directly to your Render URL:

```json
{
  "hosting": {
    "public": "dist/firebase-public",
    "rewrites": [
      {
        "source": "/api/**",
        "destination": "https://<YOUR_RENDER_URL>/api/**"
      }
    ]
  }
}
```

---

## Step 5: Android Observer APK Configuration

1. Download the Android APK from `apps/android-observer-app/youpi-sms-gateway.apk` (or from your live admin panel).
2. Install it on the Android phone with the SIM card receiving your bank credit SMS.
3. Open the app, scan the pairing QR code from your Render Admin Dashboard (`https://<YOUR_RENDER_URL>/admin`), or enter your backend URL.
4. The phone will now automatically verify bank SMS credits and mark payments as `SUCCESS` in real-time!
