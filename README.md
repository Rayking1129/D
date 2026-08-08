# Navos 创意素材 Hub

Navos 创意素材 Hub is a lightweight creative asset management system for product-linked AI content review, version tracking, demand intake, and Feishu Bitable-backed operations.

## Features

- Email login with 7-day signed sessions
- Product library with product detail galleries
- Creative asset review workflow
- Revision comments, tags, published state, and version display
- Demand request intake form
- Feishu Bitable as the backend database
- CDN-based media URLs for sharing across devices

## Local Run

```bash
npm start
```

Open:

```text
http://localhost:8787
```

## Environment Variables

Copy `.env.example` to `.env.local` for local development and set the same variables in the deployment platform:

```text
FEISHU_APP_ID
FEISHU_APP_SECRET
FEISHU_WIKI_TOKEN
FEISHU_PRODUCT_TABLE_ID
FEISHU_ASSET_TABLE_ID
FEISHU_USER_TABLE_ID
FEISHU_REQUEST_TABLE_ID
```

Do not commit `.env.local`.

## Deploy

This project can run on Node-capable platforms such as Vercel, Render, or Railway.

For Vercel, `vercel.json` routes all requests to `server.js`. Configure the environment variables in Vercel before production deployment.

## Documentation

- [System overview](docs/SYSTEM_OVERVIEW.md)
- [Handoff notes](docs/HANDOFF.md)
