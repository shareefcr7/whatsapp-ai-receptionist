# WhatsApp AI Receptionist

Backend API, admin dashboard and PostgreSQL schema for a WhatsApp receptionist. Staff can sign in and manage business information and services. **WhatsApp is not connected yet.** OpenAI replies and Google Calendar OAuth are built; bookings do not use the calendar yet.

```bash
nvm use                       # Node 24, from .nvmrc
npm install
cp backend/.env.example backend/.env
npm run dev                   # API on :4000, dashboard on http://localhost:5173
```

The dashboard works without a database and says so clearly. To add one and create the first admin login, see [docs/setup-guide.md](docs/setup-guide.md).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Backend and dashboard with reload |
| `npm run typecheck` | Strict TypeScript check of both |
| `npm run build` | Production builds |
| `npm test` | Backend tests (set `TEST_DATABASE_URL` to include PostgreSQL tests) |
| `npm run migrate` | Apply pending database migrations |
| `npm run staff:create` | Create a staff login |
| `npm run staff:reset-password` | Change a staff password |
| `npm start` | Run the built backend |

**Security:** the dashboard and its API require a staff login. Serve them only over HTTPS, as described in the setup guide.

Docs: [architecture](docs/architecture.md) · [development plan](docs/development-plan.md) · [API design](docs/api-design.md) · [cost estimation](docs/cost-estimation.md) · [setup and deployment](docs/setup-guide.md) · [WhatsApp setup](docs/whatsapp-setup.md)
