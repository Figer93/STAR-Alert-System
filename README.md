# ST&R Alert Dashboard

Real-time alert dashboard for ST&R Limited — FastAPI backend + React frontend + Supabase (PostgreSQL) + Railway deployment.

## Stack
- **Backend**: FastAPI, SQLAlchemy async, Alembic, asyncpg
- **Frontend**: React 19, Vite, Tailwind CSS v4, Recharts
- **Database**: Supabase (PostgreSQL) in production, SQLite for local dev
- **Hosting**: Railway (backend + frontend as separate services)
- **Notifications**: Telegram bot, SMTP email
- **Sources**: pfSense (UDP syslog), NinjaRMM (webhook), PingPlotter (webhook)

## Quick Start (local)

```bash
# Backend
pip install -r requirements.txt
python -m backend.seed
python -m uvicorn backend.main:app --reload

# Frontend
cd frontend && npm install && npm run dev
```

Open `http://localhost:5173`

## Environment Variables

Copy `.env.example` to `.env` and fill in your values.

For Railway/Supabase deployment, set `DATABASE_URL` to your Supabase connection string:
```
DATABASE_URL=postgresql+asyncpg://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
```
