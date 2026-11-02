# Custom Payment QR Code Stand & Soundbox Service Guide

This guide provides the complete architectural, operational, and integration blueprint for delivering a customized physical and digital payment QR code stand service to merchants, using **YOUPI PG V2** as the underlying zero-fee payment infrastructure.

---

## 1. Technical Diagnosis: Why PhonePe Rejects > ₹2,000 Gallery QRs

### The "Scan from Gallery" Restriction
When customers attempt to pay using an image or screenshot saved in their phone's photo library (**PhonePe &rarr; QR Scanner &rarr; Upload from Gallery**), transactions above **₹2,000** are declined or met with the following warning:
> *"You can pay up to ₹2,000 with QR codes via gallery"*

### The Regulatory Root Cause (NPCI & Banking Risk Rules)
1. **Anti-Scam Measure**: The National Payments Corporation of India (NPCI) and major payment apps (PhonePe, Google Pay, Paytm) introduced strict caps on gallery-imported QR scans. Scammers frequently distribute fraudulent QR code images via WhatsApp, Telegram, or SMS claiming to send cashback or refunds.
2. **Remote vs. Card-Present Distinction**: An uploaded gallery image is categorized as an **unauthenticated remote transaction**. Because the physical proximity of the buyer to the merchant cannot be verified, banks and apps restrict the transaction amount to ₹2,000.

### Why a Physical Payment Stand Completely Bypasses This Limit
1. **Live Camera Scanning (Card-Present Mode)**: When a customer opens PhonePe and points the **live smartphone camera** at a physical acrylic stand or a counter display screen, the transaction is recognized as an authenticated in-person scan.
2. **High-Value UPI Rail Limits**: Under NPCI rules for in-person camera scans (`mode=02` for static merchant stands or `mode=04` for dynamic billing counter screens):
   - Standard P2P / P2PM limits: **Up to ₹1,00,000 per transaction / per day**.
   - Verified Merchant Category Codes (e.g. `mc=5411` Grocery, `mc=5999` Retail): **Up to ₹1,00,000 to ₹5,00,000**.
3. **No Image Upload**: The customer never saves an image to their gallery, eliminating the ₹2,000 restriction entirely.

---

## 2. Solution Architecture

YOUPI PG provides three synchronized layers to deliver a reliable, enterprise-grade payment stand service:

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │                           CUSTOMER TOUCHPOINTS                         │
  ├───────────────────────────────────┬────────────────────────────────────┤
  │   Option A: Physical Acrylic      │     Option B: Smart Digital        │
  │         Payment Stand             │         Counter Display            │
  │  (4"x6" / 5"x7" Printed Stand)    │     (Tablet / POS Screen / Till)   │
  └─────────────────┬─────────────────┴──────────────────┬─────────────────┘
                    │                                    │
                    │ Point Live Phone Camera (PhonePe)  │
                    ▼                                    ▼
       [ Customer Approves Payment in PhonePe / GPay / Paytm (> ₹2,000) ]
                    │
                    ▼
     [ NPCI UPI Network Transfers Funds Direct-to-Bank (0% MDR) ]
                    │
                    ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │                 MERCHANT TELEMETRY & OBSERVATION MESH                  │
  ├────────────────────────────────────────────────────────────────────────┤
  │ 1. PhonePe Push Notification: "Received ₹3,500 on PhonePe from ..."    │
  │ 2. Bank Credit SMS: "A/c *1234 credited with INR 3,500.00 ..."         │
  │ 3. YouPI Android Observer App (com.youpi.observer) parses amount & UTR │
  │ 4. HMAC-SHA256 signed event dispatched to Payment Core REST API        │
  └─────────────────┬──────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │                   REAL-TIME INSTANT FEEDBACK DOCK                      │
  ├────────────────────────────────────────────────────────────────────────┤
  │ • Merchant Admin Panel: Live ledger reflects ₹3,500 + 12-digit UTR     │
  │ • Smart Stand Screen (/stand): Instant Green Checkmark + Celebration   │
  │ • Digital Soundbox: Voice alert "₹3,500 received on PhonePe"           │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Merchant Setup & Integration Instructions

### Step 1: Customer Details Required
To configure the payment stand for your customer, collect:
1. **Customer UPI ID (VPA)**: e.g. `merchant@ybl`, `9876543210@ybl`, or bank handle.
2. **PhonePe Registered Mobile Number**: The 10-digit number linked to the merchant's PhonePe account.
3. **Merchant Business Name**: Legal or trade name for the stand header.
4. **Primary Brand Color**: Hex code (defaults to PhonePe Royal Purple `#5f259f`).

### Step 2: Configure in Merchant Admin Panel
1. Open the **Merchant Admin Hub** at `http://localhost:6001` (or your production admin domain).
2. Navigate to **Store Settings &rarr; 🪧 Payment QR Stand Studio**.
3. Input the customer's UPI ID, PhonePe registered mobile number, business name, and design preferences.
4. The live artwork preview immediately renders the custom stand with scannable QR code and trust ribbons.

---

## 4. Physical Stand Fabrication & Printing Specifications

YOUPI PG generates production-ready, resolution-independent vector SVGs and print-calibrated HTML documents.

### Recommended Dimensions & Acrylic Formats
| Format Name | Physical Dimensions | Aspect Ratio | Target Acrylic Holder |
| :--- | :--- | :--- | :--- |
| **Table Tent** | 4" x 6" (100mm x 150mm) | 2:3 Portrait | Standard Dual-Sided Acrylic T-Stand |
| **Countertop Stand** | 5" x 7" (127mm x 178mm) | 5:7 Portrait | Angled L-Stand / Counter Display |
| **Desk Badge** | 3.5" x 3.5" (90mm x 90mm) | 1:1 Square | Self-Adhesive Vinyl Till Sticker |

### Production Substrate Guidelines
- **Paper**: 300+ GSM Glossy Photo Paper or Satin Matte Cardstock.
- **Sticker / Decal**: Waterproof, scratch-resistant PVC Vinyl Sheet with UV lamination.
- **Acrylic Holder**: 2.0mm to 3.0mm clear cast acrylic with polished edges.

### 1-Click Print & Export
- **Print Directly**: Click **🖨️ Print Stand (Ctrl+P)** in the Stand Studio or visit `http://localhost:7000/stand/print`. The stylesheet automatically formats `@page` margins for seamless paper alignment.
- **Download Vector SVG**: Click **📥 Download SVG** to obtain the raw SVG file for laser cutting, vinyl plotter printing, or professional print press production.

---

## 5. Smart Digital Counter Stand (`/stand`)

For stores utilizing a tablet, spare Android smartphone, iPad, or customer-facing POS monitor on the billing till:

1. **Access URL**: Open `http://localhost:7000/stand` on the counter device.
2. **Two Operating Modes**:
   - **Dynamic Mode (Cashier Assisted)**:
     - Cashier types the bill amount (e.g. ₹3,500) and clicks **Display Dynamic QR**.
     - Stand screen displays a dynamic vector QR code prefilled with `am=3500.00`.
     - Customer points camera at screen; PhonePe opens with ₹3,500 prefilled.
   - **Static Mode (Customer Driven)**:
     - Stand screen displays an open-amount QR (`mode=02`).
     - Customer scans with camera and enters any custom bill amount.
3. **Built-in Digital Soundbox**:
   - Uses browser Web Speech API speech synthesis.
   - The instant an observation matches, the stand announces aloud:
     *"Payment of 3,500 rupees received on PhonePe!"*
   - Eliminates the need to rent physical hardware soundboxes or pay recurring SIM card subscriptions.

---

## 6. Pairing the Customer's PhonePe Phone (Android Observer)

To ensure incoming PhonePe payments are recorded and confirmed automatically:

1. Download the certified APK: `apps/android-observer-app/youpi-sms-gateway.apk`.
2. Install it on the merchant's Android phone (the device with the PhonePe registered SIM).
3. Open the app and grant:
   - **Notification Listener Permission** (allows capturing PhonePe app push alerts).
   - **SMS Receive Permission** (allows capturing bank credit SMS alerts).
4. In Merchant Admin &rarr; **Developer Hub &rarr; Android SMS Hub**:
   - Click **Pair New Android Device** to display the ephemeral pairing QR code.
5. In the Android Observer app, tap **Scan Pairing QR** and point at the screen.
6. The phone is now securely bound via HMAC-SHA256 device credentials. All payments received on PhonePe (> ₹2,000) are automatically verified within seconds.

---

## 7. Customer Operating Best Practices

- **Customer Guidance**: Always instruct customers to **open PhonePe / GPay and use the scanner camera directly**. Advise them not to take a photo or screenshot to upload from gallery.
- **Network Resilience**: The dual observation mesh captures both the PhonePe app push notification and bank cellular SMS, guaranteeing payment detection even if the merchant's internet experiences brief latency.
- **Zero Intermediary Fees**: Every transaction settles directly into the customer's linked bank account at 0% MDR with zero aggregator holdbacks.
