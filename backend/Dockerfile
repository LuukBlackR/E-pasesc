# =============================================================================
# Etapa 1: instalação de dependências (com ferramentas de build)
# =============================================================================
FROM node:22-alpine AS deps
WORKDIR /app

# python3/make/g++ são necessários para compilar o módulo nativo do argon2
# (node-gyp) — o Alpine não traz essas ferramentas por padrão.
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# =============================================================================
# Etapa 2: imagem final (enxuta, sem ferramentas de build)
# =============================================================================
FROM node:22-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# O Prisma precisa do OpenSSL disponível no sistema para seus binários
# (schema engine / query engine) funcionarem corretamente no Alpine.
RUN apk add --no-cache openssl

# Reaproveita os node_modules já compilados na etapa anterior
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./

# Copia o schema do Prisma e gera o client
COPY prisma ./prisma
RUN npx prisma generate

# Copia o código-fonte da aplicação
COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Usuário não-root
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
