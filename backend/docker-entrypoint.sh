#!/bin/sh
set -e

echo "[entrypoint] Sincronizando schema do banco de dados..."
npx prisma db push --skip-generate --accept-data-loss

echo "[entrypoint] Iniciando API..."
exec node src/server.js
