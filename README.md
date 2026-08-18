# TechSerenia POS

Mobile-first offline Point of Sale.

**Stack:** Svelte + Vite + Capacitor + Dexie.js (IndexedDB)

One codebase for web (Render) and Android APK (GitHub Actions).

## Phase 1 Features

### Billing Mode
- Photo POS (image grid, tap to add)
- Text POS (products appear only when searched)
- Held Bills
- Transactions
- Calculator
- Cart with GST, discount, payment modes, Hold / Pay

### Admin Mode
- Product CRUD (name, barcode, category, price, cost, stock, GST%, image)

All data is 100% local IndexedDB via Dexie. Fully offline.

Logo (TechSerenia) is shown in the top bar of both modes.

## Develop

```bash
npm install
npm run dev
```

## Web (Render)

```bash
npm run build
```

Deploy `dist/` as Static Site on Render.

## Android APK

Push to GitHub. Run the "Build Android APK" workflow (Actions tab). Download the APK artifact.

No local Android Studio needed.
