# Weldon Manufacturing Ltd — Manufacturing Management Demo

A public, self-contained demonstration of a manufacturing management interface. This edition preserves the original application's UI patterns, forms, and workflow logic while limiting the scope to three areas:

- Master Data
- Inventory Management
- Manufacturing Planning

Every record in this repository is synthetic. Product families and formulations are fictional, ingredient names use chemical-element names, and all people, suppliers, orders, lots, batches, costs, and quantities are demonstration data.

## What is included

### Master Data

- Raw-component sub-tabs and create/edit/archive/restore forms
- Finished-product groupings and create/edit/archive/delete forms
- Formulation and BOM variants
- Category and managed-name maintenance

### Inventory Management

- Overview
- PO Summary
- History
- Component In and Component Out
- Product In and Product Out
- Editable lots, ledger entries, batches, dispatches, and quarantine details

### Manufacturing Planning

- Alerting
- Safety Stock
- Long-term Budgeting
- Mid-term Scheduling
- Exploratory Costing
- Locally saved planning reports

## Local demo architecture

The application does not require an API, account, database, environment variables, or cloud service. A versioned demo database is seeded into the browser's `localStorage` on first use. Existing create, edit, archive, restore, and delete actions update that local database, so the UI remains interactive between page reloads.

The header refresh control reloads the saved browser snapshot. Use the in-app **Reset demo data** action to restore the original synthetic fixtures.

Browser storage is isolated per browser profile and origin. Clearing site data also resets the demo.

## Run locally

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

For a production build:

```bash
npm run check
npm run build
npm run preview
```

## Deploy to Google Cloud Run

The included container builds the Vite application and serves only the compiled static demo on Cloud Run's `PORT`. It has no registration endpoint, authentication service, database connection, or server-side write API.

Deploy it as a new service so an existing application is not replaced:

```bash
gcloud run deploy weldon-linkedin \
  --source . \
  --project YOUR_PROJECT_ID \
  --region YOUR_REGION \
  --allow-unauthenticated \
  --port 8080 \
  --memory 256Mi \
  --max-instances 2
```

For least privilege, attach a dedicated runtime service account with no access to production data or secrets.

## Repository structure

```text
components/    Preserved views, forms, and navigation for the three demo sections
data/          Synthetic seed fixtures
masterdata/    Product-family and raw-component registries
services/      Local business rules and browser-storage adapter
storage/       Stock-balance derivation helpers
utils/         Shared ID and label utilities
```

## Data and usage notice

This project is a portfolio demonstration, not a production manufacturing system. Its formulations are invented and must not be used as technical, safety, quality, or production instructions. Third-party names, credentials, production datasets, private endpoints, and deployment configuration are not included.

## License

[MIT](LICENSE)
